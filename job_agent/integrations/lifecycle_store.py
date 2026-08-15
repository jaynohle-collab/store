"""Remote MCP adapter implementing the Python LifecycleStore protocol."""

from __future__ import annotations

from typing import Any

from .remote_mcp_client import RemoteMcpClient, RemoteMcpError


class RemoteLifecycleStore:
    """Persistence/query only — no classification or scoring."""

    def __init__(self, client: RemoteMcpClient | None = None):
        self.client = client or RemoteMcpClient()

    async def _call(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        return await self.client.call_tool(name, arguments or {})

    async def save_canonical_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = await self._call("save_canonical_job", payload)
        return (result or {}).get("canonical_job") or result

    async def touch_canonical_job(
        self, canonical_job_id: str, last_seen_at: str | None = None
    ) -> dict[str, Any] | None:
        args: dict[str, Any] = {"id": canonical_job_id}
        if last_seen_at:
            args["last_seen_at"] = last_seen_at
        result = await self._call("touch_canonical_job", args)
        return (result or {}).get("canonical_job")

    async def find_canonical_jobs(
        self, company_key: str, normalized_title: str
    ) -> list[dict[str, Any]]:
        result = await self._call(
            "find_canonical_jobs",
            {"company_key": company_key, "normalized_title": normalized_title},
        )
        return list((result or {}).get("canonical_jobs") or [])

    async def save_job_posting(self, payload: dict[str, Any]) -> dict[str, Any]:
        cleaned = {k: v for k, v in payload.items() if v is not None}
        result = await self._call("save_job_posting", cleaned)
        return (result or {}).get("posting") or result

    async def update_job_posting(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        cleaned = {k: v for k, v in payload.items() if v is not None}
        result = await self._call("update_job_posting", cleaned)
        return (result or {}).get("posting")

    async def find_posting_by_normalized_url(self, normalized_url: str) -> dict[str, Any] | None:
        result = await self._call("find_posting_by_url", {"normalized_url": normalized_url})
        return (result or {}).get("posting")

    async def find_posting_by_external_id(
        self, source: str, external_job_id: str
    ) -> dict[str, Any] | None:
        result = await self._call(
            "find_posting_by_external_id",
            {"source": source, "external_job_id": external_job_id},
        )
        return (result or {}).get("posting")

    async def list_postings_for_canonical(self, canonical_job_id: str) -> list[dict[str, Any]]:
        result = await self._call(
            "list_postings_for_canonical",
            {"canonical_job_id": canonical_job_id},
        )
        return list((result or {}).get("postings") or [])

    async def list_recent_postings(self, days: int = 36500, limit: int = 500) -> list[dict[str, Any]]:
        # Paginate remotely; MCP max limit is 100.
        postings: list[dict[str, Any]] = []
        offset = 0
        page_size = min(limit, 100)
        while len(postings) < limit:
            result = await self._call(
                "list_recent_postings",
                {"days": days, "limit": page_size, "offset": offset},
            )
            batch = list((result or {}).get("postings") or [])
            postings.extend(batch)
            next_offset = (result or {}).get("next_offset")
            if next_offset is None:
                break
            offset = int(next_offset)
        return postings[:limit]

    async def search_job_postings(self, query: str, limit: int = 50) -> list[dict[str, Any]]:
        result = await self._call(
            "search_job_postings",
            {"query": query, "limit": min(limit, 100)},
        )
        return list((result or {}).get("postings") or [])

    async def list_reposted_postings(self, limit: int = 50) -> list[dict[str, Any]]:
        result = await self._call("list_reposted_postings", {"limit": min(limit, 100)})
        return list((result or {}).get("postings") or [])

    async def list_reposts_with_prior_applications(self, limit: int = 50) -> list[dict[str, Any]]:
        result = await self._call(
            "list_reposts_with_prior_applications",
            {"limit": min(limit, 100)},
        )
        return list((result or {}).get("postings") or [])

    async def record_application(self, payload: dict[str, Any]) -> dict[str, Any]:
        cleaned = {k: v for k, v in payload.items() if v is not None}
        result = await self._call("record_application", cleaned)
        return (result or {}).get("application") or result

    async def get_application(self, application_id: str) -> dict[str, Any] | None:
        result = await self._call("get_application", {"id": application_id})
        return (result or {}).get("application")

    async def list_applications(self, **filters: Any) -> list[dict[str, Any]]:
        args = {k: v for k, v in filters.items() if v is not None}
        # Map pythonic keys to MCP args
        if "canonical_job_id" in args:
            pass
        if "posting_id" in args:
            pass
        result = await self._call("list_applications", args)
        return list((result or {}).get("applications") or [])

    async def update_application_status(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        cleaned = {k: v for k, v in payload.items() if v is not None}
        result = await self._call("update_application_status", cleaned)
        return (result or {}).get("application")

    async def add_application_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        cleaned = {k: v for k, v in payload.items() if v is not None}
        result = await self._call("add_application_event", cleaned)
        return (result or {}).get("event") or result

    async def list_application_events(self, application_id: str) -> list[dict[str, Any]]:
        result = await self._call(
            "list_application_events",
            {"application_id": application_id},
        )
        return list((result or {}).get("events") or [])

    async def save_discovery_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        cleaned = {k: v for k, v in payload.items() if v is not None}
        result = await self._call("save_discovery_run", cleaned)
        return (result or {}).get("discovery_run") or result

    async def list_discovery_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        result = await self._call("list_discovery_runs", {"limit": limit})
        return list((result or {}).get("discovery_runs") or [])
