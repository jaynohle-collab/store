"""Expand the automatic discovery company registry.

Registers seed-catalog and history-derived company candidates, then verifies a
bounded number against their official ATS endpoints. Verified candidates are
promoted into the scan registry by Remote MCP.

Usage:
  python -m job_agent.examples.expand_discovery_companies --max-verifications 5
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from job_agent.auto_discovery.expansion import CompanyExpansionWorker
from job_agent.auto_discovery.limits import DiscoveryLimits
from job_agent.integrations.lifecycle_store import RemoteLifecycleStore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[2]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Automatic discovery company expansion")
    parser.add_argument("--max-verifications", type=int, default=None)
    parser.add_argument("--skip-seeds", action="store_true")
    parser.add_argument("--skip-history", action="store_true")
    return parser


async def run_async(args: argparse.Namespace) -> int:
    limits = DiscoveryLimits.from_env()
    if args.max_verifications is not None:
        limits = dataclasses.replace(
            limits, max_verifications_per_run=max(0, min(20, args.max_verifications))
        )
    worker = CompanyExpansionWorker(
        RemoteLifecycleStore(),
        limits=limits,
        worker_identity=os.environ.get("AUTO_DISCOVERY_WORKER_IDENTITY", "automatic-discovery")
        + "-expansion",
    )
    summary = await worker.run(
        include_seeds=not args.skip_seeds, include_history=not args.skip_history
    )
    logger.info("company expansion summary: %s", json.dumps(summary.as_dict(), sort_keys=True))
    return 0


def main(argv: list[str] | None = None) -> int:
    load_dotenv(_REPO_ROOT / ".env", override=False)
    return asyncio.run(run_async(build_parser().parse_args(argv)))


if __name__ == "__main__":
    sys.exit(main())
