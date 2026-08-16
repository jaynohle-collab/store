from __future__ import annotations
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from job_agent.ingestion.gpt_loader import GPTJobLoader, GPTJobIngestionError
from job_agent.integrations.lifecycle_store import RemoteLifecycleStore
from job_agent.integrations.persistence import get_persistence_mode
from job_agent.integrations.remote_mcp_client import RemoteMcpMemoryAdapter
from job_agent.lifecycle import CanonicalJobResolver
from job_agent.memory.client import MemoryStore
from job_agent.models.types import JobInput, JobSearchProfile
from job_agent.ranking.scoring import SimpleScoreCalculator
from job_agent.workflow.engine import JobSearchWorkflow
from job_agent.workflow.example_gpt_input import SimpleJobNormalizer

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class StaticJobProvider:
    jobs: list[JobInput]

    def search(self, profile: JobSearchProfile) -> Iterable[JobInput]:
        return self.jobs


class MockToolClient:
    def __init__(self):
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        arguments = arguments or {}
        self.calls.append((name, arguments))
        if name == "check_duplicate":
            return {"duplicate": False, "existing_job_id": None}
        if name == "save_job_memory":
            return {
                "id": len([call for call in self.calls if call[0] == "save_job_memory"]),
                "company": arguments.get("company_name"),
                "title": arguments.get("title"),
                "url": arguments.get("url"),
                "status": arguments.get("status", "new"),
            }
        if name == "get_job_history":
            return []
        return {}


def load_gpt_jobs_from_file(path: Path) -> list[JobInput]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    loader = GPTJobLoader(payload)
    return loader.load_jobs()


def run_daily_job_run(
    job_file: Path,
    memory_store: MemoryStore | None = None,
    *,
    persistence_mode: str | None = None,
    lifecycle_store: Any | None = None,
) -> dict[str, object]:
    """Run the daily GPT job workflow.

    Parameters
    ----------
    memory_store:
        When provided, forces the local/legacy memory path and never constructs
        a remote MCP client — regardless of ``JOB_PERSISTENCE_MODE``.
    persistence_mode:
        Optional override for tests (``\"local\"`` / ``\"remote\"``). Defaults to
        ``get_persistence_mode()`` from the environment.
    lifecycle_store:
        Optional injected lifecycle store for remote mode (tests). When omitted
        in remote mode, a real ``RemoteLifecycleStore`` is constructed.
    """
    try:
        job_inputs = load_gpt_jobs_from_file(job_file)
    except (json.JSONDecodeError, GPTJobIngestionError) as exc:
        logger.error("GPT job load failed: %s", exc)
        return {
            "total_jobs_received": 0,
            "duplicates": 0,
            "new_jobs": 0,
            "saved": 0,
            "top_matches": [],
            "errors": [str(exc)],
        }

    logger.info("Loaded %s GPT job records", len(job_inputs))

    mode = (persistence_mode or get_persistence_mode()).strip().lower()
    if mode in {"neon", "mcp"}:
        mode = "remote"

    lifecycle_resolver = None
    if memory_store is None and mode == "remote":
        store = lifecycle_store if lifecycle_store is not None else RemoteLifecycleStore()
        memory_store = MemoryStore(
            tool_client=RemoteMcpMemoryAdapter(store.client)
        )
        lifecycle_resolver = CanonicalJobResolver(store)
    else:
        tool_client = memory_store.tool_client if memory_store else MockToolClient()
        memory_store = memory_store or MemoryStore(tool_client=tool_client)

    normalizer = SimpleJobNormalizer()
    scoring = SimpleScoreCalculator()
    provider = StaticJobProvider(jobs=job_inputs)
    profile = JobSearchProfile(
        candidate_name="Daily Candidate",
        keywords=["AI", "machine learning", "LLM"],
        location="Remote",
        remote=True,
    )

    workflow = JobSearchWorkflow(
        profile=profile,
        providers=[provider],
        normalizer=normalizer,
        scoring=scoring,
        memory_store=memory_store,
        lifecycle_resolver=lifecycle_resolver,
    )

    matches = __import__("asyncio").run(workflow.execute())

    total = len(job_inputs)
    duplicates = sum(1 for match in matches if match.decision.duplicate)
    saved = sum(1 for match in matches if match.saved)
    new_jobs = total - duplicates

    top_matches = [
        {
            "company": match.posting.company_name,
            "title": match.posting.title,
            "score": match.decision.match_score,
            "reason": match.decision.reason,
        }
        for match in sorted(matches, key=lambda item: item.decision.match_score or 0, reverse=True)
        if not match.decision.duplicate
    ][:5]

    report = {
        "total_jobs_received": total,
        "duplicates": duplicates,
        "new_jobs": new_jobs,
        "saved": saved,
        "top_matches": top_matches,
    }

    return report


def print_daily_report(report: dict[str, object]) -> None:
    print("Daily Job Run Report")
    print()
    print(f"Total jobs received: {report['total_jobs_received']}")
    print(f"Duplicates: {report['duplicates']}")
    print(f"New jobs: {report['new_jobs']}")
    print(f"Saved: {report['saved']}")
    print()
    print("Top matches:")
    for match in report["top_matches"]:
        print()
        print(f"Company: {match['company']}")
        print(f"Title: {match['title']}")
        print(f"Score: {match['score']}")
        print(f"Reason: {match['reason']}")


if __name__ == "__main__":
    project_root = Path(__file__).resolve().parents[2]
    incoming_file = project_root / "data" / "incoming_jobs.json"
    if not incoming_file.exists():
        logger.error("Missing incoming GPT job file: %s", incoming_file)
    else:
        report = run_daily_job_run(incoming_file)
        print_daily_report(report)
