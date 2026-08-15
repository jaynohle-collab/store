from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, MagicMock

from job_agent.integrations.remote_mcp_client import (
    RemoteMcpClient,
    RemoteMcpMemoryAdapter,
)


class RemoteMcpClientTests(unittest.IsolatedAsyncioTestCase):
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


if __name__ == "__main__":
    unittest.main()
