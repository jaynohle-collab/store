"""Load and validate ``data/job_search_profile.json`` into ``JobSearchProfile``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..models.types import JobSearchProfile, RejectionConfig, ScoringWeights

REQUIRED_WEIGHT_KEYS = (
    "role_fit",
    "ai_technical_fit",
    "backend_platform_production",
    "seniority",
    "remote_location",
)


class ProfileLoadError(ValueError):
    """Raised when a job search profile file is missing or malformed."""


def load_job_search_profile(path: Path) -> JobSearchProfile:
    """Load a machine-readable job search profile from JSON.

    The JSON file is the production source of truth. Markdown profiles are
    documentation only and must not be parsed at runtime.
    """
    try:
        raw_text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ProfileLoadError(f"Unable to read job search profile: {path}") from exc

    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ProfileLoadError(f"Job search profile is not valid JSON: {path}") from exc

    if not isinstance(data, dict):
        raise ProfileLoadError("Job search profile must be a JSON object")

    profile_version = _require_str(data, "profile_version")
    target_roles = _require_str_list(data, "target_roles")
    priority_skills = _require_str_list(data, "priority_skills")
    preferred_locations = _require_str_list(data, "preferred_locations")
    preferred_seniority = _require_str_list(data, "preferred_seniority")
    remote_first = _require_bool(data, "remote_first")
    high_match_threshold = _require_number(data, "high_match_threshold")
    if not 0 <= high_match_threshold <= 100:
        raise ProfileLoadError("high_match_threshold must be between 0 and 100")

    reject = _parse_reject(data.get("reject"))
    weights = _parse_weights(data.get("weights"))

    location = preferred_locations[0] if preferred_locations else None
    candidate_name = str(data.get("candidate_name") or "Jay")

    return JobSearchProfile(
        candidate_name=candidate_name,
        keywords=list(priority_skills),
        location=location,
        remote=bool(remote_first),
        experience_level=preferred_seniority[0] if preferred_seniority else None,
        profile_version=profile_version,
        target_roles=target_roles,
        priority_skills=priority_skills,
        preferred_locations=preferred_locations,
        preferred_seniority=preferred_seniority,
        remote_first=remote_first,
        reject=reject,
        weights=weights,
        high_match_threshold=high_match_threshold,
    )


def _require_str(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ProfileLoadError(f"Missing or invalid string field: {key}")
    return value.strip()


def _require_bool(data: dict[str, Any], key: str) -> bool:
    value = data.get(key)
    if not isinstance(value, bool):
        raise ProfileLoadError(f"Missing or invalid boolean field: {key}")
    return value


def _require_number(data: dict[str, Any], key: str) -> float:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProfileLoadError(f"Missing or invalid numeric field: {key}")
    return float(value)


def _require_str_list(data: dict[str, Any], key: str) -> list[str]:
    value = data.get(key)
    if not isinstance(value, list) or not value:
        raise ProfileLoadError(f"Missing or empty list field: {key}")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ProfileLoadError(f"List field {key} must contain non-empty strings")
        result.append(item.strip())
    return result


def _parse_reject(value: Any) -> RejectionConfig:
    if not isinstance(value, dict):
        raise ProfileLoadError("reject must be an object")
    flags: dict[str, bool] = {}
    for key in (
        "junior",
        "entry_level",
        "internship",
        "frontend_only",
        "pure_devops_sre",
        "nyc_onsite_only",
    ):
        raw = value.get(key)
        if not isinstance(raw, bool):
            raise ProfileLoadError(f"reject.{key} must be a boolean")
        flags[key] = raw
    return RejectionConfig(**flags)


def _parse_weights(value: Any) -> ScoringWeights:
    if not isinstance(value, dict):
        raise ProfileLoadError("weights must be an object")

    parsed: dict[str, float] = {}
    for key in REQUIRED_WEIGHT_KEYS:
        raw = value.get(key)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ProfileLoadError(f"weights.{key} must be numeric")
        parsed[key] = float(raw)

    total = sum(parsed.values())
    if abs(total - 100.0) > 1e-6:
        raise ProfileLoadError(f"weights must sum to 100 (got {total})")

    return ScoringWeights(**parsed)
