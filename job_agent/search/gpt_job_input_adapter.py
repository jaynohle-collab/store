from __future__ import annotations
from dataclasses import dataclass
from typing import Any

from .interfaces import JobSearchProvider
from ..models.types import JobInput, JobSearchProfile


class GPTJobInputValidationError(ValueError):
    """Raised when a GPT-generated job input is invalid."""


@dataclass
class GPTJobInputAdapter:
    """Convert external GPT job output into validated JobInput objects."""

    required_fields: tuple[str, ...] = ("company", "title", "url", "description")

    def adapt(self, raw_jobs: list[dict[str, Any]]) -> list[JobInput]:
        """Convert and validate GPT job output into JobInput objects."""
        adapted: list[JobInput] = []

        for raw in raw_jobs:
            try:
                job = self._validate_one(raw)
                adapted.append(job)
            except GPTJobInputValidationError:
                continue

        return adapted

    def _validate_one(self, raw: dict[str, Any]) -> JobInput:
        missing = [field for field in self.required_fields if not self._has_value(raw, field)]
        if missing:
            raise GPTJobInputValidationError(f"Missing required field(s): {', '.join(missing)}")

        return JobInput(
            company=self._clean_string(raw["company"]),
            title=self._clean_string(raw["title"]),
            url=self._clean_string(raw["url"]),
            description=self._clean_string(raw["description"]),
            source=self._clean_string(raw.get("source", "gpt-search")),
            location=self._clean_string(raw.get("location")),
            metadata={k: str(v) for k, v in raw.get("metadata", {}).items()} if isinstance(raw.get("metadata"), dict) else None,
            external_job_id=self._extract_external_id(raw),
            posted_date=self._parse_posted_date(raw.get("posted_date")),
        )

    def _extract_external_id(self, raw: dict[str, Any]) -> str | None:
        for key in (
            "external_job_id",
            "external_id",
            "job_id",
            "greenhouse_id",
            "lever_id",
            "ashby_id",
            "linkedin_job_id",
            "requisition_id",
        ):
            value = raw.get(key)
            if value is not None and str(value).strip():
                return str(value).strip()
        metadata = raw.get("metadata")
        if isinstance(metadata, dict):
            for key in (
                "external_job_id",
                "external_id",
                "job_id",
                "greenhouse_id",
                "lever_id",
                "ashby_id",
                "linkedin_job_id",
            ):
                value = metadata.get(key)
                if value is not None and str(value).strip():
                    return str(value).strip()
        return None

    def _parse_posted_date(self, value: Any):
        from datetime import date

        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None

    def _has_value(self, raw: dict[str, Any], field: str) -> bool:
        value = raw.get(field)
        return value is not None and str(value).strip() != ""

    def _clean_string(self, value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, str):
            cleaned = value.strip()
            return cleaned if cleaned != "" else None
        return str(value).strip()


class GPTJobInputProvider(JobSearchProvider):
    """Provider that returns validated GPT-derived JobInput objects."""

    def __init__(self, job_inputs: list[JobInput]):
        self.job_inputs = job_inputs

    def search(self, profile: JobSearchProfile) -> list[JobInput]:
        return self.job_inputs
