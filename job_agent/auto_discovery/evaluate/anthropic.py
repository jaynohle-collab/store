"""Bounded Haiku Messages transport, guarded by a durable remote budget.

No SDK retries, redirects, local counters or reservation refunds. An uncertain
request consumes its slot; a later attempt must reserve and claim a new one.
"""

from __future__ import annotations

import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Callable, Protocol

import httpx

from job_agent.auto_discovery.types import AdapterError

from .providers import (
    EvaluationProvider,
    BudgetUnavailableError,
    InvalidModelOutputError,
    TransientProviderError,
    _parse_json_content,
    _raise_for_provider_http,
)

HAIKU_MODEL = "claude-haiku-5-5"
HAIKU_MAX_REQUEST_BYTES = 16_000
HAIKU_MAX_OUTPUT_TOKENS = 2_048
HAIKU_RESERVED_MICRO_USD = 5_000
HAIKU_POLICY_VERSION = "haiku-5-5-v1"


class HaikuBudgetError(BudgetUnavailableError):
    """Budget denied/unavailable. Queue the candidate, never reject the job."""


class ToolClient(Protocol):
    def call_tool_sync(self, name: str, arguments: dict[str, Any]) -> Any: ...


class RemoteHaikuBudget:
    """Acquire a fresh, payload-bound, single-use dispatch claim per request."""

    def __init__(self, client: ToolClient | None = None):
        self._client = client

    def _call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            if self._client is None:
                from job_agent.integrations.remote_mcp_client import RemoteMcpClient

                self._client = RemoteMcpClient()
            # The discovery pipeline already runs an asyncio loop. Run the
            # synchronous MCP wrapper in a worker so its asyncio.run is valid.
            with ThreadPoolExecutor(max_workers=1) as executor:
                result = executor.submit(self._client.call_tool_sync, name, args).result()
        except Exception:
            # Tool/provider messages may contain credentials or private payloads.
            raise HaikuBudgetError("haiku budget unavailable; no inference dispatched") from None
        if not isinstance(result, dict) or result.get("allowed") is not True:
            reason = result.get("reason") if isinstance(result, dict) else None
            safe = reason if reason in {
                "daily_limit", "monthly_limit", "day_reset_pending", "disabled",
                "expired", "already_claimed", "not_found", "payload_mismatch",
            } else "denied"
            raise HaikuBudgetError(f"haiku budget {safe}; candidate deferred")
        return result

    def claim(self, digest: str) -> dict[str, Any]:
        reservation = self._call("reserve_haiku_attempt", {"request_sha256": digest})
        reservation_id = reservation.get("reservation_id")
        if not isinstance(reservation_id, str) or not reservation_id:
            raise HaikuBudgetError("haiku budget invalid reservation")
        return self._call("claim_haiku_attempt", {
            "reservation_id": reservation_id, "request_sha256": digest,
        })


def _utc_timestamp(value: Any) -> float:
    if not isinstance(value, str):
        raise ValueError("timestamp required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp timezone required")
    return parsed.timestamp()


class AnthropicHaikuProvider(EvaluationProvider):
    name = "anthropic"

    def __init__(
        self,
        api_key: str,
        model: str = HAIKU_MODEL,
        transport: httpx.BaseTransport | None = None,
        *,
        budget: RemoteHaikuBudget | None = None,
        clock: Callable[[], float] | None = None,
    ):
        if model != HAIKU_MODEL:
            raise ValueError("Haiku model must match the reviewed budget policy")
        self.api_key = api_key
        self.model = model
        self._transport = transport
        self._budget = budget or RemoteHaikuBudget()
        self._clock = clock or (lambda: datetime.now(timezone.utc).timestamp())

    def _check_claim(self, claim: dict[str, Any]) -> None:
        expected = {
            "allowed": True,
            "policy_version": HAIKU_POLICY_VERSION,
            "model": HAIKU_MODEL,
            "max_request_bytes": HAIKU_MAX_REQUEST_BYTES,
            "max_output_tokens": HAIKU_MAX_OUTPUT_TOKENS,
            "reserved_micro_usd": HAIKU_RESERVED_MICRO_USD,
        }
        if not isinstance(claim, dict) or any(
            claim.get(key) != value for key, value in expected.items()
        ):
            raise HaikuBudgetError("haiku budget policy mismatch")
        try:
            server_time = _utc_timestamp(claim.get("server_time"))
            deadline = _utc_timestamp(claim.get("dispatch_before"))
            now = self._clock()
            # Fail closed on stale replies and clock skew. Leave a full second
            # before expiry rather than dispatching at the midnight boundary.
            valid = abs(now - server_time) <= 2 and 0 < deadline - server_time <= 5
            valid = valid and now < deadline - 1
        except (ValueError, TypeError, OverflowError):
            valid = False
        if not valid:
            raise HaikuBudgetError("haiku dispatch claim expired or clock unsynchronized")

    def complete_json(
        self, *, system: str, user: str, schema: dict[str, Any],
    ) -> dict[str, Any]:
        # Independent from the generic paid-provider flag. A key or provider
        # override alone must never enable paid Haiku execution.
        if os.environ.get("HAIKU_PAID_EXECUTION_APPROVED", "").strip().lower() != "true":
            raise HaikuBudgetError("haiku paid execution disabled")
        payload = {
            "model": self.model,
            "max_tokens": HAIKU_MAX_OUTPUT_TOKENS,
            # Haiku 5.5 rejects non-default sampling parameters. Low effort
            # with thinking disabled is supported for this single-turn task.
            "output_config": {"effort": "low"},
            "thinking": {"type": "disabled"},
            "system": system,
            "messages": [{
                "role": "user",
                "content": user + "\n\nReturn one JSON object. JSON schema:\n" + json.dumps(schema),
            }],
        }
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) > HAIKU_MAX_REQUEST_BYTES:
            raise TransientProviderError("haiku request exceeds reviewed byte bound; candidate deferred")
        digest = hashlib.sha256(body).hexdigest()
        # Create the HTTP client before the short-lived claim to minimize delay.
        # Default httpx transport has zero retries; redirect following is off.
        try:
            with httpx.Client(transport=self._transport, timeout=60.0, follow_redirects=False) as client:
                claim = self._budget.claim(digest)
                self._check_claim(claim)
                response = client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": self.api_key,
                        "anthropic-version": "2023-06-01",
                        "Content-Type": "application/json",
                    },
                    content=body,
                )
        except httpx.HTTPError as exc:
            raise TransientProviderError(f"anthropic transport: {type(exc).__name__}") from None
        # Never log raw provider bodies; they can repeat input or credentials.
        if response.status_code == 529:
            raise TransientProviderError("anthropic overloaded", status_code=529)
        if 300 <= response.status_code < 400:
            raise TransientProviderError("anthropic redirect refused")
        try:
            _raise_for_provider_http("anthropic", response.status_code, "")
        except AdapterError:
            # A rejected API request is an integration/provider problem, not
            # evidence that the job is unqualified. Preserve it for later.
            raise TransientProviderError(
                f"anthropic request rejected: HTTP {response.status_code}",
                status_code=response.status_code,
            ) from None
        try:
            data = response.json()
            if not isinstance(data, dict) or data.get("stop_reason") != "end_turn":
                raise ValueError("incomplete output")
            blocks = data.get("content")
            if not isinstance(blocks, list) or not blocks or any(
                not isinstance(block, dict)
                or block.get("type") not in {"text", "thinking", "redacted_thinking"}
                or (block.get("type") == "text" and not isinstance(block.get("text"), str))
                for block in blocks
            ):
                raise ValueError("text output required")
            # Never log/store reasoning blocks; extract only the final text.
            content = "".join(block["text"] for block in blocks if block["type"] == "text")
        except (ValueError, KeyError, TypeError):
            raise InvalidModelOutputError("anthropic response incomplete or invalid") from None
        return _parse_json_content(content)
