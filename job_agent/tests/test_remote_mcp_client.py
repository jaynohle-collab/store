from __future__ import annotations

import importlib
import inspect
import unittest
from unittest.mock import AsyncMock, MagicMock

from job_agent.integrations.lifecycle_store import RemoteLifecycleStore
from job_agent.integrations.remote_mcp_client import (
    RemoteMcpClient,
    RemoteMcpMemoryAdapter,
)


class RemoteMcpClientTests(unittest.IsolatedAsyncioTestCase):
    def test_import_uses_httpx_not_httpx2(self) -> None:
        module = importlib.import_module("job_agent.integrations.remote_mcp_client")
        source = inspect.getsource(module)
        self.assertIn("import httpx", source)
        self.assertNotIn("httpx2", source)
        self.assertTrue(hasattr(module, "httpx"))
        self.assertFalse(hasattr(module, "httpx2"))

    async def test_retries_once_with_refreshed_token_after_401(self) -> None:
        token_provider = MagicMock()
        client = RemoteMcpClient(
            "https://example.test/api/mcp",
            token_provider=token_provider,
        )
        unauthorized = RuntimeError("Remote MCP HTTP 401: unauthorized")
        client._call_tool_once = AsyncMock(  # type: ignore[method-assign]
            side_effect=[unauthorized, {"ok": True}]
        )

        result = await client.call_tool("get_job", {"id": "job-id"})

        self.assertEqual(result, {"ok": True})
        token_provider.invalidate.assert_called_once_with()
        token_provider.get_access_token.assert_called_once_with(force_refresh=True)
        self.assertEqual(client._call_tool_once.await_count, 2)

    async def test_adapter_paginates_complete_duplicate_history(self) -> None:
        remote = MagicMock()
        remote.call_tool = AsyncMock(
            side_effect=[
                {
                    "jobs": [
                        {
                            "id": str(index),
                            "company": "Acme",
                            "title": f"Engineer {index}",
                            "url": f"https://example.test/{index}",
                            "description_hash": f"hash-{index}",
                        }
                        for index in range(100)
                    ],
                    "next_offset": 100,
                },
                {
                    "jobs": [
                        {
                            "id": "100",
                            "company": "Acme",
                            "title": "Engineer 100",
                            "url": "https://example.test/100",
                            "description_hash": "hash-100",
                        }
                    ],
                    "next_offset": None,
                },
            ]
        )
        adapter = RemoteMcpMemoryAdapter(remote)

        history = await adapter.call_tool("get_job_history")

        self.assertEqual(len(history), 101)
        self.assertEqual(history[-1]["description_hash"], "hash-100")
        self.assertEqual(remote.call_tool.await_count, 2)
        second_page_args = remote.call_tool.await_args_list[1].args[1]
        self.assertEqual(second_page_args["offset"], 100)

    async def test_adapter_persists_description_hash(self) -> None:
        remote = MagicMock()
        remote.call_tool = AsyncMock(
            return_value={
                "id": "storage-id",
                "job": {
                    "company": "Acme",
                    "title": "Engineer",
                    "url": "https://example.test/job",
                },
            }
        )
        adapter = RemoteMcpMemoryAdapter(remote)

        await adapter.call_tool(
            "save_job_memory",
            {
                "company_name": "Acme",
                "title": "Engineer",
                "url": "https://example.test/job",
                "description_hash": "sha256-value",
            },
        )

        arguments = remote.call_tool.await_args.args[1]
        self.assertEqual(arguments["description_hash"], "sha256-value")


class RemoteLifecycleStoreSaveCanonicalJobTests(unittest.IsolatedAsyncioTestCase):
    async def test_save_canonical_job_removes_none_values(self) -> None:
        client = MagicMock()
        client.call_tool = AsyncMock(
            return_value={"canonical_job": {"id": "canonical-1"}}
        )
        store = RemoteLifecycleStore(client=client)

        await store.save_canonical_job(
            {
                "company_key": "acme",
                "normalized_title": "member of technical staff ai platform",
                "title": "Member of Technical Staff, AI Platform",
                "role_family": None,
                "is_active": False,
                "seen_count": 0,
                "notes": "",
                "tags": [],
            }
        )

        arguments = client.call_tool.await_args.args[1]
        self.assertNotIn("role_family", arguments)
        self.assertEqual(arguments["is_active"], False)
        self.assertEqual(arguments["seen_count"], 0)
        self.assertEqual(arguments["notes"], "")
        self.assertEqual(arguments["tags"], [])

    async def test_member_of_technical_staff_ai_platform_drops_null_role_family(
        self,
    ) -> None:
        client = MagicMock()
        client.call_tool = AsyncMock(
            return_value={"canonical_job": {"id": "canonical-mts"}}
        )
        store = RemoteLifecycleStore(client=client)

        result = await store.save_canonical_job(
            {
                "company_name": "Acme",
                "company_key": "acme",
                "title": "Member of Technical Staff, AI Platform",
                "normalized_title": "member of technical staff ai platform",
                "role_family": None,
            }
        )

        self.assertEqual(result["id"], "canonical-mts")
        arguments = client.call_tool.await_args.args[1]
        self.assertEqual(
            arguments["title"],
            "Member of Technical Staff, AI Platform",
        )
        self.assertNotIn("role_family", arguments)
        self.assertNotIn(None, arguments.values())


if __name__ == "__main__":
    unittest.main()
