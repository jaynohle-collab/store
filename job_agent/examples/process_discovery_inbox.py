"""Process pending ChatGPT discovery inbox batches through the existing pipeline.

ChatGPT submits raw jobs via submit_discovery_batch.
This runner claims a batch, then reuses run_daily_job_run for:
normalize → SAME_POSTING/REPOST/NEW_JOB → profile-v1 scoring → MCP persist.

It does not score, classify, or persist jobs itself.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Callable

from dotenv import load_dotenv

from job_agent.discovery.inbox import DiscoveryInboxStore
from job_agent.discovery.openai_discovery import validate_discovery_payload
from job_agent.examples.daily_job_run import run_daily_job_run
from job_agent.integrations.lifecycle_store import RemoteLifecycleStore
from job_agent.integrations.persistence import get_persistence_mode

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]

_SECRET_ENV_KEYS = {
    "OPENAI_API_KEY",
    "AUTH0_CLIENT_SECRET",
    "AUTH0_CLIENT_ID",
}

DEFAULT_LIMIT = 10


def load_repo_dotenv() -> None:
    """Load repository-root ``.env``; real process env vars always win."""
    load_dotenv(_REPO_ROOT / ".env", override=False)


def _redact_message(message: str) -> str:
    redacted = message
    for key in _SECRET_ENV_KEYS:
        value = os.environ.get(key)
        if value and value in redacted:
            redacted = redacted.replace(value, "[REDACTED]")
    return redacted


def _jobs_payload_from_batch(batch: dict[str, Any]) -> dict[str, Any]:
    payload = batch.get("payload")
    if isinstance(payload, str):
        payload = json.loads(payload)
    if not isinstance(payload, dict):
        raise ValueError("Inbox batch payload must be a JSON object")
    return payload


def _report_failed(report: dict[str, Any]) -> str | None:
    errors = report.get("errors") or []
    if errors:
        return "; ".join(str(item) for item in errors)
    return None


def process_discovery_inbox(
    *,
    inbox_store: DiscoveryInboxStore | None = None,
    run_daily: Callable[..., dict[str, object]] | None = None,
    persistence_mode: str | None = None,
    lifecycle_store: Any | None = None,
    memory_store: Any | None = None,
    limit: int = DEFAULT_LIMIT,
    batch_id: str | None = None,
) -> dict[str, object]:
    """Claim and process pending inbox batches through the existing daily runner."""
    load_repo_dotenv()
    store = inbox_store
    if store is None:
        if lifecycle_store is None:
            lifecycle_store = RemoteLifecycleStore()
        store = lifecycle_store

    daily_runner = run_daily or run_daily_job_run
    mode = persistence_mode
    if mode is None:
        mode = get_persistence_mode()
        if str(mode).strip().lower() in {"neon", "mcp", "remote"}:
            mode = "remote"

    processed = 0
    completed = 0
    failed = 0
    reports: list[dict[str, object]] = []
    remaining = max(0, limit)

    while remaining > 0:
        claimed = asyncio.run(store.claim_discovery_batch(batch_id))
        if claimed is None:
            break
        processed += 1
        remaining -= 1
        batch_key = str(claimed["id"])
        logger.info("Claimed discovery batch %s (%s jobs)", batch_key, claimed.get("job_count"))
        try:
            raw_payload = _jobs_payload_from_batch(claimed)
            jobs_payload = validate_discovery_payload(raw_payload)
            report = daily_runner(
                jobs_payload=jobs_payload,
                memory_store=memory_store,
                persistence_mode=mode,
                lifecycle_store=lifecycle_store,
            )
            fail_reason = _report_failed(report)
            if fail_reason:
                raise RuntimeError(fail_reason)
            completed_row = asyncio.run(store.complete_discovery_batch(batch_key))
            if completed_row is None:
                raise RuntimeError("complete_discovery_batch did not update a processing batch")
            completed += 1
            reports.append(dict(report))
            logger.info(
                "Completed discovery batch %s (new=%s reposts=%s duplicates=%s saved=%s)",
                batch_key,
                report.get("new_jobs"),
                report.get("reposts"),
                report.get("duplicates"),
                report.get("saved"),
            )
        except Exception as exc:
            message = _redact_message(str(exc) or type(exc).__name__)
            logger.error("Discovery batch %s failed: %s", batch_key, message)
            asyncio.run(store.fail_discovery_batch(batch_key, message[:4000]))
            failed += 1
        if batch_id:
            break

    return {
        "claimed": processed,
        "completed": completed,
        "failed": failed,
        "reports": reports,
    }


def print_inbox_summary(summary: dict[str, object]) -> None:
    print("Discovery Inbox Processing Report")
    print()
    print(f"Claimed: {summary.get('claimed', 0)}")
    print(f"Completed: {summary.get('completed', 0)}")
    print(f"Failed: {summary.get('failed', 0)}")
    reports = summary.get("reports") or []
    if not reports:
        return
    print()
    for index, report in enumerate(reports, start=1):
        print(
            f"Batch {index}: "
            f"received={report.get('total_jobs_received', 0)} "
            f"new={report.get('new_jobs', 0)} "
            f"reposts={report.get('reposts', 0)} "
            f"duplicates={report.get('duplicates', 0)} "
            f"saved={report.get('saved', 0)}"
        )


def main(argv: list[str] | None = None) -> int:
    load_repo_dotenv()
    parser = argparse.ArgumentParser(
        description="Process pending ChatGPT discovery inbox batches through the Python job agent.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"Maximum pending batches to process (default {DEFAULT_LIMIT})",
    )
    parser.add_argument(
        "--batch-id",
        dest="batch_id",
        default=None,
        help="Process a specific inbox batch id",
    )
    args = parser.parse_args(argv)
    if args.limit < 0:
        logger.error("--limit must be >= 0")
        return 1

    try:
        summary = process_discovery_inbox(
            persistence_mode=os.environ.get("JOB_PERSISTENCE_MODE") or "remote",
            limit=args.limit if args.batch_id is None else 1,
            batch_id=args.batch_id,
        )
    except Exception as exc:
        logger.error("Inbox processing aborted: %s", _redact_message(str(exc)))
        return 1

    print_inbox_summary(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
