"""Provider-neutral LLM clients for gpt-fit-v2 evaluation.

Runtime fallback: when multiple API keys are configured, quota / rate-limit /
transient failures try the next provider. Selection is not first-key-only.
"""

from __future__ import annotations

import json
import logging
import os
from abc import ABC, abstractmethod
from typing import Any

import httpx

from job_agent.auto_discovery.types import AdapterError

logger = logging.getLogger(__name__)


class TransientProviderError(Exception):
    """Provider failure that is safe to retry on the next configured provider."""


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
    lower = (body or "").lower()
    if status == 402:
        raise QuotaExhaustedError(f"{provider} HTTP {status}")
    if status == 429:
        # Rate-limit and quota both warrant trying the next provider.
        raise QuotaExhaustedError(f"{provider} HTTP 429")
    if "quota" in lower and status in (403, 503):
        raise QuotaExhaustedError(f"{provider} HTTP {status}")
    if status in {500, 502, 503, 504}:
        raise TransientProviderError(f"{provider} HTTP {status}")
    if status >= 400:
        raise AdapterError(
            f"{provider} HTTP {status}",
            category="validation",
            status_code=status,
        )


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
        model: str = "gemini-2.0-flash",
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
        # Prefer header auth so the key is less likely to appear in proxy URL logs.
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model}:generateContent"
        )
        payload = {
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
        try:
            with httpx.Client(transport=self._transport, timeout=60.0) as client:
                response = client.post(
                    url,
                    headers={
                        "Content-Type": "application/json",
                        "x-goog-api-key": self.api_key,
                    },
                    json=payload,
                )
        except (httpx.TimeoutException, httpx.NetworkError, httpx.TransportError) as exc:
            raise TransientProviderError(f"gemini transport: {type(exc).__name__}") from None
        _raise_for_provider_http("gemini", response.status_code, response.text)
        data = response.json()
        try:
            content = data["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError) as exc:
            raise InvalidModelOutputError("gemini response missing content") from exc
        return _parse_json_content(str(content))


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
                    "LLM provider %s transient failure; trying next if available",
                    provider.name,
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
