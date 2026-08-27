"""CLI entrypoint for Milestone 5 automatic discovery producer.

Usage:
  python -m job_agent.examples.automatic_discovery_run --max-companies 10
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from job_agent.auto_discovery.pipeline import AutomaticDiscoveryPipeline
from job_agent.integrations.lifecycle_store import RemoteLifecycleStore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]


def load_repo_dotenv() -> None:
    load_dotenv(_REPO_ROOT / ".env", override=False)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Automatic ATS discovery producer")
    parser.add_argument("--max-companies", type=int, default=None)
    parser.add_argument(
        "--process-inbox",
        action="store_true",
        help="After producer, run process_discovery_inbox",
    )
    parser.add_argument(
        "--skip-inbox-handoff",
        action="store_true",
        help="Do not process inbox in this process (workflow may do it separately)",
    )
    return parser


async def run_async(args: argparse.Namespace) -> int:
    store = RemoteLifecycleStore()
    pipeline = AutomaticDiscoveryPipeline(
        store,
        max_companies=args.max_companies,
        worker_identity=os.environ.get(
            "AUTO_DISCOVERY_WORKER_IDENTITY", "automatic-discovery"
        ),
    )
    metrics = await pipeline.run()
    logger.info(
        "automatic discovery finished: claimed=%s completed=%s failed=%s "
        "listed=%s evaluated=%s qualified=%s batches=%s",
        metrics.companies_claimed,
        metrics.companies_completed,
        metrics.companies_failed,
        metrics.candidates_listed,
        metrics.candidates_evaluated,
        metrics.candidates_qualified,
        metrics.batches_submitted,
    )

    if args.skip_inbox_handoff:
        should_process = False
    elif args.process_inbox:
        should_process = True
    else:
        should_process = os.environ.get(
            "AUTO_DISCOVERY_PROCESS_INBOX", "false"
        ).lower() in ("1", "true", "yes")

    if should_process:
        from job_agent.examples import process_discovery_inbox as inbox_mod

        code = inbox_mod.main(
            [
                "--limit",
                os.environ.get("DISCOVERY_INBOX_BATCH_LIMIT", "5"),
                "--recover-stale",
                "--fail-on-batch-failure",
            ]
        )
        return int(code or 0)

    if metrics.errors and metrics.companies_completed == 0 and metrics.batches_submitted == 0:
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    load_repo_dotenv()
    args = build_parser().parse_args(argv)
    return asyncio.run(run_async(args))


if __name__ == "__main__":
    sys.exit(main())
