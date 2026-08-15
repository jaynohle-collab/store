from __future__ import annotations
from typing import Any

from ..models.types import JobFingerprint, NormalizedJobPosting


class MemoryStore:
    """External MCP memory integration client.

    Works with:
    - local FastMCP/SQLite tool clients (`save_job_memory`, `get_job_history`, ...)
    - remote Auth0-secured MCP via ``RemoteMcpMemoryAdapter``

    Scoring, duplicate detection, and persistence decisions stay in the Python agent.
    """

    def __init__(self, tool_client: Any):
        self.tool_client = tool_client

    async def save_job(self, posting: NormalizedJobPosting) -> dict[str, Any]:
        return await self.tool_client.call_tool(
            "save_job_memory",
            {
                "company_name": posting.company_name,
                "title": posting.title,
                "url": posting.url,
                "description": posting.description,
                "description_hash": posting.description_hash,
                "source": posting.source,
                "status": posting.status,
                "location": posting.location,
                "remote_status": "remote" if posting.remote else None,
                "posted_date": posting.posted_date.isoformat() if posting.posted_date else None,
            },
        )

    async def check_duplicate(self, fingerprint: JobFingerprint) -> dict[str, Any]:
        return await self.tool_client.call_tool(
            "check_duplicate",
            {
                "company_name": fingerprint.company_name,
                "description_hash": fingerprint.description_hash,
            },
        )

    async def get_history(self) -> list[dict[str, Any]]:
        return await self.tool_client.call_tool("get_job_history")

    async def update_status(self, job_id: int, status: str) -> dict[str, Any]:
        return await self.tool_client.call_tool("update_status", {"job_id": job_id, "status": status})
