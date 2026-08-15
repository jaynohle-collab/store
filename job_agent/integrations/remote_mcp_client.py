"""Authenticated Streamable HTTP client for the remote Jay Job MCP."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from .auth0_token import Auth0Config, Auth0TokenProvider

logger = logging.getLogger(__name__)


class RemoteMcpError(RuntimeError):
    """Raised when a remote MCP call fails."""


class RemoteMcpClient:
    """Call remote MCP tools with Auth0 Bearer authentication."""

    def __init__(
        self,
        mcp_url: str | None = None,
        token_provider: Auth0TokenProvider | None = None,
    ):
        self.mcp_url = (mcp_url or os.environ.get("JOB_MCP_URL", "")).strip()
        if not self.mcp_url:
            raise RemoteMcpError("JOB_MCP_URL is required for remote MCP mode")

        self.token_provider = token_provider or Auth0TokenProvider(Auth0Config.from_env())

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        try:
            return await self._call_tool_once(name, arguments or {})
        except Exception as exc:
            if not self._is_unauthorized(exc):
                raise self._safe_error(name, exc) from None

        logger.info("Remote MCP returned 401; refreshing Auth0 token and retrying once")
        self.token_provider.invalidate()
        self.token_provider.get_access_token(force_refresh=True)
        try:
            return await self._call_tool_once(name, arguments or {})
        except Exception as exc:
            raise self._safe_error(name, exc) from None

    def call_tool_sync(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        """Synchronous convenience wrapper for non-async callers."""
        return asyncio.run(self.call_tool(name, arguments))

    async def _call_tool_once(self, name: str, arguments: dict[str, Any]) -> Any:
        """Use the official MCP SDK for negotiation, framing, and transport."""
        token = self.token_provider.get_access_token()
        async with httpx2.AsyncClient(
            headers={
                "Authorization": f"Bearer {token}",
            },
            timeout=httpx2.Timeout(30.0, read=300.0),
            follow_redirects=True,
        ) as http_client:
            transport = streamable_http_client(
                self.mcp_url,
                http_client=http_client,
                terminate_on_close=False,
            )
            async with Client(transport, mode="auto") as client:
                result = await client.call_tool(name, arguments)

        if result.is_error:
            text = self._extract_text(result.content)
            raise RemoteMcpError(text or f"MCP tool {name} returned an error")

        if result.structured_content is not None:
            return result.structured_content

        text = self._extract_text(result.content)
        return {"raw": text} if text else result.model_dump(mode="json")

    def _extract_text(self, content: list[Any]) -> str:
        texts: list[str] = []
        for item in content:
            if getattr(item, "type", None) == "text":
                texts.append(str(getattr(item, "text", "") or ""))
        return "\n".join(texts).strip()

    def _is_unauthorized(self, exc: Exception) -> bool:
        status_code = getattr(exc, "status_code", None)
        if status_code == 401:
            return True
        response = getattr(exc, "response", None)
        return getattr(response, "status_code", None) == 401 or "401" in str(exc)

    def _safe_error(self, name: str, exc: Exception) -> RemoteMcpError:
        message = str(exc)
        token = getattr(self.token_provider, "_access_token", None)
        if isinstance(token, str) and token:
            message = message.replace(token, "[REDACTED]")
        return RemoteMcpError(f"Remote MCP call failed for {name}: {message}")


class RemoteMcpMemoryAdapter:
    """Adapt remote MCP tools to the existing MemoryStore tool-client interface.

    Maps legacy local tool names used by MemoryStore onto the remote persistence tools.
    Duplicate detection and scoring remain in the Python agent.
    """

    def __init__(self, client: RemoteMcpClient | None = None):
        self.client = client or RemoteMcpClient()

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        arguments = arguments or {}
        if name == "save_job_memory":
            payload = {
                "company": arguments.get("company_name") or arguments.get("company"),
                "title": arguments.get("title"),
                "url": arguments.get("url"),
                "description": arguments.get("description"),
                "description_hash": arguments.get("description_hash"),
                "source": arguments.get("source"),
                "location": arguments.get("location"),
                "remote_status": arguments.get("remote_status"),
                "salary": arguments.get("salary"),
                "posted_date": arguments.get("posted_date"),
                "required_skills": arguments.get("required_skills"),
                "preferred_skills": arguments.get("preferred_skills"),
            }
            payload = {key: value for key, value in payload.items() if value is not None}
            result = await self.client.call_tool("save_job", payload)
            # Normalize to the shape MemoryStore/workflow expect.
            job = result.get("job") if isinstance(result, dict) else None
            return {
                "id": (result or {}).get("id") if isinstance(result, dict) else None,
                "company": (job or {}).get("company") if isinstance(job, dict) else payload.get("company"),
                "title": (job or {}).get("title") if isinstance(job, dict) else payload.get("title"),
                "url": (job or {}).get("url") if isinstance(job, dict) else payload.get("url"),
                "status": arguments.get("status", "new"),
                "raw": result,
            }

        if name == "get_job_history":
            page_size = min(int(arguments.get("page_size") or 100), 100)
            max_results = arguments.get("limit")
            max_results = int(max_results) if max_results is not None else None
            offset = 0
            history = []
            while True:
                result = await self.client.call_tool(
                    "list_recent_jobs",
                    {
                        "days": int(arguments.get("days") or 36500),
                        "limit": page_size,
                        "offset": offset,
                    },
                )
                jobs = result.get("jobs") if isinstance(result, dict) else []
                for job in jobs or []:
                    history.append(
                        {
                            "id": job.get("id"),
                            "company": job.get("company"),
                            "title": job.get("title"),
                            "url": job.get("url"),
                            "status": "stored",
                            "description": job.get("description"),
                            "description_hash": job.get("description_hash"),
                            "location": job.get("location"),
                            "source": job.get("source"),
                        }
                    )
                    if max_results is not None and len(history) >= max_results:
                        return history

                next_offset = result.get("next_offset") if isinstance(result, dict) else None
                if next_offset is None:
                    break
                offset = int(next_offset)
            return history

        if name == "check_duplicate":
            # Remote MCP does not decide duplicates. Return a neutral result so
            # DuplicateDetector can evaluate history itself via get_job_history.
            return {"duplicate": False, "existing_job_id": None}

        if name in {
            "save_job",
            "get_job",
            "search_jobs",
            "list_recent_jobs",
            "delete_job",
            "save_canonical_job",
            "get_canonical_job",
            "find_canonical_jobs",
            "find_canonical_jobs_by_company",
            "touch_canonical_job",
            "save_job_posting",
            "update_job_posting",
            "get_job_posting",
            "search_job_postings",
            "list_recent_postings",
            "list_postings_for_canonical",
            "list_reposted_postings",
            "list_reposts_with_prior_applications",
            "find_posting_by_url",
            "find_posting_by_external_id",
            "record_application",
            "get_application",
            "list_applications",
            "update_application_status",
            "add_application_event",
            "list_application_events",
            "save_discovery_run",
            "list_discovery_runs",
            "save_job_evaluation",
            "get_latest_job_evaluation",
            "list_job_evaluations",
        }:
            return await self.client.call_tool(name, arguments)

        if name == "update_status":
            raise RemoteMcpError(
                "update_status is not supported by the remote MCP persistence API"
            )

        raise RemoteMcpError(f"Unsupported tool for remote MCP adapter: {name}")
