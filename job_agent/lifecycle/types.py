from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from typing import Any


class PostingDisposition(str, Enum):
    SAME_POSTING = "SAME_POSTING"
    REPOST = "REPOST"
    NEW_JOB = "NEW_JOB"


@dataclass
class NormalizedLifecyclePosting:
    """Normalized posting ready for lifecycle classification."""

    company: str
    company_key: str
    title: str
    normalized_title: str
    role_family: str | None
    location: str | None
    normalized_location: str | None
    source: str
    url: str | None
    normalized_url: str | None
    external_job_id: str | None
    description: str | None
    description_hash: str | None
    remote_status: str | None
    salary: str | None
    posted_date: date | None
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class LifecycleClassification:
    disposition: PostingDisposition
    reason: str
    signals: list[str] = field(default_factory=list)
    canonical_job_id: str | None = None
    previous_posting_id: str | None = None
    matched_posting: dict[str, Any] | None = None
    matched_canonical: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "disposition": self.disposition.value,
            "reason": self.reason,
            "signals": list(self.signals),
            "canonical_job_id": self.canonical_job_id,
            "previous_posting_id": self.previous_posting_id,
        }


@dataclass
class PersistencePlan:
    """What the agent intends to persist — MCP executes blindly."""

    create_canonical: bool = False
    create_posting: bool = False
    update_posting_id: str | None = None
    touch_canonical_id: str | None = None
    is_repost: bool = False
    supersedes_posting_id: str | None = None
    disposition: PostingDisposition = PostingDisposition.NEW_JOB

    def to_dict(self) -> dict[str, Any]:
        return {
            "create_canonical": self.create_canonical,
            "create_posting": self.create_posting,
            "update_posting_id": self.update_posting_id,
            "touch_canonical_id": self.touch_canonical_id,
            "is_repost": self.is_repost,
            "supersedes_posting_id": self.supersedes_posting_id,
            "disposition": self.disposition.value,
        }


@dataclass
class DiscoveredJobResult:
    posting: NormalizedLifecyclePosting
    classification: LifecycleClassification
    persistence_plan: PersistencePlan
    match_score: float | None = None
    canonical_job: dict[str, Any] | None = None
    job_posting: dict[str, Any] | None = None
    persisted: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "disposition": self.classification.disposition.value,
            "reason": self.classification.reason,
            "signals": self.classification.signals,
            "canonical_job_id": self.classification.canonical_job_id,
            "previous_posting_id": self.classification.previous_posting_id,
            "match_score": self.match_score,
            "persistence_plan": self.persistence_plan.to_dict(),
            "persisted": self.persisted,
            "canonical_job": self.canonical_job,
            "job_posting": self.job_posting,
        }


def parse_iso_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date) and not isinstance(value, datetime):
        return datetime(value.year, value.month, value.day)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        try:
            return datetime.fromisoformat(text[:10])
        except ValueError:
            return None


def parse_iso_date(value: Any) -> date | None:
    dt = parse_iso_datetime(value)
    return dt.date() if dt else None
