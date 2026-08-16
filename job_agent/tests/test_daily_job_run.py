import os
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from job_agent.examples.daily_job_run import run_daily_job_run, print_daily_report
from job_agent.lifecycle import CanonicalJobResolver
from job_agent.lifecycle.evaluation_service import EvaluationService
from job_agent.memory.client import MemoryStore
from job_agent.workflow.engine import JobSearchWorkflow


SAMPLE_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "incoming_jobs.json"

PRODUCTION_LIKE_ENV = {
    "JOB_PERSISTENCE_MODE": "remote",
    "JOB_MCP_URL": "https://jay-job-mcp.vercel.app/api/mcp",
    "AUTH0_TOKEN_URL": "https://jay-job.us.auth0.com/oauth/token",
    "AUTH0_CLIENT_ID": "unit-test-client-id",
    "AUTH0_CLIENT_SECRET": "unit-test-client-secret",
    "AUTH0_AUDIENCE": "https://jay-job-mcp.vercel.app/api/mcp",
}


def _raise_unexpected_network(*_args, **_kwargs):
    raise AssertionError(
        "Unit tests must not perform network I/O "
        "(Auth0 / Vercel MCP / Neon). Inject local fakes instead."
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
            return {"id": len([call for call in self.calls if call[0] == "save_job_memory"])}
        if name == "get_job_history":
            return []
        return {}


class DailyJobRunTests(unittest.TestCase):
    """Local daily-run behavior must ignore process env persistence mode."""

    def setUp(self) -> None:
        self._saved_env = {key: os.environ.get(key) for key in PRODUCTION_LIKE_ENV}
        # Inherit / simulate a production-like shell; local tests must still be safe.
        os.environ.update(PRODUCTION_LIKE_ENV)

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _local_memory_store(self) -> tuple[SimpleToolClient, MemoryStore]:
        tool_client = SimpleToolClient()
        return tool_client, MemoryStore(tool_client=tool_client)

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
    def test_run_daily_job_run_reports_loaded_jobs(
        self,
        _remote_store_cls,
        _remote_call,
        _auth0_token,
    ):
        _tool_client, memory_store = self._local_memory_store()
        report = run_daily_job_run(SAMPLE_FILE, memory_store=memory_store)

        self.assertEqual(report["total_jobs_received"], 2)
        self.assertEqual(report["duplicates"], 0)
        self.assertEqual(report["reposts"], 0)
        self.assertEqual(report["new_jobs"], 2)
        self.assertEqual(report["saved"], 2)
        self.assertEqual(len(report["top_matches"]), 2)

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
    def test_run_daily_job_run_uses_memory_store(
        self,
        _remote_store_cls,
        _remote_call,
        _auth0_token,
    ):
        tool_client, memory_store = self._local_memory_store()
        report = run_daily_job_run(SAMPLE_FILE, memory_store=memory_store)

        self.assertEqual(report["saved"], 2)
        self.assertTrue(any(call[0] == "save_job_memory" for call in tool_client.calls))

    def test_run_daily_job_run_remote_mode_uses_lifecycle_store(self):
        remote_client = MagicMock()
        remote_store = MagicMock()
        remote_store.client = remote_client
        remote_store.save_job_evaluation = AsyncMock(return_value={"id": "eval-1"})

        workflow = MagicMock()
        workflow.execute = AsyncMock(return_value=[])

        with patch(
            "job_agent.examples.daily_job_run.JobSearchWorkflow",
            return_value=workflow,
        ) as workflow_cls, patch(
            "job_agent.examples.daily_job_run.RemoteLifecycleStore",
            side_effect=_raise_unexpected_network,
        ), patch(
            "job_agent.integrations.auth0_token.Auth0TokenProvider.get_access_token",
            side_effect=_raise_unexpected_network,
        ), patch(
            "job_agent.integrations.remote_mcp_client.RemoteMcpClient.call_tool",
            side_effect=_raise_unexpected_network,
        ):
            report = run_daily_job_run(
                SAMPLE_FILE,
                persistence_mode="remote",
                lifecycle_store=remote_store,
            )

        kwargs = workflow_cls.call_args.kwargs
        self.assertIs(kwargs["memory_store"].tool_client.client, remote_client)
        self.assertIsInstance(kwargs["lifecycle_resolver"], CanonicalJobResolver)
        self.assertIs(kwargs["lifecycle_resolver"].store, remote_store)
        # JobSearchWorkflow auto-wires EvaluationService when store can persist evals.
        engine = JobSearchWorkflow(
            profile=MagicMock(),
            providers=[],
            normalizer=MagicMock(),
            scoring=MagicMock(),
            memory_store=kwargs["memory_store"],
            lifecycle_resolver=kwargs["lifecycle_resolver"],
        )
        self.assertIsInstance(engine.evaluation_service, EvaluationService)
        self.assertEqual(report["total_jobs_received"], 2)
        remote_client.call_tool.assert_not_called()


class DailyJobRunNetworkIsolationTests(unittest.TestCase):
    """Regression: production-like env must not cause unit tests to hit the network."""

    def setUp(self) -> None:
        self._saved_env = {key: os.environ.get(key) for key in PRODUCTION_LIKE_ENV}
        os.environ.update(PRODUCTION_LIKE_ENV)

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    @patch(
        "urllib.request.urlopen",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.integrations.auth0_token.Auth0TokenProvider.get_access_token",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.integrations.remote_mcp_client.RemoteMcpClient.call_tool",
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
    def test_local_daily_run_with_remote_env_makes_no_network_calls(
        self,
        remote_store_cls,
        remote_client_init,
        remote_call_tool,
        auth0_get_token,
        urlopen,
    ):
        tool_client = SimpleToolClient()
        memory_store = MemoryStore(tool_client=tool_client)

        report = run_daily_job_run(SAMPLE_FILE, memory_store=memory_store)

        self.assertEqual(report["total_jobs_received"], 2)
        self.assertEqual(report["saved"], 2)
        remote_store_cls.assert_not_called()
        remote_client_init.assert_not_called()
        remote_call_tool.assert_not_called()
        auth0_get_token.assert_not_called()
        urlopen.assert_not_called()

    @patch(
        "job_agent.integrations.auth0_token.Auth0TokenProvider.get_access_token",
        side_effect=_raise_unexpected_network,
    )
    @patch(
        "job_agent.integrations.remote_mcp_client.RemoteMcpClient.call_tool",
        side_effect=_raise_unexpected_network,
    )
    def test_omitting_memory_store_with_remote_env_requires_injected_lifecycle_store(
        self,
        remote_call_tool,
        auth0_get_token,
    ):
        """Without an injected store, remote mode would construct RemoteLifecycleStore.
        Tests must inject a fake lifecycle_store (or memory_store) instead.
        """
        fake_store = MagicMock()
        fake_store.client = MagicMock()
        workflow = MagicMock()
        workflow.execute = AsyncMock(return_value=[])

        with patch(
            "job_agent.examples.daily_job_run.JobSearchWorkflow",
            return_value=workflow,
        ), patch(
            "job_agent.examples.daily_job_run.RemoteLifecycleStore",
            side_effect=_raise_unexpected_network,
        ) as remote_store_cls:
            report = run_daily_job_run(
                SAMPLE_FILE,
                persistence_mode="remote",
                lifecycle_store=fake_store,
            )

        remote_store_cls.assert_not_called()
        remote_call_tool.assert_not_called()
        auth0_get_token.assert_not_called()
        self.assertEqual(report["total_jobs_received"], 2)


class DailyJobRunReportAggregationTests(unittest.TestCase):
    """Report counts must come from lifecycle recommendations, not total-duplicates."""

    def setUp(self) -> None:
        self._saved_env = {key: os.environ.get(key) for key in PRODUCTION_LIKE_ENV}
        os.environ.update(PRODUCTION_LIKE_ENV)

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    @staticmethod
    def _match(*, recommendation: str, duplicate: bool, saved: bool = True) -> MagicMock:
        decision = MagicMock()
        decision.recommendation = recommendation
        decision.duplicate = duplicate
        decision.match_score = 10.0
        decision.reason = recommendation
        match = MagicMock()
        match.decision = decision
        match.saved = saved
        match.posting.company_name = "Example"
        match.posting.title = recommendation
        return match

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
    def test_report_counts_new_repost_and_same_posting_separately(
        self,
        _remote_store_cls,
        _remote_call,
        _auth0_token,
    ):
        matches = [
            self._match(recommendation="save", duplicate=False),
            self._match(recommendation="save_repost", duplicate=False),
            self._match(recommendation="update_existing", duplicate=True),
        ]
        workflow = MagicMock()
        workflow.execute = AsyncMock(return_value=matches)

        with patch(
            "job_agent.examples.daily_job_run.JobSearchWorkflow",
            return_value=workflow,
        ):
            report = run_daily_job_run(
                SAMPLE_FILE,
                memory_store=MemoryStore(tool_client=SimpleToolClient()),
            )

        # A. NEW_JOB
        self.assertEqual(report["new_jobs"], 1)
        # B. REPOST — counted as repost, NOT as new_job
        self.assertEqual(report["reposts"], 1)
        # C. SAME_POSTING
        self.assertEqual(report["duplicates"], 1)
        self.assertEqual(report["saved"], 3)

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
    def test_repost_is_not_counted_as_new_job(
        self,
        _remote_store_cls,
        _remote_call,
        _auth0_token,
    ):
        matches = [
            self._match(recommendation="save_repost", duplicate=False),
            self._match(recommendation="save_repost", duplicate=False),
        ]
        workflow = MagicMock()
        workflow.execute = AsyncMock(return_value=matches)

        with patch(
            "job_agent.examples.daily_job_run.JobSearchWorkflow",
            return_value=workflow,
        ):
            report = run_daily_job_run(
                SAMPLE_FILE,
                memory_store=MemoryStore(tool_client=SimpleToolClient()),
            )

        self.assertEqual(report["reposts"], 2)
        self.assertEqual(report["new_jobs"], 0)
        self.assertEqual(report["duplicates"], 0)
        # Old buggy formula total - duplicates would wrongly yield 2.
        self.assertNotEqual(
            report["new_jobs"],
            report["total_jobs_received"] - report["duplicates"],
        )
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
    def test_print_daily_report_includes_reposts(
        self,
        _remote_store_cls,
        _remote_call,
        _auth0_token,
    ):
        import io
        from contextlib import redirect_stdout

        buf = io.StringIO()
        with redirect_stdout(buf):
            print_daily_report(
                {
                    "total_jobs_received": 3,
                    "duplicates": 1,
                    "reposts": 1,
                    "new_jobs": 1,
                    "saved": 2,
                    "top_matches": [],
                }
            )
        output = buf.getvalue()
        self.assertIn("Reposts: 1", output)
        self.assertIn("New jobs: 1", output)
        self.assertIn("Duplicates: 1", output)


if __name__ == "__main__":
    unittest.main()
