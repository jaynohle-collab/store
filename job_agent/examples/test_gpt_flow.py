from __future__ import annotations
import asyncio
import logging

from ..memory.client import MemoryStore
from ..models.types import JobSearchProfile
from ..ranking.scoring import SimpleScoreCalculator
from ..search.gpt_job_input_adapter import GPTJobInputAdapter, GPTJobInputProvider
from ..workflow.engine import JobSearchWorkflow
from ..workflow.example_gpt_input import SimpleJobNormalizer

logging.basicConfig(level=logging.INFO)


class MockToolClient:
    def __init__(self):
        self.calls = []

    async def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        arguments = arguments or {}
        self.calls.append((name, arguments))
        if name == "check_duplicate":
            return {"duplicate": False, "existing_job_id": None}
        if name == "save_job_memory":
            return {
                "id": len([call for call in self.calls if call[0] == "save_job_memory"]),
                "company": arguments["company_name"],
                "title": arguments["title"],
                "url": arguments.get("url"),
                "status": arguments.get("status", "new"),
            }
        if name == "get_job_history":
            return []
        if name == "update_status":
            return {"updated": True, "job_id": arguments["job_id"], "status": arguments["status"]}
        return {}


async def run_test_gpt_flow() -> None:
    sample_gpt_json = [
        {
            "company": "OpenAI",
            "title": "Senior AI Engineer",
            "url": "https://openai.com/careers/senior-ai-engineer",
            "description": "Build production AI agent infrastructure and LLM platforms.",
            "source": "gpt-job-search",
            "location": "Remote",
            "metadata": {"generated_by": "example"},
        },
        {
            "company": "OpenAI Inc.",
            "title": "Sr. AI Engineer",
            "url": "https://openai.com/careers/senior-ai-engineer-2",
            "description": "Design AI systems and deploy LLM infrastructure at scale.",
            "source": "gpt-job-search",
            "location": "Remote",
            "metadata": {"generated_by": "example"},
        },
        {
            "company": "DeepMind",
            "title": "Machine Learning Engineer",
            "url": "https://deepmind.com/careers/ml-engineer",
            "description": "Research and build scalable machine learning systems.",
            "source": "gpt-job-search",
            "location": "London",
            "metadata": {"generated_by": "example"},
        },
    ]

    adapter = GPTJobInputAdapter()
    job_inputs = adapter.adapt(sample_gpt_json)

    normalizer = SimpleJobNormalizer()
    scoring = SimpleScoreCalculator()
    memory_store = MemoryStore(tool_client=MockToolClient())

    provider = GPTJobInputProvider(job_inputs=job_inputs)
    profile = JobSearchProfile(
        candidate_name="Test Candidate",
        keywords=["AI", "LLM", "Infrastructure"],
        location="Remote",
        remote=True,
        experience_level="Senior",
    )

    workflow = JobSearchWorkflow(
        profile=profile,
        providers=[provider],
        normalizer=normalizer,
        scoring=scoring,
        memory_store=memory_store,
    )

    matches = await workflow.execute()

    print("--- GPT Flow Example ---")
    print(f"Adapted {len(job_inputs)} JobInput objects")
    for idx, job_input in enumerate(job_inputs, start=1):
        print(f"JobInput {idx}: {job_input.company} | {job_input.title} | {job_input.url}")

    saved_count = sum(1 for match in matches if match.saved)
    duplicate_count = sum(1 for match in matches if match.decision.duplicate)

    print(f"Saved {saved_count} normalized jobs, {duplicate_count} duplicates skipped")
    for match in matches:
        status = "saved" if match.saved else "duplicate"
        print(
            f"{status.title()} job {match.memory_job_id}: {match.posting.company_name} - {match.posting.title} "
            f"(score={match.decision.match_score}, reason={match.decision.reason}, confidence={match.decision.confidence_score})"
        )

    print("Memory tool calls:")
    for call in memory_store.tool_client.calls:
        print(call)


if __name__ == "__main__":
    asyncio.run(run_test_gpt_flow())
