"""OpenAI Responses API job discovery client (network-isolated via injection)."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Callable, Protocol

from .prompt import DISCOVERY_JSON_SCHEMA, build_discovery_prompt

logger = logging.getLogger(__name__)

CreateResponseFn = Callable[..., Any]

ALLOWED_REMOTE_STATUSES = frozenset({"", "Remote", "Hybrid", "Onsite"})
_POSTED_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class DiscoveryError(RuntimeError):
    """Base error for discovery failures."""


class DiscoveryConfigError(DiscoveryError):
    """Missing or invalid discovery configuration."""


class DiscoveryValidationError(DiscoveryError):
    """Model output failed schema / business validation."""


class JobDiscoveryClient(Protocol):
    def discover_jobs(self) -> dict[str, Any]:
        """Return ``{\"jobs\": [...]}`` raw discovery payload."""


@dataclass(frozen=True)
class OpenAIDiscoveryConfig:
    api_key: str
    model: str
    max_jobs: int = 100
    timeout_seconds: float = 180.0
    max_retries: int = 2

    @classmethod
    def from_env(cls) -> "OpenAIDiscoveryConfig":
        api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
        if not api_key:
            raise DiscoveryConfigError("OPENAI_API_KEY is required for job discovery")

        model = (os.environ.get("OPENAI_MODEL") or "").strip()
        if not model:
            raise DiscoveryConfigError("OPENAI_MODEL is required for job discovery")

        max_jobs_raw = (os.environ.get("DISCOVERY_MAX_JOBS") or "100").strip()
        try:
            max_jobs = int(max_jobs_raw)
        except ValueError as exc:
            raise DiscoveryConfigError("DISCOVERY_MAX_JOBS must be an integer") from exc
        if max_jobs < 0:
            raise DiscoveryConfigError("DISCOVERY_MAX_JOBS must be >= 0")

        timeout_raw = (os.environ.get("DISCOVERY_TIMEOUT_SECONDS") or "180").strip()
        try:
            timeout_seconds = float(timeout_raw)
        except ValueError as exc:
            raise DiscoveryConfigError(
                "DISCOVERY_TIMEOUT_SECONDS must be a number"
            ) from exc

        retries_raw = (os.environ.get("DISCOVERY_MAX_RETRIES") or "2").strip()
        try:
            max_retries = int(retries_raw)
        except ValueError as exc:
            raise DiscoveryConfigError("DISCOVERY_MAX_RETRIES must be an integer") from exc

        return cls(
            api_key=api_key,
            model=model,
            max_jobs=max_jobs,
            timeout_seconds=timeout_seconds,
            max_retries=max(0, max_retries),
        )


def validate_discovery_payload(
    payload: Any,
    *,
    max_jobs: int = 100,
) -> dict[str, Any]:
    """Validate raw discovery JSON before any persistence.

    Raises DiscoveryValidationError on malformed payloads. Empty jobs is valid.
    """
    if not isinstance(payload, dict):
        raise DiscoveryValidationError("Discovery payload must be a JSON object")

    if "jobs" not in payload:
        raise DiscoveryValidationError("Discovery payload must include a 'jobs' list")

    jobs = payload.get("jobs")
    if not isinstance(jobs, list):
        raise DiscoveryValidationError("Discovery payload 'jobs' must be a list")

    if len(jobs) > max_jobs:
        raise DiscoveryValidationError(
            f"Discovery returned {len(jobs)} jobs which exceeds DISCOVERY_MAX_JOBS={max_jobs}"
        )

    required_fields = (
        "company",
        "title",
        "url",
        "location",
        "source",
        "description",
        "required_skills",
        "preferred_skills",
        "remote_status",
        "salary",
        "posted_date",
    )
    normalized_jobs: list[dict[str, Any]] = []
    for index, raw in enumerate(jobs):
        if not isinstance(raw, dict):
            raise DiscoveryValidationError(f"Job at index {index} must be an object")
        missing = [field for field in required_fields if field not in raw]
        if missing:
            raise DiscoveryValidationError(
                f"Job at index {index} missing fields: {', '.join(missing)}"
            )
        for field in (
            "company",
            "title",
            "url",
            "location",
            "source",
            "description",
            "remote_status",
            "salary",
            "posted_date",
        ):
            if not isinstance(raw[field], str):
                raise DiscoveryValidationError(
                    f"Job at index {index} field '{field}' must be a string"
                )
        for field in ("required_skills", "preferred_skills"):
            value = raw[field]
            if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                raise DiscoveryValidationError(
                    f"Job at index {index} field '{field}' must be a list of strings"
                )

        remote_status = raw["remote_status"]
        if remote_status not in ALLOWED_REMOTE_STATUSES:
            raise DiscoveryValidationError(
                f"Job at index {index} remote_status must be one of "
                f"{sorted(ALLOWED_REMOTE_STATUSES)!r} (got {remote_status!r})"
            )

        posted_date = raw["posted_date"]
        if posted_date != "":
            if not _POSTED_DATE_RE.fullmatch(posted_date):
                raise DiscoveryValidationError(
                    f"Job at index {index} posted_date must be YYYY-MM-DD or \"\" "
                    f"(got {posted_date!r})"
                )
            try:
                date.fromisoformat(posted_date)
            except ValueError as exc:
                raise DiscoveryValidationError(
                    f"Job at index {index} posted_date is not a valid calendar date: "
                    f"{posted_date!r}"
                ) from exc

        # Reject discovery payloads that try to smuggle scoring into raw JSON.
        for forbidden in ("match_score", "score", "recommendation", "candidate_score"):
            if forbidden in raw:
                raise DiscoveryValidationError(
                    f"Job at index {index} must not include '{forbidden}' "
                    "(discovery must not score candidates)"
                )
        normalized_jobs.append({field: raw[field] for field in required_fields})

    return {"jobs": normalized_jobs}


class OpenAIDiscoveryClient:
    """Discover current jobs via OpenAI Responses API + web_search.

    Network access is isolated behind ``create_response`` so unit tests never
    call OpenAI. Production constructs the official SDK client.
    """

    def __init__(
        self,
        config: OpenAIDiscoveryConfig,
        *,
        create_response: CreateResponseFn | None = None,
        sleep: Callable[[float], None] = time.sleep,
        discovery_date: str | None = None,
        time_zone: str | None = None,
        now: datetime | None = None,
    ):
        self.config = config
        self._create_response = create_response
        self._sleep = sleep
        self._discovery_date = discovery_date
        self._time_zone = time_zone
        self._now = now

    def discover_jobs(self) -> dict[str, Any]:
        raw_text = self._request_structured_json()
        try:
            payload = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            raise DiscoveryValidationError(
                "Discovery model returned invalid JSON"
            ) from exc
        return validate_discovery_payload(payload, max_jobs=self.config.max_jobs)

    def _request_structured_json(self) -> str:
        create = self._create_response or self._default_create_response
        prompt = build_discovery_prompt(
            discovery_date=self._discovery_date,
            time_zone=self._time_zone,
            now=self._now,
        )
        last_error: Exception | None = None

        attempts = self.config.max_retries + 1
        for attempt in range(1, attempts + 1):
            try:
                response = create(
                    model=self.config.model,
                    instructions=prompt,
                    input=(
                        "Find currently open matching jobs using web search and "
                        "return the structured jobs payload."
                    ),
                    tools=[{"type": "web_search"}],
                    tool_choice="auto",
                    text={
                        "format": {
                            "type": "json_schema",
                            "name": "jay_job_discovery",
                            "strict": True,
                            "schema": DISCOVERY_JSON_SCHEMA,
                        }
                    },
                    timeout=self.config.timeout_seconds,
                )
                text = _extract_output_text(response)
                if not text or not str(text).strip():
                    raise DiscoveryValidationError(
                        "Discovery model returned an empty structured response"
                    )
                logger.info(
                    "OpenAI discovery completed (model=%s, attempt=%s/%s)",
                    self.config.model,
                    attempt,
                    attempts,
                )
                return str(text).strip()
            except DiscoveryValidationError:
                raise
            except DiscoveryConfigError:
                raise
            except Exception as exc:  # noqa: BLE001 - retry transient SDK/network errors
                last_error = exc
                logger.warning(
                    "OpenAI discovery attempt %s/%s failed: %s",
                    attempt,
                    attempts,
                    type(exc).__name__,
                )
                if attempt < attempts:
                    self._sleep(min(2 ** (attempt - 1), 8))
                    continue
                break

        raise DiscoveryError(
            f"OpenAI discovery failed after {attempts} attempt(s): "
            f"{type(last_error).__name__ if last_error else 'unknown'}"
        ) from last_error

    def _default_create_response(self, **kwargs: Any) -> Any:
        try:
            from openai import OpenAI
        except ImportError as exc:  # pragma: no cover - dependency declared in requirements
            raise DiscoveryConfigError(
                "openai package is required for OpenAI discovery"
            ) from exc

        # Never log api_key. Construct client with timeout from config.
        client = OpenAI(
            api_key=self.config.api_key,
            timeout=self.config.timeout_seconds,
            max_retries=0,  # retries handled by this client
        )
        return client.responses.create(**kwargs)


def _extract_output_text(response: Any) -> str:
    text = getattr(response, "output_text", None)
    if isinstance(text, str) and text.strip():
        return text

    output = getattr(response, "output", None) or []
    chunks: list[str] = []
    for item in output:
        item_type = getattr(item, "type", None) or (
            item.get("type") if isinstance(item, dict) else None
        )
        if item_type != "message":
            continue
        contents = getattr(item, "content", None) or (
            item.get("content") if isinstance(item, dict) else None
        ) or []
        for part in contents:
            part_type = getattr(part, "type", None) or (
                part.get("type") if isinstance(part, dict) else None
            )
            if part_type in {"output_text", "text"}:
                value = getattr(part, "text", None) or (
                    part.get("text") if isinstance(part, dict) else None
                )
                if value:
                    chunks.append(str(value))
    return "".join(chunks)
