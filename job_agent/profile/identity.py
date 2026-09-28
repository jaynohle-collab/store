"""Active persona identity (single source of truth: ``data/job_search_profile.json``).

Canonical jobs and postings are global. GPT evidence and ranking are
profile-specific: ``(profile_id, profile_version)`` is one *generation*. A new
profile version starts a new generation; older-generation evidence is kept and
never overwritten.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from ..models.types import JobSearchProfile
from .loader import DEFAULT_PROFILE_ID, load_job_search_profile

DEFAULT_PROFILE_PATH = (
    Path(__file__).resolve().parents[2] / "data" / "job_search_profile.json"
)

# Generation that produced all evidence recorded before profile identity was
# stored. Its deterministic evaluation ids keep the original seed so existing
# gpt-fit-v2 rows stay reusable; stored rows with NULL profile columns belong to it.
LEGACY_PROFILE_ID = DEFAULT_PROFILE_ID
LEGACY_PROFILE_VERSION = "jay-ai-v1"


@dataclass(frozen=True, slots=True)
class ProfileIdentity:
    profile_id: str
    profile_version: str

    @property
    def is_legacy_generation(self) -> bool:
        return (
            self.profile_id == LEGACY_PROFILE_ID
            and self.profile_version == LEGACY_PROFILE_VERSION
        )

    def evaluation_seed_suffix(self) -> str:
        """Suffix appended to deterministic evaluation-id seeds."""
        if self.is_legacy_generation:
            return ""
        return f"|profile:{self.profile_id}:{self.profile_version}"

    def as_filter(self) -> dict[str, object]:
        """MCP profile generation filter (lookup / preflight)."""
        return {
            "profile_id": self.profile_id,
            "profile_version": self.profile_version,
            "include_legacy_unversioned": self.is_legacy_generation,
        }

    def matches_stored(self, stored: dict[str, object]) -> bool:
        """Whether stored evidence belongs to this generation."""
        stored_id = stored.get("profile_id")
        stored_version = stored.get("profile_version")
        if stored_id is None and stored_version is None:
            return self.is_legacy_generation
        return (
            str(stored_id) == self.profile_id
            and str(stored_version) == self.profile_version
        )


def active_profile_path() -> Path:
    override = os.environ.get("JOB_SEARCH_PROFILE_PATH", "").strip()
    return Path(override) if override else DEFAULT_PROFILE_PATH


def load_active_profile(path: Path | None = None) -> JobSearchProfile:
    return load_job_search_profile(path or active_profile_path())


def identity_of(profile: JobSearchProfile) -> ProfileIdentity:
    return ProfileIdentity(
        profile_id=profile.profile_id or DEFAULT_PROFILE_ID,
        profile_version=str(profile.profile_version or LEGACY_PROFILE_VERSION),
    )


@lru_cache(maxsize=4)
def _profile_version_at(path: Path) -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        version = str(data.get("profile_version") or "").strip()
        return version or LEGACY_PROFILE_VERSION
    except (OSError, ValueError):
        return LEGACY_PROFILE_VERSION


def default_profile_version() -> str:
    """Version of the active persona file (fallback: legacy version)."""
    return _profile_version_at(active_profile_path())
