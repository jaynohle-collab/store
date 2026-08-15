"""Authenticated Streamable HTTP client for the remote Jay Job MCP."""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any
from urllib import error, request

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
        self._request_id = 0

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        return self.call_tool_sync(name, arguments or {})

    def call_tool_sync(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments or {},
            },
        }
        response = self._post_json(payload)
        if "error" in response:
            raise RemoteMcpError(f"MCP tool error for {name}: {response['error']}")

        result = response.get("result") or {}
        if result.get("isError"):
            text = self._extract_text(result)
            raise RemoteMcpError(text or f"MCP tool {name} returned an error")

        structured = result.get("structuredContent")
        if structured is not None:
            return structured

        text = self._extract_text(result)
        if not text:
            return result
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"raw": text}

    def _post_json(self, payload: dict[str, Any], *, retry_on_401: bool = True) -> dict[str, Any]:
        token = self.token_provider.get_access_token()
        body = json.dumps(payload).encode("utf-8")
        req = request.Request(
            self.mcp_url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
        )
        try:
            with request.urlopen(req, timeout=60) as response:
                raw = response.read().decode("utf-8")
                content_type = response.headers.get("Content-Type", "")
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if exc.code == 401 and retry_on_401:
                logger.info("Remote MCP returned 401; refreshing Auth0 token and retrying once")
                self.token_provider.invalidate()
                self.token_provider.get_access_token(force_refresh=True)
                return self._post_json(payload, retry_on_401=False)
            safe_detail = detail.replace(token, "[REDACTED]")
            raise RemoteMcpError(f"Remote MCP HTTP {exc.code}: {safe_detail}") from None
        except error.URLError as exc:
            raise RemoteMcpError(f"Remote MCP network error: {exc.reason}") from None

        if "text/event-stream" in content_type:
            return self._parse_sse_jsonrpc(raw)

        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RemoteMcpError("Remote MCP returned non-JSON response") from exc

    def _parse_sse_jsonrpc(self, raw: str) -> dict[str, Any]:
        data_lines: list[str] = []
        for line in raw.splitlines():
            if line.startswith("data:"):
                data_lines.append(line[5:].strip())
        if not data_lines:
            raise RemoteMcpError("Remote MCP SSE response contained no data")
        # Prefer the last JSON-RPC payload in the stream.
        last_error: Exception | None = None
        for chunk in reversed(data_lines):
            if not chunk or chunk == "[DONE]":
                continue
            try:
                return json.loads(chunk)
            except json.JSONDecodeError as exc:
                last_error = exc
                continue
        raise RemoteMcpError("Unable to parse SSE JSON-RPC payload") from last_error

    def _extract_text(self, result: dict[str, Any]) -> str:
        content = result.get("content") or []
        texts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                texts.append(str(item.get("text") or ""))
        return "\n".join(texts).strip()

    def _next_id(self) -> str:
        self._request_id += 1
        return f"{self._request_id}-{uuid.uuid4().hex[:8]}"


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
            result = await self.client.call_tool(
                "list_recent_jobs",
                {"days": int(arguments.get("days") or 365), "limit": int(arguments.get("limit") or 100)},
            )
            jobs = result.get("jobs") if isinstance(result, dict) else []
            history = []
            for job in jobs or []:
                history.append(
                    {
                        "id": job.get("id"),
                        "company": job.get("company"),
                        "title": job.get("title"),
                        "url": job.get("url"),
                        "status": "stored",
                        "description": job.get("description"),
                        "location": job.get("location"),
                        "source": job.get("source"),
                    }
                )
            return history

        if name == "check_duplicate":
            # Remote MCP does not decide duplicates. Return a neutral result so
            # DuplicateDetector can evaluate history itself via get_job_history.
            return {"duplicate": False, "existing_job_id": None}

        if name in {"save_job", "get_job", "search_jobs", "list_recent_jobs", "delete_job"}:
            return await self.client.call_tool(name, arguments)

        if name == "update_status":
            raise RemoteMcpError(
                "update_status is not supported by the remote MCP persistence API"
            )

        raise RemoteMcpError(f"Unsupported tool for remote MCP adapter: {name}")
