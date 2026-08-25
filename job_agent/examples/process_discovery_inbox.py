"""Process pending ChatGPT discovery inbox batches through the existing pipeline.

ChatGPT submits raw jobs via submit_discovery_batch.
This runner claims a batch, then reuses run_daily_job_run for:
normalize → SAME_POSTING/REPOST/NEW_JOB → profile-v1 scoring → MCP persist.

It does not score, classify, or persist jobs itself.
Scheduled GitHub Actions (process-discovery-inbox) invokes this same entrypoint.
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
from job_agent.lifecycle.atomic_apply import (
    sanitize_apply_discovery_batch_job_persistence_payload,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]

_SECRET_ENV_KEYS = {
    "OPENAI_API_KEY",
    "AUTH0_CLIENT_SECRET",
    "AUTH0_CLIENT_ID",
    "DATABASE_URL",
    "AUTH0_SECRET",
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
    for token in ("Bearer ", "postgresql://", "postgres://"):
        if token.lower() in redacted.lower():
            # Broad scrub for accidental connection strings / bearer tokens.
            redacted = "[REDACTED]"
            break
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


def _effects_from_report(report: dict[str, Any]) -> list[dict[str, Any]]:
    effects: list[dict[str, Any]] = []
    for index, raw in enumerate(report.get("job_effects") or []):
        if not isinstance(raw, dict):
            continue
        action = str(raw.get("processing_action") or "skipped")
        effect = {
            "input_index": int(raw.get("input_index", index)),
            "client_candidate_id": raw.get("client_candidate_id"),
            "company": raw.get("company"),
            "title": raw.get("title"),
            "source": raw.get("source"),
            "external_job_id": raw.get("external_job_id"),
            "normalized_url": raw.get("normalized_url"),
            "canonical_job_id": raw.get("canonical_job_id"),
            "posting_id": raw.get("posting_id"),
            "processing_action": action,
            "created_canonical": bool(raw.get("created_canonical")),
            "created_posting": bool(raw.get("created_posting")),
            "before_state": raw.get("before_state"),
            "after_state": raw.get("after_state"),
            "after_fingerprint": raw.get("after_fingerprint"),
            "evaluation_posting_id": raw.get("evaluation_posting_id"),
            "metadata": {
                "disposition": action,
            },
        }
        for key in (
            "create_canonical",
            "touch_canonical_id",
            "create_posting",
            "update_posting",
            "evaluation",
        ):
            if raw.get(key) is not None:
                effect[key] = raw[key]
        effects.append(effect)
    return effects


def process_discovery_inbox(
    *,
    inbox_store: DiscoveryInboxStore | None = None,
    run_daily: Callable[..., dict[str, object]] | None = None,
    persistence_mode: str | None = None,
    lifecycle_store: Any | None = None,
    memory_store: Any | None = None,
    limit: int = DEFAULT_LIMIT,
    batch_id: str | None = None,
    recover_stale: bool = False,
    fail_on_batch_failure: bool | None = None,
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

    if (
        lifecycle_store is not None
        and store is not lifecycle_store
        and hasattr(store, "lifecycle_backend")
        and getattr(store, "lifecycle_backend", None) is None
    ):
        store.lifecycle_backend = lifecycle_store

    if recover_stale and hasattr(store, "recover_stale_discovery_batch_claims"):
        try:
            recovery = asyncio.run(store.recover_stale_discovery_batch_claims(limit=limit))
            logger.info(
                "Stale claim recovery: requeued=%s failed=%s after_minutes=%s",
                len(recovery.get("requeued") or []),
                len(recovery.get("failed") or []),
                recovery.get("stale_after_minutes"),
            )
        except Exception as exc:
            logger.warning(
                "Stale claim recovery skipped: %s",
                _redact_message(str(exc) or type(exc).__name__),
            )

    processed = 0
    completed = 0
    failed = 0
    reports: list[dict[str, object]] = []
    remaining = max(0, limit)

    while remaining > 0:
        claimed = asyncio.run(
            store.claim_discovery_batch(
                batch_id,
                worker_identity=os.environ.get(
                    "DISCOVERY_INBOX_WORKER_IDENTITY", "github-actions"
                ),
            )
        )
        if claimed is None:
            break
        processed += 1
        remaining -= 1
        batch_key = str(claimed["id"])
        attempt_id = str(claimed.get("attempt_id") or "")
        if not attempt_id:
            raise RuntimeError("claim_discovery_batch did not return attempt_id")
        logger.info(
            "Claimed discovery batch %s attempt %s (%s jobs)",
            batch_key,
            attempt_id,
            claimed.get("job_count"),
        )
        try:
            raw_payload = _jobs_payload_from_batch(claimed)
            jobs_payload = validate_discovery_payload(raw_payload)
            report = daily_runner(
                jobs_payload=jobs_payload,
                memory_store=memory_store,
                persistence_mode=mode,
                lifecycle_store=lifecycle_store,
                **(
                    {"defer_lifecycle_persist": True}
                    if str(mode).strip().lower() == "remote"
                    else {}
                ),
            )
            fail_reason = _report_failed(report)
            if fail_reason:
                raise RuntimeError(fail_reason)

            effects = _effects_from_report(dict(report))
            if hasattr(store, "apply_discovery_batch_job_persistence"):
                for effect in effects or [
                    {
                        "input_index": 0,
                        "processing_action": "skipped",
                    }
                ]:
                    apply_payload: dict[str, object] = {
                        "batch_id": batch_key,
                        "attempt_id": attempt_id,
                        "input_index": int(effect.get("input_index") or 0),
                        "idempotency_key": f"{batch_key}:{int(effect.get('input_index') or 0)}",
                        "processing_action": effect.get("processing_action") or "skipped",
                        "company": effect.get("company"),
                        "title": effect.get("title"),
                        "source": effect.get("source"),
                        "external_job_id": effect.get("external_job_id"),
                        "normalized_url": effect.get("normalized_url"),
                        "before_state": effect.get("before_state"),
                        "metadata": {
                            **(effect.get("metadata") or {}),
                            "canonical_job_id": effect.get("canonical_job_id"),
                            "posting_id": effect.get("posting_id"),
                            "legacy_daily_runner": True,
                        },
                    }
                    # Production atomic path supplies create_*/update_* payloads.
                    # Legacy daily_runner persistence is rejected in remote mode so
                    # mutations cannot exist without transactional provenance.
                    if (
                        str(mode).strip().lower() == "remote"
                        and effect.get("processing_action")
                        in {"created", "updated", "reposted"}
                        and not effect.get("create_canonical")
                        and not effect.get("create_posting")
                        and not effect.get("update_posting")
                    ):
                        raise RuntimeError(
                            "atomic_provenance_required: remote worker must persist "
                            "via apply_discovery_batch_job_persistence in the same "
                            "transaction as canonical/posting/evaluation writes"
                        )
                    if effect.get("create_canonical"):
                        apply_payload["create_canonical"] = effect["create_canonical"]
                    if effect.get("touch_canonical_id"):
                        apply_payload["touch_canonical_id"] = effect["touch_canonical_id"]
                    if effect.get("create_posting"):
                        apply_payload["create_posting"] = effect["create_posting"]
                    if effect.get("update_posting"):
                        apply_payload["update_posting"] = effect["update_posting"]
                    if effect.get("evaluation"):
                        apply_payload["evaluation"] = effect["evaluation"]
                    apply_payload = sanitize_apply_discovery_batch_job_persistence_payload(
                        apply_payload
                    )
                    asyncio.run(store.apply_discovery_batch_job_persistence(apply_payload))

            completed_row = asyncio.run(
                store.complete_discovery_batch(batch_key, attempt_id)
            )
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
            asyncio.run(store.fail_discovery_batch(batch_key, message[:4000], attempt_id))
            failed += 1
        if batch_id:
            break

    summary: dict[str, object] = {
        "claimed": processed,
        "completed": completed,
        "failed": failed,
        "reports": reports,
    }

    if fail_on_batch_failure is None:
        fail_on_batch_failure = (
            os.environ.get("DISCOVERY_INBOX_FAIL_WORKFLOW_ON_BATCH_FAILURE", "true")
            .strip()
            .lower()
            == "true"
        )
    summary["fail_on_batch_failure"] = fail_on_batch_failure
    return summary


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
    parser.add_argument(
        "--recover-stale",
        action="store_true",
        help="Apply bounded stale-claim recovery before claiming pending batches",
    )
    parser.add_argument(
        "--fail-on-batch-failure",
        action="store_true",
        help="Exit non-zero when any claimed batch fails (for scheduled workers)",
    )
    parser.add_argument(
        "--no-fail-on-batch-failure",
        action="store_true",
        help="Always exit 0 when the processor itself runs (batch failures only counted)",
    )
    args = parser.parse_args(argv)
    if args.limit < 0:
        logger.error("--limit must be >= 0")
        return 1

    fail_on_batch_failure: bool | None
    if args.no_fail_on_batch_failure:
        fail_on_batch_failure = False
    elif args.fail_on_batch_failure:
        fail_on_batch_failure = True
    else:
        fail_on_batch_failure = None

    try:
        summary = process_discovery_inbox(
            persistence_mode=os.environ.get("JOB_PERSISTENCE_MODE") or "remote",
            limit=args.limit if args.batch_id is None else 1,
            batch_id=args.batch_id,
            recover_stale=args.recover_stale,
            fail_on_batch_failure=fail_on_batch_failure,
        )
    except Exception as exc:
        logger.error("Inbox processing aborted: %s", _redact_message(str(exc)))
        return 1

    print_inbox_summary(summary)
    if summary.get("fail_on_batch_failure") and int(summary.get("failed") or 0) > 0:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
