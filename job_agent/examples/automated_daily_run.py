"""Unattended daily discovery → existing Python Job Agent pipeline.

Discovery finds raw jobs only. Normalization, lifecycle classification,
profile-v1 scoring, evaluation persistence, and MCP writes stay in the
existing ``run_daily_job_run`` / workflow path.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Callable

from job_agent.discovery import (
    DiscoveryError,
    JobDiscoveryClient,
    OpenAIDiscoveryClient,
    OpenAIDiscoveryConfig,
    validate_discovery_payload,
)
from job_agent.examples.daily_job_run import print_daily_report, run_daily_job_run
from job_agent.ingestion.gpt_loader import GPTJobIngestionError, GPTJobLoader

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Keep secrets out of logs — never print env values for these keys.
_SECRET_ENV_KEYS = {
    "OPENAI_API_KEY",
    "AUTH0_CLIENT_SECRET",
    "AUTH0_CLIENT_ID",
}


def _redact_message(message: str) -> str:
    redacted = message
    for key in _SECRET_ENV_KEYS:
        value = os.environ.get(key)
        if value and value in redacted:
            redacted = redacted.replace(value, "[REDACTED]")
    return redacted


def write_discovery_payload(payload: dict[str, Any], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def run_automated_daily_discovery(
    *,
    discovery_client: JobDiscoveryClient | None = None,
    run_daily: Callable[..., dict[str, object]] | None = None,
    persistence_mode: str | None = None,
    lifecycle_store: Any | None = None,
    memory_store: Any | None = None,
    keep_discovery_file: bool = False,
    discovery_output_dir: Path | None = None,
) -> dict[str, object]:
    """Discover raw jobs, then invoke the existing daily runner.

    Failures in discovery / schema validation abort before any persistence.
    """
    daily_runner = run_daily or run_daily_job_run

    if discovery_client is None:
        config = OpenAIDiscoveryConfig.from_env()
        discovery_client = OpenAIDiscoveryClient(config)
        max_jobs = config.max_jobs
    else:
        max_jobs_raw = (os.environ.get("DISCOVERY_MAX_JOBS") or "100").strip()
        try:
            max_jobs = int(max_jobs_raw)
        except ValueError as exc:
            raise DiscoveryError("DISCOVERY_MAX_JOBS must be an integer") from exc

    logger.info("Starting OpenAI job discovery (max_jobs=%s)", max_jobs)
    try:
        payload = discovery_client.discover_jobs()
        payload = validate_discovery_payload(payload, max_jobs=max_jobs)
        # Ensure the existing ingestion layer accepts the payload before persist.
        GPTJobLoader(payload).load_jobs()
    except Exception as exc:
        logger.error("Discovery failed before persistence: %s", _redact_message(str(exc)))
        raise

    job_count = len(payload.get("jobs") or [])
    logger.info("Discovery received %s raw jobs", job_count)

    temp_dir = discovery_output_dir or Path(tempfile.gettempdir())
    temp_path = temp_dir / f"jay_job_discovery_{os.getpid()}.json"
    write_discovery_payload(payload, temp_path)
    logger.info("Wrote temporary discovery file: %s", temp_path)

    try:
        report = daily_runner(
            temp_path,
            memory_store=memory_store,
            persistence_mode=persistence_mode,
            lifecycle_store=lifecycle_store,
            jobs_payload=payload,
        )
    finally:
        if not keep_discovery_file:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not delete temporary discovery file: %s", temp_path)

    summary = {
        "discovery_received": job_count,
        "duplicates": report.get("duplicates", 0),
        "reposts": report.get("reposts", 0),
        "new_jobs": report.get("new_jobs", 0),
        "saved": report.get("saved", 0),
        "total_jobs_received": report.get("total_jobs_received", job_count),
        "top_matches": report.get("top_matches", []),
        "errors": report.get("errors", []),
    }
    return summary


def print_automated_summary(summary: dict[str, object]) -> None:
    print("Automated Daily Discovery Report")
    print()
    print(f"Discovery received: {summary.get('discovery_received', 0)}")
    print(f"Duplicates: {summary.get('duplicates', 0)}")
    print(f"Reposts: {summary.get('reposts', 0)}")
    print(f"New jobs: {summary.get('new_jobs', 0)}")
    print(f"Saved: {summary.get('saved', 0)}")
    if summary.get("errors"):
        print()
        print("Errors:")
        for err in summary["errors"]:
            print(f"- {_redact_message(str(err))}")


def main() -> int:
    try:
        summary = run_automated_daily_discovery(
            persistence_mode=os.environ.get("JOB_PERSISTENCE_MODE") or "remote",
        )
    except (DiscoveryError, GPTJobIngestionError, OSError, ValueError) as exc:
        logger.error("Automated daily discovery aborted: %s", _redact_message(str(exc)))
        return 1

    print_automated_summary(summary)
    if logger.isEnabledFor(logging.DEBUG):
        print_daily_report(
            {
                "total_jobs_received": summary.get("total_jobs_received", 0),
                "duplicates": summary.get("duplicates", 0),
                "reposts": summary.get("reposts", 0),
                "new_jobs": summary.get("new_jobs", 0),
                "saved": summary.get("saved", 0),
                "top_matches": summary.get("top_matches", []),
            }
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
