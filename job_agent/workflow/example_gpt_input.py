from __future__ import annotations
import asyncio

from ..memory.client import MemoryStore
from ..models.types import JobInput, JobSearchProfile
from ..ranking.scoring import SimpleScoreCalculator
from ..search.gpt_job_input_adapter import GPTJobInputAdapter, GPTJobInputProvider, GPTJobInputValidationError
from ..search.interfaces import JobNormalizer
from ..workflow.engine import JobSearchWorkflow


class SimpleJobNormalizer(JobNormalizer):
    def normalize(self, job_input: "JobInput") -> "NormalizedJobPosting":
        from ..models.types import NormalizedJobPosting

        return NormalizedJobPosting(
            title=job_input.title.strip(),
            company_name=job_input.company.strip(),
            location=job_input.location,
            remote=(job_input.location is None or "remote" in (job_input.location or "").lower()),
            description=job_input.description,
            url=job_input.url,
            source=job_input.source,
            description_hash=str(hash(job_input.description or job_input.url or job_input.title)),
        )


class MockToolClient:
    def __init__(self):
        self.calls = []

    async def call_tool(self, name: str, arguments: dict) -> dict:
        self.calls.append((name, arguments))
        if name == "check_duplicate":
            return {"duplicate": False, "existing_job_id": None}
        if name == "save_job_memory":
            return {"id": 123, "company": arguments["company_name"], "title": arguments["title"], "url": arguments.get("url"), "status": arguments.get("status", "new")}
        if name == "get_job_history":
            return []
        if name == "update_status":
            return {"updated": True, "job_id": arguments["job_id"], "status": arguments["status"]}
        return {}


async def run_gpt_input_example() -> None:
    profile = JobSearchProfile(
        candidate_name="Test Candidate",
        keywords=["Senior AI Engineer", "Agent Platform", "LLM infrastructure", "MCP", "RAG"],
        location="US",
        remote=True,
        experience_level="Senior",
    )

    raw_gpt_results = [
        {
            "company": "AgentForge",
            "title": "Senior AI Engineer",
            "url": "https://jobs.agentforge.ai/senior-ai-engineer",
            "description": "Build AI agent orchestration pipelines and LLM infrastructure.",
            "source": "gpt-agent-search",
            "location": "Remote",
            "metadata": {"generated_by": "gpt-job-search"},
        },
        {
            "company": "PlatformAI",
            "title": "Staff AI Infrastructure Engineer",
            "url": "https://jobs.platformai.com/staff-ai-infrastructure",
            "description": "Design distributed systems for AI model serving and RAG workflows.",
            "source": "gpt-agent-search",
            "location": "Remote",
            "metadata": {"generated_by": "gpt-job-search"},
        },
        {
            "company": "IncompleteCo",
            "title": "AI Systems Engineer",
            "url": "",
            "description": "Missing URL should cause rejection.",
            "source": "gpt-agent-search",
            "location": "Remote",
            "metadata": {"generated_by": "gpt-job-search"},
        },
    ]

    adapter = GPTJobInputAdapter()
    try:
        job_inputs = adapter.adapt(raw_gpt_results)
    except GPTJobInputValidationError as exc:
        print("Adapter validation error:", exc)
        job_inputs = []

    normalizer = SimpleJobNormalizer()
    scoring = SimpleScoreCalculator()
    memory_store = MemoryStore(tool_client=MockToolClient())

    provider = GPTJobInputProvider(job_inputs=job_inputs)

    workflow = JobSearchWorkflow(
        profile=profile,
        providers=[provider],
        normalizer=normalizer,
        scoring=scoring,
        memory_store=memory_store,
    )

    job_matches = await workflow.execute()
    for match in job_matches:
        print(f"Saved job: {match.posting.title} at {match.posting.company_name} (score={match.decision.match_score})")


if __name__ == "__main__":
    asyncio.run(run_gpt_input_example())
