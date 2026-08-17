"""Network-isolated tests for OpenAI discovery + automated daily orchestration."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from job_agent.discovery import (
    DiscoveryConfigError,
    DiscoveryError,
    DiscoveryValidationError,
    OpenAIDiscoveryClient,
    OpenAIDiscoveryConfig,
    validate_discovery_payload,
)
from job_agent.discovery.prompt import build_discovery_prompt
from job_agent.examples.automated_daily_run import run_automated_daily_discovery
from job_agent.examples.daily_job_run import load_gpt_jobs_from_file, run_daily_job_run
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


def _raise_unexpected_network(*_args, **_kwargs):
    raise AssertionError(
        "Unit tests must not perform network I/O "
        "(OpenAI / Auth0 / Vercel MCP / Neon). Inject local fakes instead."
    )


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


class FakeDiscoveryClient:
    def __init__(self, payload=None, error: Exception | None = None):
        self.payload = payload if payload is not None else {"jobs": [dict(VALID_JOB)]}
        self.error = error
        self.calls = 0

    def discover_jobs(self):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.payload


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


class DiscoveryValidationTests(unittest.TestCase):
    def test_valid_structured_payload(self):
        payload = validate_discovery_payload({"jobs": [dict(VALID_JOB)]}, max_jobs=100)
        self.assertEqual(len(payload["jobs"]), 1)
        self.assertEqual(payload["jobs"][0]["remote_status"], "Remote")
        self.assertEqual(payload["jobs"][0]["salary"], "$220k")
        self.assertEqual(payload["jobs"][0]["posted_date"], "2026-08-16")

    def test_empty_job_list_is_valid(self):
        payload = validate_discovery_payload({"jobs": []}, max_jobs=100)
        self.assertEqual(payload["jobs"], [])

    def test_invalid_schema_rejects_missing_fields(self):
        bad = {"jobs": [{"company": "X", "title": "Y"}]}
        with self.assertRaises(DiscoveryValidationError):
            validate_discovery_payload(bad, max_jobs=100)

    def test_maximum_job_guard(self):
        jobs = [dict(VALID_JOB, url=f"https://example.com/{i}") for i in range(3)]
        with self.assertRaises(DiscoveryValidationError):
            validate_discovery_payload({"jobs": jobs}, max_jobs=2)

    def test_discovery_must_not_include_match_score(self):
        job = dict(VALID_JOB, match_score=99)
        with self.assertRaises(DiscoveryValidationError):
            validate_discovery_payload({"jobs": [job]}, max_jobs=100)

    def test_prompt_states_discovery_only_boundaries(self):
        prompt = build_discovery_prompt()
        self.assertIn("MUST NOT", prompt)
        self.assertIn("score", prompt.lower())
        self.assertIn("duplicate", prompt.lower())
        self.assertIn("repost", prompt.lower())


class OpenAIDiscoveryClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {key: os.environ.get(key) for key in PRODUCTION_LIKE_ENV}
        os.environ.update(PRODUCTION_LIKE_ENV)

    def tearDown(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_config_requires_api_key_and_model(self):
        os.environ.pop("OPENAI_API_KEY", None)
        with self.assertRaises(DiscoveryConfigError):
            OpenAIDiscoveryConfig.from_env()
        os.environ["OPENAI_API_KEY"] = "sk-test"
        os.environ.pop("OPENAI_MODEL", None)
        with self.assertRaises(DiscoveryConfigError):
            OpenAIDiscoveryConfig.from_env()

    def test_client_parses_structured_response_without_network(self):
        response = SimpleNamespace(
            output_text=json.dumps({"jobs": [dict(VALID_JOB)]})
        )
        create = MagicMock(return_value=response)
        client = OpenAIDiscoveryClient(
            OpenAIDiscoveryConfig(api_key="sk-test", model="gpt-4.1", max_jobs=100),
            create_response=create,
            sleep=lambda _s: None,
        )
        payload = client.discover_jobs()
        self.assertEqual(len(payload["jobs"]), 1)
        create.assert_called_once()
        kwargs = create.call_args.kwargs
        self.assertEqual(kwargs["model"], "gpt-4.1")
        self.assertEqual(kwargs["tools"], [{"type": "web_search"}])
        self.assertEqual(kwargs["text"]["format"]["type"], "json_schema")
        self.assertTrue(kwargs["text"]["format"]["strict"])

    def test_invalid_model_json_fails(self):
        create = MagicMock(return_value=SimpleNamespace(output_text="{not-json"))
        client = OpenAIDiscoveryClient(
            OpenAIDiscoveryConfig(api_key="sk-test", model="gpt-4.1"),
            create_response=create,
            sleep=lambda _s: None,
        )
        with self.assertRaises(DiscoveryValidationError):
            client.discover_jobs()

    def test_api_failure_raises_discovery_error(self):
        create = MagicMock(side_effect=RuntimeError("boom"))
        client = OpenAIDiscoveryClient(
            OpenAIDiscoveryConfig(
                api_key="sk-test", model="gpt-4.1", max_retries=1
            ),
            create_response=create,
            sleep=lambda _s: None,
        )
        with self.assertRaises(DiscoveryError):
            client.discover_jobs()
        self.assertEqual(create.call_count, 2)


class AutomatedDailyRunIsolationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {key: os.environ.get(key) for key in PRODUCTION_LIKE_ENV}
        os.environ.update(PRODUCTION_LIKE_ENV)

    def tearDown(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    @patch(
        "job_agent.integrations.auth0_token.Auth0TokenProvider.get_access_token",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.integrations.remote_mcp_client.RemoteMcpClient.call_tool",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.examples.daily_job_run.RemoteLifecycleStore",
        side_effect=_raise_unexpected_network,
    )
    @patch("urllib.request.urlopen", side_effect=_raise_unexpected_network)
    @patch(
        "job_agent.examples.automated_daily_run.OpenAIDiscoveryClient",
        side_effect=_raise_unexpected_network,
    )
    def test_discovery_api_failure_means_zero_persistence(
        self,
        _openai_cls,
        _urlopen,
        _remote_store,
        _remote_call,
        _auth0,
    ):
        persist_calls = {"n": 0}

        def boom_discover():
            raise DiscoveryError("openai unavailable")

        class FailingClient:
            def discover_jobs(self):
                return boom_discover()

        def runaway_daily(*_a, **_k):
            persist_calls["n"] += 1
            raise AssertionError("daily runner must not run after discovery failure")

        with self.assertRaises(DiscoveryError):
            run_automated_daily_discovery(
                discovery_client=FailingClient(),
                run_daily=runaway_daily,
                memory_store=MemoryStore(tool_client=SimpleToolClient()),
            )
        self.assertEqual(persist_calls["n"], 0)

    @patch(
        "job_agent.integrations.auth0_token.Auth0TokenProvider.get_access_token",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.integrations.remote_mcp_client.RemoteMcpClient.call_tool",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.examples.daily_job_run.RemoteLifecycleStore",
        side_effect=_raise_unexpected_network,
    )
    @patch("urllib.request.urlopen", side_effect=_raise_unexpected_network)
    def test_automated_runner_passes_raw_jobs_to_existing_workflow(
        self,
        _urlopen,
        _remote_store,
        _remote_call,
        _auth0,
    ):
        tool_client = SimpleToolClient()
        memory_store = MemoryStore(tool_client=tool_client)
        discovery = FakeDiscoveryClient({"jobs": [dict(VALID_JOB)]})

        summary = run_automated_daily_discovery(
            discovery_client=discovery,
            memory_store=memory_store,
            persistence_mode="local",
        )

        self.assertEqual(discovery.calls, 1)
        self.assertEqual(summary["discovery_received"], 1)
        self.assertEqual(summary["saved"], 1)
        self.assertTrue(any(call[0] == "save_job_memory" for call in tool_client.calls))

    @patch(
        "job_agent.integrations.auth0_token.Auth0TokenProvider.get_access_token",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.integrations.remote_mcp_client.RemoteMcpClient.call_tool",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.examples.daily_job_run.RemoteLifecycleStore",
        side_effect=_raise_unexpected_network,
    )
    @patch("urllib.request.urlopen", side_effect=_raise_unexpected_network)
    def test_empty_discovery_is_successful_noop(
        self,
        _urlopen,
        _remote_store,
        _remote_call,
        _auth0,
    ):
        tool_client = SimpleToolClient()
        summary = run_automated_daily_discovery(
            discovery_client=FakeDiscoveryClient({"jobs": []}),
            memory_store=MemoryStore(tool_client=tool_client),
            persistence_mode="local",
        )
        self.assertEqual(summary["discovery_received"], 0)
        self.assertEqual(summary["saved"], 0)
        self.assertFalse(any(call[0] == "save_job_memory" for call in tool_client.calls))

    @patch(
        "job_agent.integrations.auth0_token.Auth0TokenProvider.get_access_token",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.integrations.remote_mcp_client.RemoteMcpClient.call_tool",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.examples.daily_job_run.RemoteLifecycleStore",
        side_effect=_raise_unexpected_network,
    )
    @patch("urllib.request.urlopen", side_effect=_raise_unexpected_network)
    def test_lifecycle_and_profile_scoring_remain_downstream(
        self,
        _urlopen,
        _remote_store,
        _remote_call,
        _auth0,
    ):
        store = InMemoryLifecycleStore()
        resolver = CanonicalJobResolver(store)
        discovery = FakeDiscoveryClient(
            {
                "jobs": [
                    dict(VALID_JOB),
                    dict(
                        VALID_JOB,
                        url="https://example.com/jobs/staff-ai-repost",
                        source="Lever",
                        posted_date="2026-08-17",
                    ),
                ]
            }
        )

        first = run_automated_daily_discovery(
            discovery_client=FakeDiscoveryClient({"jobs": [dict(VALID_JOB)]}),
            persistence_mode="remote",
            lifecycle_store=store,
        )
        self.assertEqual(first["new_jobs"], 1)

        second = run_automated_daily_discovery(
            discovery_client=discovery,
            persistence_mode="remote",
            lifecycle_store=store,
        )
        # First of the two is SAME_POSTING (exact URL), second is REPOST-ish or new URL.
        self.assertGreaterEqual(second["discovery_received"], 1)
        self.assertEqual(SCORING_VERSION, "profile-v1")
        self.assertIsInstance(ProfileScoreCalculator(), ProfileScoreCalculator)

        # Explicit lifecycle ownership check: same URL => SAME_POSTING disposition path.
        same = run_daily_job_run(
            jobs_payload={"jobs": [dict(VALID_JOB)]},
            persistence_mode="remote",
            lifecycle_store=store,
        )
        self.assertEqual(same["duplicates"], 1)
        self.assertEqual(same["new_jobs"], 0)

        # Resolver still classifies independently of discovery.
        self.assertIs(resolver.store, store)
        self.assertTrue(hasattr(resolver, "build_persistence_plan"))

    @patch(
        "job_agent.integrations.auth0_token.Auth0TokenProvider.get_access_token",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.integrations.remote_mcp_client.RemoteMcpClient.__init__",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.examples.daily_job_run.RemoteLifecycleStore",
        side_effect=_raise_unexpected_network,
    )
    @patch("urllib.request.urlopen", side_effect=_raise_unexpected_network)
    def test_preserves_remote_status_salary_posted_date(
        self,
        _urlopen,
        _remote_store,
        _remote_init,
        _auth0,
    ):
        captured = {}

        def capture_daily(job_file=None, **kwargs):
            payload = kwargs.get("jobs_payload")
            captured["payload"] = payload
            return {
                "total_jobs_received": 1,
                "duplicates": 0,
                "reposts": 0,
                "new_jobs": 1,
                "saved": 1,
                "top_matches": [],
            }

        run_automated_daily_discovery(
            discovery_client=FakeDiscoveryClient({"jobs": [dict(VALID_JOB)]}),
            run_daily=capture_daily,
        )
        job = captured["payload"]["jobs"][0]
        self.assertEqual(job["remote_status"], "Remote")
        self.assertEqual(job["salary"], "$220k")
        self.assertEqual(job["posted_date"], "2026-08-16")
        self.assertNotIn("match_score", job)


class Utf8BomLoaderTests(unittest.TestCase):
    def test_load_gpt_jobs_from_file_accepts_utf8_bom(self):
        payload = {"jobs": [dict(VALID_JOB)]}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bom.json"
            raw = json.dumps(payload).encode("utf-8")
            path.write_bytes(b"\xef\xbb\xbf" + raw)
            jobs = load_gpt_jobs_from_file(path)
            self.assertEqual(len(jobs), 1)
            self.assertEqual(jobs[0].company, "AgentForge")
            self.assertEqual(jobs[0].metadata["remote_status"], "Remote")


if __name__ == "__main__":
    unittest.main()
