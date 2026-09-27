"""Provider-neutral LLM clients for gpt-fit-v2 evaluation.

Runtime fallback: when multiple API keys are configured, quota / rate-limit /
transient failures try the next provider. Selection is not first-key-only.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import time
from abc import ABC, abstractmethod
from email.utils import parsedate_to_datetime
from typing import Any, Callable

import httpx

from job_agent.auto_discovery.types import AdapterError

logger = logging.getLogger(__name__)

RETRYABLE_GEMINI_STATUSES = frozenset({500, 502, 503, 504})
GEMINI_MAX_ATTEMPTS = 3
GEMINI_BACKOFF_BASE_SECONDS = 2.0
GEMINI_BACKOFF_CAP_SECONDS = 8.0
GEMINI_RETRY_AFTER_CAP_SECONDS = 30.0
_ERROR_MESSAGE_MAX = 160

_SECRET_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"AIza[0-9A-Za-z_-]{10,}"), "[redacted]"),
    (re.compile(r"\bsk-[0-9A-Za-z_-]{8,}"), "[redacted]"),
    (re.compile(r"\borg-[0-9A-Za-z]{6,}"), "[redacted]"),
    (re.compile(r"(?i)\bbearer\s+\S+"), "Bearer [redacted]"),
    (
        re.compile(r"(?i)\b(api[_-]?key|authorization|x-goog-api-key|key)\s*[:=]\s*\S+"),
        r"\1=[redacted]",
    ),
)


def sanitize_error_text(text: str, *, limit: int = _ERROR_MESSAGE_MAX) -> str:
    """Collapse whitespace, redact credentials, and bound length."""
    out = " ".join((text or "").split())
    for pattern, replacement in _SECRET_PATTERNS:
        out = pattern.sub(replacement, out)
    return out[:limit]


def parse_provider_error(body: str) -> tuple[str, str]:
    """Return sanitized ``(status, message)`` from a Google/OpenAI-style error body.

    Never returns the raw body: unparseable payloads yield ``unparseable_error``.
    """
    try:
        payload = json.loads(body or "")
    except (json.JSONDecodeError, TypeError):
        return "unknown", "unparseable_error"
    err = payload.get("error") if isinstance(payload, dict) else None
    if not isinstance(err, dict):
        return "unknown", "unparseable_error"
    status = err.get("status") or err.get("code") or err.get("type") or "unknown"
    message = sanitize_error_text(str(err.get("message") or "")) or "empty_message"
    return sanitize_error_text(str(status), limit=40), message


class TransientProviderError(Exception):
    """Provider failure that is safe to retry on the next configured provider."""

    def __init__(
        self,
        message: str = "",
        *,
        status_code: int | None = None,
        provider_status: str | None = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.provider_status = provider_status


class QuotaExhaustedError(TransientProviderError):
    """Free-tier / billing quota exhausted for this provider."""


class InvalidModelOutputError(ValueError):
    """Provider returned non-JSON or unusable content."""


class AllProvidersUnavailableError(QuotaExhaustedError):
    """Every configured provider failed with a transient/quota error."""


def _parse_json_content(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        raise InvalidModelOutputError("empty model output")
    if raw.startswith("```"):
        lines = raw.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        raw = "\n".join(lines).strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise InvalidModelOutputError(f"invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise InvalidModelOutputError("model JSON must be an object")
    return data


def _raise_for_provider_http(provider: str, status: int, body: str) -> None:
    if status < 400:
        return
    lower = (body or "").lower()
    err_status, err_message = parse_provider_error(body)
    detail = f"{provider} HTTP {status}"
    if err_status != "unknown" or err_message != "unparseable_error":
        detail = f"{detail} {err_status}: {err_message}"
    kwargs = {"status_code": status, "provider_status": err_status}
    if status == 402:
        raise QuotaExhaustedError(detail, **kwargs)
    if status == 429:
        # Rate-limit and quota both warrant trying the next provider.
        raise QuotaExhaustedError(detail, **kwargs)
    if "quota" in lower and status in (403, 503):
        raise QuotaExhaustedError(detail, **kwargs)
    if status in RETRYABLE_GEMINI_STATUSES:
        raise TransientProviderError(detail, **kwargs)
    if status == 404:
        # Model id unavailable / renamed — try next provider when configured.
        raise TransientProviderError(detail, **kwargs)
    raise AdapterError(detail, category="validation", status_code=status)


def parse_retry_after(value: str | None, *, now: float | None = None) -> float | None:
    """Parse a Retry-After header (seconds or HTTP date) into bounded seconds."""
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        try:
            when = parsedate_to_datetime(raw)
        except (TypeError, ValueError):
            return None
        if when is None:
            return None
        seconds = when.timestamp() - (time.time() if now is None else now)
    if seconds != seconds or seconds < 0:  # NaN or past date
        return 0.0
    return min(seconds, GEMINI_RETRY_AFTER_CAP_SECONDS)


def backoff_delay(attempt: int, rng: Callable[[], float] = random.random) -> float:
    """Equal-jitter exponential backoff for retry ``attempt`` (1-based)."""
    ceiling = min(
        GEMINI_BACKOFF_CAP_SECONDS,
        GEMINI_BACKOFF_BASE_SECONDS * (2 ** max(attempt - 1, 0)),
    )
    return ceiling / 2 + rng() * (ceiling / 2)


class EvaluationProvider(ABC):
    name: str

    @abstractmethod
    def complete_json(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        """Return a parsed JSON object. Raise TransientProviderError on retryable failure."""


class OpenAIProvider(EvaluationProvider):
    name = "openai"

    def __init__(
        self,
        api_key: str,
        model: str = "gpt-4.1-mini",
        transport: httpx.BaseTransport | None = None,
    ):
        self.api_key = api_key
        self.model = model
        self._transport = transport

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            "model": self.model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": user + "\n\nJSON schema:\n" + json.dumps(schema),
                },
            ],
        }
        try:
            with httpx.Client(transport=self._transport, timeout=60.0) as client:
                response = client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
        except (httpx.TimeoutException, httpx.NetworkError, httpx.TransportError) as exc:
            raise TransientProviderError(f"openai transport: {type(exc).__name__}") from None
        _raise_for_provider_http("openai", response.status_code, response.text)
        data = response.json()
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise InvalidModelOutputError("openai response missing content") from exc
        return _parse_json_content(str(content))


class GeminiProvider(EvaluationProvider):
    name = "gemini"

    def __init__(
        self,
        api_key: str,
        model: str | None = None,
        transport: httpx.BaseTransport | None = None,
        *,
        max_attempts: int = GEMINI_MAX_ATTEMPTS,
        sleep: Callable[[float], None] = time.sleep,
        rng: Callable[[], float] = random.random,
        clock: Callable[[], float] = time.monotonic,
    ):
        self.api_key = api_key
        # Default: gemini-3.6-flash (gemini-2.5-flash is unavailable to many new keys).
        self.model = (
            model
            or (os.environ.get("GEMINI_MODEL") or "").strip()
            or "gemini-3.6-flash"
        )
        self._transport = transport
        self.max_attempts = max(1, min(int(max_attempts), GEMINI_MAX_ATTEMPTS))
        self._sleep = sleep
        self._rng = rng
        self._clock = clock
        # Safe per-attempt diagnostics for the last complete_json call (no payloads).
        self.last_attempts: list[dict[str, Any]] = []

    @staticmethod
    def build_payload(*, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any]:
        return {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "text": user
                            + "\n\nJSON schema:\n"
                            + json.dumps(schema)
                        }
                    ],
                }
            ],
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
            },
        }

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        # Prefer header auth so the key is less likely to appear in proxy URL logs.
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent"
        )
        payload = self.build_payload(system=system, user=user, schema=schema)
        body = json.dumps(payload).encode("utf-8")
        self.last_attempts = []
        response = self._post_with_retry(url, body)
        data = response.json()
        try:
            content = data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError) as exc:
            raise InvalidModelOutputError("gemini response missing content") from exc
        return _parse_json_content(str(content))

    def _post_with_retry(self, url: str, body: bytes) -> httpx.Response:
        """POST with bounded retry on 500/502/503/504; other errors raise immediately."""
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": self.api_key,
        }
        for attempt in range(1, self.max_attempts + 1):
            started = self._clock()
            record: dict[str, Any] = {
                "attempt": attempt,
                "model": self.model,
                "request_bytes": len(body),
                "http_status": None,
                "error_status": None,
                "error_message": None,
                "duration_ms": 0,
            }
            self.last_attempts.append(record)
            try:
                with httpx.Client(transport=self._transport, timeout=60.0) as client:
                    response = client.post(url, headers=headers, content=body)
            except (httpx.TimeoutException, httpx.NetworkError, httpx.TransportError) as exc:
                record["duration_ms"] = int((self._clock() - started) * 1000)
                record["error_status"] = f"transport:{type(exc).__name__}"
                raise TransientProviderError(
                    f"gemini transport: {type(exc).__name__} (attempt {attempt})"
                ) from None
            record["duration_ms"] = int((self._clock() - started) * 1000)
            record["http_status"] = response.status_code
            if response.status_code < 400:
                return response
            record["error_status"], record["error_message"] = parse_provider_error(
                response.text
            )
            try:
                _raise_for_provider_http("gemini", response.status_code, response.text)
            except QuotaExhaustedError:
                raise
            except TransientProviderError as exc:
                retryable = response.status_code in RETRYABLE_GEMINI_STATUSES
                logger.warning(
                    "gemini attempt %d/%d failed: model=%s http_status=%s "
                    "error_status=%s error_message=%s request_bytes=%d duration_ms=%d",
                    attempt,
                    self.max_attempts,
                    self.model,
                    response.status_code,
                    record["error_status"],
                    record["error_message"],
                    len(body),
                    record["duration_ms"],
                )
                if not retryable or attempt >= self.max_attempts:
                    raise TransientProviderError(
                        f"{exc} (attempts={attempt})",
                        status_code=exc.status_code,
                        provider_status=exc.provider_status,
                    ) from None
                retry_after = parse_retry_after(response.headers.get("retry-after"))
                delay = (
                    retry_after
                    if retry_after is not None
                    else backoff_delay(attempt, self._rng)
                )
                record["retry_delay_s"] = round(delay, 3)
                self._sleep(delay)
        raise AssertionError("unreachable")  # pragma: no cover


class GroqProvider(EvaluationProvider):
    name = "groq"

    def __init__(
        self,
        api_key: str,
        model: str = "llama-3.3-70b-versatile",
        transport: httpx.BaseTransport | None = None,
    ):
        self.api_key = api_key
        self.model = model
        self._transport = transport

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        payload = {
            "model": self.model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": user + "\n\nJSON schema:\n" + json.dumps(schema),
                },
            ],
        }
        try:
            with httpx.Client(transport=self._transport, timeout=60.0) as client:
                response = client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
        except (httpx.TimeoutException, httpx.NetworkError, httpx.TransportError) as exc:
            raise TransientProviderError(f"groq transport: {type(exc).__name__}") from None
        _raise_for_provider_http("groq", response.status_code, response.text)
        data = response.json()
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise InvalidModelOutputError("groq response missing content") from exc
        return _parse_json_content(str(content))


class FallbackEvaluationProvider(EvaluationProvider):
    """Try configured providers in order on quota / rate-limit / transient errors."""

    def __init__(self, providers: list[EvaluationProvider]):
        if not providers:
            raise AdapterError("FallbackEvaluationProvider requires providers", category="validation")
        self.providers = list(providers)
        self._active = self.providers[0].name

    @property
    def name(self) -> str:
        return self._active

    @property
    def provider_names(self) -> list[str]:
        return [p.name for p in self.providers]

    def complete_json(
        self,
        *,
        system: str,
        user: str,
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        errors: list[str] = []
        for provider in self.providers:
            try:
                result = provider.complete_json(system=system, user=user, schema=schema)
                self._active = provider.name
                return result
            except TransientProviderError as exc:
                errors.append(f"{provider.name}:{exc}")
                logger.warning(
                    "LLM provider %s transient failure (%s); trying next if available",
                    provider.name,
                    sanitize_error_text(str(exc), limit=240),
                )
                continue
            except InvalidModelOutputError as exc:
                # Malformed payload from one vendor — try next configured provider.
                errors.append(f"{provider.name}:invalid_output")
                logger.warning(
                    "LLM provider %s returned invalid output (%s); trying next",
                    provider.name,
                    type(exc).__name__,
                )
                continue
        raise AllProvidersUnavailableError(
            "all LLM providers unavailable: " + "; ".join(errors[:6])
        )


def configured_providers(
    *,
    transport: httpx.BaseTransport | None = None,
) -> list[EvaluationProvider]:
    """Return configured providers in default preference order (gemini → groq → openai)."""
    override = (os.environ.get("AUTO_DISCOVERY_LLM_PROVIDER") or "").strip().lower()
    gemini_key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    groq_key = (os.environ.get("GROQ_API_KEY") or "").strip()
    openai_key = (os.environ.get("OPENAI_API_KEY") or "").strip()

    available: dict[str, EvaluationProvider] = {}
    if gemini_key:
        available["gemini"] = GeminiProvider(gemini_key, transport=transport)
    if groq_key:
        available["groq"] = GroqProvider(groq_key, transport=transport)
    if openai_key:
        available["openai"] = OpenAIProvider(
            openai_key,
            model=(os.environ.get("OPENAI_MODEL") or "gpt-4.1-mini").strip(),
            transport=transport,
        )

    if override:
        if override not in available:
            raise AdapterError(
                f"AUTO_DISCOVERY_LLM_PROVIDER={override} but no matching API key",
                category="validation",
            )
        return [available[override]]

    ordered: list[EvaluationProvider] = []
    for name in ("gemini", "groq", "openai"):
        if name in available:
            ordered.append(available[name])
    return ordered


def resolve_provider(
    *,
    transport: httpx.BaseTransport | None = None,
) -> EvaluationProvider:
    """Resolve a provider with runtime fallback across all configured keys."""
    providers = configured_providers(transport=transport)
    if not providers:
        raise AdapterError(
            "no LLM API key configured (GEMINI_API_KEY / GROQ_API_KEY / OPENAI_API_KEY)",
            category="validation",
        )
    if len(providers) == 1:
        return providers[0]
    return FallbackEvaluationProvider(providers)
