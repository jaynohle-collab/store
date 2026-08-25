"""Network-isolated tests for automatic discovery-batch processing (Milestone 4A)."""

from __future__ import annotations

import os
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from job_agent.discovery.inbox import InMemoryDiscoveryInboxStore
from job_agent.examples.process_discovery_inbox import main, process_discovery_inbox
from job_agent.memory.client import MemoryStore


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
    async def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        if name == "check_duplicate":
            return {"duplicate": False, "existing_job_id": None}
        if name == "save_job_memory":
            return {"id": 1}
        if name == "get_job_history":
            return []
        return {}


class AutomaticBatchProcessingTests(unittest.TestCase):
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

    def test_pending_batch_claimed_and_completed(self):
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
                    "job_effects": [
                        {
                            "input_index": 0,
                            "processing_action": "created",
                            "created_posting": True,
                            "created_canonical": True,
                            "posting_id": "11111111-1111-4111-8111-111111111111",
                            "canonical_job_id": "22222222-2222-4222-8222-222222222222",
                            "normalized_url": "https://example.com/jobs/staff-ai",
                        }
                    ],
                },
                persistence_mode="local",
                memory_store=MemoryStore(tool_client=SimpleToolClient()),
            )
        self.assertEqual(summary["claimed"], 1)
        self.assertEqual(summary["completed"], 1)
        row = __import__("asyncio").run(store.get_discovery_batch(submitted["id"]))
        self.assertEqual(row["status"], "completed")
        self.assertEqual(len(store.effects[submitted["id"]]), 1)

    def test_overlapping_workers_do_not_process_same_batch(self):
        store = InMemoryDiscoveryInboxStore()
        submitted = __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )
        first = __import__("asyncio").run(store.claim_discovery_batch(submitted["id"]))
        second = __import__("asyncio").run(store.claim_discovery_batch(submitted["id"]))
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        with self._network_patches():
            summary = process_discovery_inbox(
                inbox_store=store,
                run_daily=lambda **_k: (_ for _ in ()).throw(AssertionError("must not run")),
                persistence_mode="local",
                batch_id=submitted["id"],
            )
        self.assertEqual(summary["claimed"], 0)

    def test_empty_pending_queue_exits_successfully(self):
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

    def test_failed_batch_records_failure_safely(self):
        store = InMemoryDiscoveryInboxStore()
        submitted = __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )

        def boom(**_kwargs):
            raise RuntimeError(
                "workflow exploded AUTH0_CLIENT_SECRET=unit-test-client-secret"
            )

        with self._network_patches():
            summary = process_discovery_inbox(
                inbox_store=store,
                run_daily=boom,
                persistence_mode="local",
                memory_store=MemoryStore(tool_client=SimpleToolClient()),
            )
        self.assertEqual(summary["failed"], 1)
        row = __import__("asyncio").run(store.get_discovery_batch(submitted["id"]))
        self.assertEqual(row["status"], "failed")
        self.assertNotIn("unit-test-client-secret", row["error"])
        self.assertIn("[REDACTED]", row["error"])

    def test_retry_does_not_duplicate_effect_writes(self):
        store = InMemoryDiscoveryInboxStore()
        submitted = __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )
        claimed = __import__("asyncio").run(store.claim_discovery_batch(submitted["id"]))
        effect_payload = {
            "batch_id": claimed["id"],
            "attempt_id": claimed["attempt_id"],
            "input_index": 0,
            "idempotency_key": f"{claimed['id']}:0",
            "processing_action": "created",
            "create_canonical": {
                "company": "AgentForge",
                "company_key": "agentforge",
                "title": "Staff AI Engineer",
                "normalized_title": "staff ai engineer",
            },
            "create_posting": {
                "use_new_canonical": True,
                "source": "Greenhouse",
                "url": "https://example.com/jobs/staff-ai",
                "normalized_url": "https://example.com/jobs/staff-ai",
                "posting_status": "active",
            },
        }
        first = __import__("asyncio").run(
            store.apply_discovery_batch_job_persistence(effect_payload)
        )
        second = __import__("asyncio").run(
            store.apply_discovery_batch_job_persistence(effect_payload)
        )
        self.assertFalse(first["idempotent_replay"])
        self.assertTrue(second["idempotent_replay"])
        self.assertEqual(len(store.effects[claimed["id"]]), 1)

    def test_bounded_batches_per_invocation(self):
        store = InMemoryDiscoveryInboxStore()
        for i in range(4):
            __import__("asyncio").run(
                store.submit_discovery_batch(
                    {
                        "jobs": [
                            dict(
                                VALID_JOB,
                                url=f"https://example.com/jobs/{i}",
                            )
                        ]
                    }
                )
            )
        calls = {"n": 0}

        def runner(**_kwargs):
            calls["n"] += 1
            return {
                "total_jobs_received": 1,
                "duplicates": 0,
                "reposts": 0,
                "new_jobs": 1,
                "saved": 1,
                "top_matches": [],
                "job_effects": [],
            }

        with self._network_patches():
            summary = process_discovery_inbox(
                inbox_store=store,
                run_daily=runner,
                persistence_mode="local",
                limit=2,
            )
        self.assertEqual(summary["claimed"], 2)
        self.assertEqual(calls["n"], 2)
        pending = __import__("asyncio").run(store.list_pending_discovery_batches())
        self.assertEqual(len(pending), 2)

    def test_manual_cli_remains_backward_compatible(self):
        store = InMemoryDiscoveryInboxStore()
        __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )
        with self._network_patches():
            with patch(
                "job_agent.examples.process_discovery_inbox.process_discovery_inbox",
                return_value={"claimed": 1, "completed": 1, "failed": 0, "reports": []},
            ) as mocked:
                code = main([])
        self.assertEqual(code, 0)
        mocked.assert_called_once()
        kwargs = mocked.call_args.kwargs
        self.assertEqual(kwargs["limit"], 10)
        self.assertIsNone(kwargs["batch_id"])

    def test_fail_on_batch_failure_exit_code(self):
        store = InMemoryDiscoveryInboxStore()
        __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )

        def boom(**_kwargs):
            raise RuntimeError("boom")

        with self._network_patches():
            with patch(
                "job_agent.examples.process_discovery_inbox.RemoteLifecycleStore",
                side_effect=_raise_unexpected_network,
            ):
                with patch(
                    "job_agent.examples.process_discovery_inbox.process_discovery_inbox",
                    return_value={
                        "claimed": 1,
                        "completed": 0,
                        "failed": 1,
                        "reports": [],
                        "fail_on_batch_failure": True,
                    },
                ):
                    code = main(["--fail-on-batch-failure"])
        self.assertEqual(code, 1)

    def test_stale_claim_without_mutation_started_is_requeued(self):
        store = InMemoryDiscoveryInboxStore()
        submitted = __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )
        claimed = __import__("asyncio").run(store.claim_discovery_batch(submitted["id"]))
        store.batches[claimed["id"]]["_force_stale"] = True
        recovery = __import__("asyncio").run(
            store.recover_stale_discovery_batch_claims()
        )
        self.assertEqual(len(recovery["requeued"]), 1)
        self.assertEqual(recovery["policy"], "fail_closed_unless_mutation_started_false")
        row = __import__("asyncio").run(store.get_discovery_batch(submitted["id"]))
        self.assertEqual(row["status"], "pending")

    def test_stale_claim_after_mutation_started_fails_closed(self):
        store = InMemoryDiscoveryInboxStore()
        submitted = __import__("asyncio").run(
            store.submit_discovery_batch({"jobs": [dict(VALID_JOB)]})
        )
        claimed = __import__("asyncio").run(store.claim_discovery_batch(submitted["id"]))
        attempt = store.attempts[claimed["attempt_id"]]
        attempt["mutation_started"] = True
        store.batches[claimed["id"]]["_force_stale"] = True
        recovery = __import__("asyncio").run(
            store.recover_stale_discovery_batch_claims()
        )
        self.assertEqual(len(recovery["requeued"]), 0)
        self.assertEqual(len(recovery["failed"]), 1)
        row = __import__("asyncio").run(store.get_discovery_batch(submitted["id"]))
        self.assertEqual(row["status"], "failed")

    def test_workflow_file_uses_same_processor_path(self):
        workflow = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "process-discovery-inbox.yml"
        text = workflow.read_text(encoding="utf-8")
        self.assertIn("python -m job_agent.examples.process_discovery_inbox", text)
        self.assertIn("concurrency:", text)
        self.assertIn("workflow_dispatch:", text)
        self.assertIn("cancel-in-progress: false", text)
        self.assertNotIn("${{ secrets.", text.replace("${{ secrets.AUTH0_CLIENT_ID }}", "").replace("${{ secrets.AUTH0_CLIENT_SECRET }}", ""))
        self.assertNotIn("echo ${{ secrets", text)
        # Never export or print Neon URLs in the workflow file.
        self.assertNotRegex(text, r"(?m)^\s*DATABASE_URL:")


if __name__ == "__main__":
    unittest.main()
