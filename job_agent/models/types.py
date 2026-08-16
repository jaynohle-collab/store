from __future__ import annotations
from dataclasses import dataclass, field
from datetime import date
from typing import FrozenSet

from ..utils.normalization import (
    extract_keyword_set,
    extract_role_family,
    extract_skill_set,
    normalize_location,
)


@dataclass(frozen=True)
class RejectionConfig:
    junior: bool = True
    entry_level: bool = True
    internship: bool = True
    frontend_only: bool = True
    pure_devops_sre: bool = True
    nyc_onsite_only: bool = True


@dataclass(frozen=True)
class ScoringWeights:
    role_fit: float = 25.0
    ai_technical_fit: float = 30.0
    backend_platform_production: float = 20.0
    seniority: float = 15.0
    remote_location: float = 10.0

    def total(self) -> float:
        return (
            self.role_fit
            + self.ai_technical_fit
            + self.backend_platform_production
            + self.seniority
            + self.remote_location
        )


@dataclass
class JobSearchProfile:
    candidate_name: str
    keywords: list[str]
    location: str | None = None
    remote: bool = False
    experience_level: str | None = None
    salary_range: tuple[int, int] | None = None
    preferred_sources: list[str] | None = None
    search_interval_days: int = 1
    reviewed_job_ids: list[int] | None = None
    # Optional machine-readable profile fields (backward compatible).
    profile_version: str | None = None
    target_roles: list[str] | None = None
    priority_skills: list[str] | None = None
    preferred_locations: list[str] | None = None
    preferred_seniority: list[str] | None = None
    remote_first: bool = False
    reject: RejectionConfig | None = None
    weights: ScoringWeights | None = None
    high_match_threshold: float | None = None


@dataclass
class JobInput:
    company: str
    title: str
    url: str | None
    description: str | None
    source: str
    location: str | None = None
    metadata: dict[str, str] | None = None
    external_job_id: str | None = None
    posted_date: date | None = None


@dataclass
class RawJobPosting:
    source: str
    raw_title: str
    raw_company: str
    raw_location: str | None
    raw_description: str | None
    raw_url: str | None
    raw_metadata: dict[str, str] | None = None


@dataclass
class JobDecision:
    match_score: float
    duplicate: bool
    recommendation: str
    reason: str
    confidence_score: float | None = None


@dataclass
class NormalizedJobPosting:
    title: str
    company_name: str
    location: str | None
    remote: bool
    description: str | None
    url: str | None
    source: str
    description_hash: str | None
    posted_date: date | None = None
    status: str = "new"
    match_score: float | None = None
    remote_status: str | None = None


@dataclass
class JobFingerprint:
    company_key: str
    normalized_title: str
    role_family: str | None
    keyword_set: FrozenSet[str]
    skill_set: FrozenSet[str]
    location_key: str | None
    description_hash: str | None
    normalized_description: str | None = None
    url: str | None = None
    company_name: str | None = None
    title: str | None = None

    @classmethod
    def from_job_input(cls, job_input: JobInput) -> "JobFingerprint":
        from ..memory.fingerprint import (
            compute_description_hash,
            normalize_company_key,
            normalize_description_text,
            normalize_title_key,
        )

        return cls(
            company_key=normalize_company_key(job_input.company),
            normalized_title=normalize_title_key(job_input.title),
            role_family=extract_role_family(job_input.title),
            keyword_set=frozenset(extract_keyword_set(job_input.title, job_input.description)),
            skill_set=frozenset(extract_skill_set(job_input.title, job_input.description)),
            location_key=normalize_location(job_input.location),
            description_hash=compute_description_hash(job_input.description),
            normalized_description=normalize_description_text(job_input.description),
            url=job_input.url,
            company_name=job_input.company,
            title=job_input.title,
        )

    @classmethod
    def from_normalized_posting(cls, posting: NormalizedJobPosting) -> "JobFingerprint":
        from ..memory.fingerprint import (
            normalize_company_key,
            normalize_description_text,
            normalize_title_key,
        )

        return cls(
            company_key=normalize_company_key(posting.company_name),
            normalized_title=normalize_title_key(posting.title),
            role_family=extract_role_family(posting.title),
            keyword_set=frozenset(extract_keyword_set(posting.title, posting.description)),
            skill_set=frozenset(extract_skill_set(posting.title, posting.description)),
            location_key=normalize_location(posting.location),
            description_hash=posting.description_hash,
            normalized_description=normalize_description_text(posting.description),
            url=posting.url,
            company_name=posting.company_name,
            title=posting.title,
        )


@dataclass
class DuplicateResult:
    is_duplicate: bool
    confidence_score: float
    matched_job_id: int | str | None
    reason: str
    # Soft signal: same company+title may indicate a canonical role / possible repost,
    # not an automatic discard.
    possible_canonical_match: bool = False


@dataclass
class JobMatch:
    job_input: JobInput
    posting: NormalizedJobPosting
    fingerprint: JobFingerprint
    decision: JobDecision
    memory_job_id: int | str | None = None
    saved: bool = False
