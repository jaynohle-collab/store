"""Network-isolated tests for the ChatGPT discovery inbox."""

from __future__ import annotations

import os
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from job_agent.discovery.inbox import InMemoryDiscoveryInboxStore
from job_agent.discovery.openai_discovery import DiscoveryValidationError
from job_agent.examples.process_discovery_inbox import process_discovery_inbox
from job_agent.lifecycle import CanonicalJobResolver
from job_agent.lifecycle.memory_store import InMemoryLifecycleStore
from job_agent.memory.client import MemoryStore
from job_agent.ranking.scoring import ProfileScoreCalculator, SCORING_VERSION


PRODUCTION_LIKE_ENV = {
    "JOB_PERSISTENCE_MODE": "remote",
    "JOB_MCP_URL": "https://jay-job-mcp.vercel.app/api/mcp",
    "AUTH0_TOKEN_URL": "https://jay-job.us.auth0.com/oauth/token",
    "AUTH0_CLIENT_ID": "unit-test-client-id",
    "AUTH0_CLIENT_SECRET": "unit-test-client-secret",
    "AUTH0_AUDIENCE": "https://jay-job-mcp-michaeltchueng-2909s-projects.vercel.app/api/mcp",
    "OPENAI_API_KEY": "sk-unit-test-openai-key",
    "OPENAI_MODEL": "gpt-4.1",
}

VALID_JOB = {
    "company": "AgentForge",
    "title": "Staff AI Engineer, Agent Platform",
    "url": "https://example.com/jobs/staff-ai",
    "location": "United States",
    "source": "Greenhouse",
    "description": (
        "Build production LLM agents, MCP integrations, RAG retrieval, "
        "and distributed backend platform services."
    ),
    "required_skills": ["Python", "LLM", "MCP"],
    "preferred_skills": ["LangGraph"],
    "remote_status": "Remote",
    "salary": "$220k",
    "posted_date": "2026-08-16",
}


def _raise_unexpected_network(*_args, **_kwargs):
    raise AssertionError(
        "Unit tests must not perform network I/O "
        "(OpenAI / Auth0 / Vercel MCP / Neon). Inject local fakes instead."
    )


class SimpleToolClient:
    def __init__(self):
        self.calls = []

    async def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        arguments = arguments or {}
        self.calls.append((name, arguments))
        if name == "check_duplicate":
            return {"duplicate": False, "existing_job_id": None}
        if name == "save_job_memory":
            return {"id": len([c for c in self.calls if c[0] == "save_job_memory"])}
        if name == "get_job_history":
            return []
        return {}


class DiscoveryInboxStoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_submit_valid_discovery_batch(self):
        store = InMemoryDiscoveryInboxStore()
        row = await store.submit_discovery_batch(
            {"jobs": [dict(VALID_JOB)], "source": "chatgpt", "metadata": {"note": "t"}}
        )
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["job_count"], 1)
        self.assertEqual(row["source"], "chatgpt")
        self.assertEqual(row["payload"]["jobs"][0]["title"], VALID_JOB["title"])

    async def test_reject_invalid_raw_schema(self):
        store = InMemoryDiscoveryInboxStore()
        with self.assertRaises(DiscoveryValidationError):
            await store.submit_discovery_batch({"jobs": [{"company": "X"}]})

    async def test_empty_company_rejected(self):
        store = InMemoryDiscoveryInboxStore()
        with self.assertRaises(DiscoveryValidationError):
            await store.submit_discovery_batch(
                {"jobs": [dict(VALID_JOB, company="")], "source": "chatgpt"}
            )

    async def test_whitespace_only_company_rejected(self):
        store = InMemoryDiscoveryInboxStore()
        with self.assertRaises(DiscoveryValidationError):
            await store.submit_discovery_batch(
                {"jobs": [dict(VALID_JOB, company="   ")], "source": "chatgpt"}
            )

    async def test_empty_title_rejected(self):
        store = InMemoryDiscoveryInboxStore()
        with self.assertRaises(DiscoveryValidationError):
            await store.submit_discovery_batch(
                {"jobs": [dict(VALID_JOB, title="")], "source": "chatgpt"}
            )

    async def test_empty_url_rejected(self):
        store = InMemoryDiscoveryInboxStore()
        with self.assertRaises(DiscoveryValidationError):
            await store.submit_discovery_batch(
                {"jobs": [dict(VALID_JOB, url="")], "source": "chatgpt"}
            )

    async def test_empty_description_rejected(self):
        store = InMemoryDiscoveryInboxStore()
        with self.assertRaises(DiscoveryValidationError):
            await store.submit_discovery_batch(
                {"jobs": [dict(VALID_JOB, description="")], "source": "chatgpt"}
            )

    async def test_optional_empty_fields_remain_accepted(self):
        store = InMemoryDiscoveryInboxStore()
        row = await store.submit_discovery_batch(
            {
                "jobs": [
                    dict(
                        VALID_JOB,
                        location="",
                        source="",
                        remote_status="",
                        salary="",
                        posted_date="",
                    )
                ],
                "source": "chatgpt",
            }
        )
        job = row["payload"]["jobs"][0]
        self.assertEqual(job["location"], "")
        self.assertEqual(job["source"], "")
        self.assertEqual(job["remote_status"], "")
        self.assertEqual(job["salary"], "")
        self.assertEqual(job["posted_date"], "")
        self.assertEqual(row["status"], "pending")

    async def test_valid_batch_remains_accepted(self):
        store = InMemoryDiscoveryInboxStore()
        row = await store.submit_discovery_batch(
            {"jobs": [dict(VALID_JOB)], "source": "chatgpt"}
        )
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["job_count"], 1)

    async def test_reject_discovery_provided_match_score(self):
        store = InMemoryDiscoveryInboxStore()
        with self.assertRaises(DiscoveryValidationError):
            await store.submit_discovery_batch(
                {"jobs": [dict(VALID_JOB, match_score=99)], "source": "chatgpt"}
            )

    async def test_pending_batch_listing(self):
        store = InMemoryDiscoveryInboxStore()
        first = await store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        second = await store.submit_discovery_batch(
            {"jobs": [dict(VALID_JOB, url="https://example.com/2")]}
        )
        pending = await store.list_pending_discovery_batches()
        self.assertEqual([row["id"] for row in pending], [first["id"], second["id"]])

    async def test_atomic_pending_to_processing_claim(self):
        store = InMemoryDiscoveryInboxStore()
        submitted = await store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        first = await store.claim_discovery_batch(submitted["id"])
        second = await store.claim_discovery_batch(submitted["id"])
        self.assertIsNotNone(first)
        self.assertEqual(first["status"], "processing")
        self.assertIsNone(second)

    async def test_cannot_claim_completed_batch(self):
        store = InMemoryDiscoveryInboxStore()
        submitted = await store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        claimed = await store.claim_discovery_batch(submitted["id"])
        completed = await store.complete_discovery_batch(claimed["id"])
        self.assertEqual(completed["status"], "completed")
        self.assertIsNone(await store.claim_discovery_batch(submitted["id"]))


class DiscoveryInboxProcessorTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {key: os.environ.get(key) for key in PRODUCTION_LIKE_ENV}
        os.environ.update(PRODUCTION_LIKE_ENV)

    def tearDown(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _network_patches(self) -> ExitStack:
        stack = ExitStack()
        targets = (
            "job_agent.integrations.auth0_token.Auth0TokenProvider.get_access_token",
            "job_agent.integrations.remote_mcp_client.RemoteMcpClient.call_tool",
            "job_agent.integrations.remote_mcp_client.RemoteMcpClient.__init__",
            "job_agent.examples.daily_job_run.RemoteLifecycleStore",
            "job_agent.examples.process_discovery_inbox.RemoteLifecycleStore",
            "urllib.request.urlopen",
        )
        for target in targets:
            stack.enter_context(patch(target, side_effect=_raise_unexpected_network))
        return stack

    def test_successful_python_processing_marks_completed(self):
        store = InMemoryDiscoveryInboxStore()
        submitted = __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )
        with self._network_patches():
            summary = process_discovery_inbox(
                inbox_store=store,
                run_daily=lambda **_k: {
                    "total_jobs_received": 1,
                    "duplicates": 0,
                    "reposts": 0,
                    "new_jobs": 1,
                    "saved": 1,
                    "top_matches": [],
                },
                persistence_mode="local",
                memory_store=MemoryStore(tool_client=SimpleToolClient()),
            )
        self.assertEqual(summary["claimed"], 1)
        self.assertEqual(summary["completed"], 1)
        self.assertEqual(summary["failed"], 0)
        row = __import__("asyncio").run(store.get_discovery_batch(submitted["id"]))
        self.assertEqual(row["status"], "completed")

    def test_python_failure_marks_failed_and_preserves_payload(self):
        store = InMemoryDiscoveryInboxStore()
        submitted = __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )
        original = submitted["payload"]

        def boom(**_kwargs):
            raise RuntimeError("workflow exploded")

        with self._network_patches():
            summary = process_discovery_inbox(
                inbox_store=store,
                run_daily=boom,
                persistence_mode="local",
                memory_store=MemoryStore(tool_client=SimpleToolClient()),
            )
        self.assertEqual(summary["failed"], 1)
        self.assertEqual(summary["completed"], 0)
        row = __import__("asyncio").run(store.get_discovery_batch(submitted["id"]))
        self.assertEqual(row["status"], "failed")
        self.assertIn("workflow exploded", row["error"])
        self.assertEqual(row["payload"], original)
        self.assertEqual(row["payload"]["jobs"][0]["url"], VALID_JOB["url"])

    def test_zero_pending_batches_is_successful_noop(self):
        store = InMemoryDiscoveryInboxStore()
        with self._network_patches():
            summary = process_discovery_inbox(
                inbox_store=store,
                run_daily=lambda **_k: (_ for _ in ()).throw(AssertionError("must not run")),
                persistence_mode="local",
            )
        self.assertEqual(summary["claimed"], 0)
        self.assertEqual(summary["completed"], 0)
        self.assertEqual(summary["failed"], 0)

    def test_downstream_runner_receives_original_raw_jobs(self):
        store = InMemoryDiscoveryInboxStore()
        __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)], "source": "chatgpt"})
        )
        captured = {}

        def capture_daily(**kwargs):
            captured["jobs_payload"] = kwargs.get("jobs_payload")
            return {
                "total_jobs_received": 1,
                "duplicates": 0,
                "reposts": 0,
                "new_jobs": 1,
                "saved": 1,
                "top_matches": [],
            }

        with self._network_patches():
            process_discovery_inbox(
                inbox_store=store,
                run_daily=capture_daily,
                persistence_mode="local",
            )
        job = captured["jobs_payload"]["jobs"][0]
        self.assertEqual(job["company"], VALID_JOB["company"])
        self.assertEqual(job["url"], VALID_JOB["url"])
        self.assertEqual(job["remote_status"], "Remote")
        self.assertEqual(job["salary"], "$220k")
        self.assertEqual(job["posted_date"], "2026-08-16")
        self.assertNotIn("match_score", job)

    def test_lifecycle_and_profile_scoring_remain_downstream(self):
        inbox = InMemoryDiscoveryInboxStore()
        lifecycle = InMemoryLifecycleStore()
        __import__("asyncio").run(
            inbox.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )
        with self._network_patches():
            first = process_discovery_inbox(
                inbox_store=inbox,
                persistence_mode="remote",
                lifecycle_store=lifecycle,
            )
        self.assertEqual(first["completed"], 1)
        self.assertEqual(first["reports"][0]["new_jobs"], 1)

        __import__("asyncio").run(
            inbox.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )
        with self._network_patches():
            second = process_discovery_inbox(
                inbox_store=inbox,
                persistence_mode="remote",
                lifecycle_store=lifecycle,
            )
        self.assertEqual(second["reports"][0]["duplicates"], 1)
        self.assertEqual(second["reports"][0]["new_jobs"], 0)
        self.assertEqual(SCORING_VERSION, "profile-v1")
        self.assertIsInstance(ProfileScoreCalculator(), ProfileScoreCalculator)
        resolver = CanonicalJobResolver(lifecycle)
        self.assertTrue(hasattr(resolver, "build_persistence_plan"))

    def test_network_isolated_with_production_like_env(self):
        store = InMemoryDiscoveryInboxStore()
        __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )
        with self._network_patches():
            summary = process_discovery_inbox(
                inbox_store=store,
                persistence_mode="local",
                memory_store=MemoryStore(tool_client=SimpleToolClient()),
            )
        self.assertEqual(summary["completed"], 1)


if __name__ == "__main__":
    unittest.main()
