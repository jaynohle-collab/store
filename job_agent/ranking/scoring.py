"""Deterministic candidate match scoring (independent of canonical similarity)."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Protocol

from ..memory.fingerprint import normalize_title_key, title_similarity
from ..models.types import (
    JobSearchProfile,
    NormalizedJobPosting,
    RejectionConfig,
    ScoringWeights,
)
from ..utils.normalization import extract_seniority, normalize_text

SCORING_VERSION = "profile-v1"

# Aliases expand priority skills / JD text for deterministic overlap.
_SKILL_ALIASES: dict[str, tuple[str, ...]] = {
    "llm": ("llm", "large language model", "large language models"),
    "large language models": ("llm", "large language model", "large language models"),
    "large language model": ("llm", "large language model", "large language models"),
    "ai agents": (
        "ai agents",
        "ai agent",
        "agentic",
        "agent orchestration",
        "agents",
        "multi agent",
        "multi-agent",
    ),
    "agent orchestration": (
        "agent orchestration",
        "orchestrate agents",
        "agentic",
        "ai agents",
        "ai agent",
    ),
    "mcp": ("mcp", "model context protocol"),
    "rag": ("rag", "retrieval augmented generation"),
    "retrieval": ("retrieval", "retrieval augmented generation", "rag"),
    "ai infrastructure": ("ai infrastructure", "ml infrastructure", "model serving"),
    "distributed systems": ("distributed systems", "distributed system", "distributed"),
    "backend systems": ("backend systems", "backend", "back end", "back-end", "services", "apis"),
    "cloud platforms": ("cloud platforms", "cloud", "aws", "gcp", "azure"),
    "developer productivity": (
        "developer productivity",
        "developer tooling",
        "developer tools",
        "dev productivity",
    ),
    "healthcare ai": ("healthcare ai", "health ai", "clinical ai"),
    "enterprise ai": ("enterprise ai",),
    "langgraph": ("langgraph",),
}

_AI_CORE_SKILL_KEYS = {
    "llm",
    "large language models",
    "large language model",
    "ai agents",
    "agent orchestration",
    "mcp",
    "rag",
    "retrieval",
    "ai infrastructure",
    "healthcare ai",
    "enterprise ai",
    "langgraph",
}

_AI_TITLE_MARKERS = {
    "ai",
    "llm",
    "agent",
    "agents",
    "generative",
    "ml",
    "machine",
    "intelligence",
    "langgraph",
}

_BACKEND_SIGNALS = (
    "backend",
    "back-end",
    "back end",
    "platform",
    "distributed systems",
    "distributed system",
    "distributed",
    "api",
    "apis",
    "services",
    "microservice",
    "microservices",
    "infrastructure",
    "production",
    "reliability",
    "scale",
    "scalable",
    "scaling",
    "cloud",
    "developer tooling",
    "developer tools",
    "developer productivity",
    "ownership",
    "architecture",
    "architect",
    "design",
)

_FRONTEND_ONLY_TITLE = re.compile(
    r"\b("
    r"frontend|front[- ]end|front end|"
    r"ui engineer|ui developer|"
    r"react (engineer|developer)|"
    r"angular (engineer|developer)|"
    r"vue (engineer|developer)"
    r")\b",
    re.IGNORECASE,
)

_BACKEND_OR_AI_TITLE = re.compile(
    r"\b("
    r"backend|back[- ]end|full[- ]?stack|"
    r"ai|llm|agent|agents|platform|infrastructure|"
    r"machine learning|ml|generative"
    r")\b",
    re.IGNORECASE,
)

_PURE_OPS_TITLE = re.compile(
    r"\b("
    r"site reliability( engineer)?|"
    r"\bsre\b|"
    r"devops( engineer)?|"
    r"dev ops( engineer)?"
    r")\b",
    re.IGNORECASE,
)

_AI_OR_PLATFORM_TITLE = re.compile(
    r"\b("
    r"ai|llm|agent|agents|machine learning|ml|"
    r"generative|platform engineer|infrastructure engineer|"
    r"agent platform"
    r")\b",
    re.IGNORECASE,
)

_NYC_LOCATION = re.compile(
    r"\b(new york|nyc|brooklyn|manhattan|queens|bronx)\b",
    re.IGNORECASE,
)


class ScoreCalculator(Protocol):
    def score(self, posting: NormalizedJobPosting, profile: JobSearchProfile) -> float:
        """Score a normalized posting against the search profile."""


@dataclass(frozen=True)
class ScoreBreakdown:
    role_fit: float
    ai_technical_fit: float
    backend_platform_production: float
    seniority: float
    remote_location: float
    hard_reject: bool
    total: float
    reject_reason: str | None = None

    def as_dict(self) -> dict[str, float | bool | str | None]:
        return asdict(self)


@dataclass
class SimpleScoreCalculator:
    """Baseline scoring implementation for job match quality."""

    def score(self, posting: NormalizedJobPosting, profile: JobSearchProfile) -> float:
        score = 0.0
        if profile.location and posting.location:
            score += 10.0 if profile.location.lower() == posting.location.lower() else 0.0
        if profile.keywords:
            keyword_matches = sum(
                1
                for keyword in profile.keywords
                if keyword.lower() in posting.title.lower()
                or keyword.lower() in (posting.description or "").lower()
            )
            score += float(keyword_matches) * 2.0
        if posting.remote:
            score += 5.0
        return score


@dataclass
class ProfileScoreCalculator:
    """Deterministic 0-100 candidate match scorer (profile-v1).

    Completely independent of canonical/lifecycle similarity.
    No LLM calls.
    """

    def score(self, posting: NormalizedJobPosting, profile: JobSearchProfile) -> float:
        return self.score_detailed(posting, profile).total

    def score_detailed(
        self, posting: NormalizedJobPosting, profile: JobSearchProfile
    ) -> ScoreBreakdown:
        weights = profile.weights or ScoringWeights()
        reject = profile.reject or RejectionConfig()

        reject_reason = self._hard_reject_reason(posting, reject)
        if reject_reason:
            return ScoreBreakdown(
                role_fit=0.0,
                ai_technical_fit=0.0,
                backend_platform_production=0.0,
                seniority=0.0,
                remote_location=0.0,
                hard_reject=True,
                total=0.0,
                reject_reason=reject_reason,
            )

        role_fit = self._score_role_fit(posting.title, profile.target_roles or [], weights.role_fit)
        ai_fit = self._score_ai_technical_fit(
            posting.title,
            posting.description,
            profile.priority_skills or profile.keywords or [],
            weights.ai_technical_fit,
        )
        backend = self._score_backend_platform(
            posting.title,
            posting.description,
            weights.backend_platform_production,
        )
        seniority = self._score_seniority(posting.title, weights.seniority)
        remote = self._score_remote_location(posting, weights.remote_location)

        total = round(role_fit + ai_fit + backend + seniority + remote, 1)
        total = max(0.0, min(100.0, total))
        return ScoreBreakdown(
            role_fit=round(role_fit, 1),
            ai_technical_fit=round(ai_fit, 1),
            backend_platform_production=round(backend, 1),
            seniority=round(seniority, 1),
            remote_location=round(remote, 1),
            hard_reject=False,
            total=total,
        )

    def _hard_reject_reason(
        self, posting: NormalizedJobPosting, reject: RejectionConfig
    ) -> str | None:
        title = posting.title or ""
        seniority = extract_seniority(title)

        if reject.internship and (
            seniority == "intern" or re.search(r"\bintern(ship)?\b", title, re.I)
        ):
            return "internship"
        if reject.junior and (
            seniority == "junior" or re.search(r"\b(junior|jr\.?)\b", title, re.I)
        ):
            return "junior"
        if reject.entry_level and re.search(
            r"\b(entry[- ]level|entry level|graduate)\b", title, re.I
        ):
            return "entry_level"

        if reject.frontend_only and self._is_frontend_only(title):
            return "frontend_only"

        if reject.pure_devops_sre and self._is_pure_ops(title):
            return "pure_devops_sre"

        if reject.nyc_onsite_only and self._is_nyc_onsite_only(posting):
            return "nyc_onsite_only"

        return None

    def _is_frontend_only(self, title: str) -> bool:
        if not _FRONTEND_ONLY_TITLE.search(title):
            return False
        return _BACKEND_OR_AI_TITLE.search(title) is None

    def _is_pure_ops(self, title: str) -> bool:
        if not _PURE_OPS_TITLE.search(title):
            return False
        return _AI_OR_PLATFORM_TITLE.search(title) is None

    def _is_nyc_onsite_only(self, posting: NormalizedJobPosting) -> bool:
        location = posting.location or ""
        if not _NYC_LOCATION.search(location):
            return False
        status = self._effective_remote_status(posting)
        return status == "Onsite"

    def _effective_remote_status(self, posting: NormalizedJobPosting) -> str | None:
        raw = (posting.remote_status or "").strip()
        if raw:
            lowered = raw.lower()
            if lowered == "remote":
                return "Remote"
            if lowered == "hybrid":
                return "Hybrid"
            if lowered in {"onsite", "on-site", "on site"}:
                return "Onsite"
            return raw
        if posting.remote:
            return "Remote"
        location = (posting.location or "").lower()
        if "remote" in location:
            return "Remote"
        if "hybrid" in location:
            return "Hybrid"
        if posting.location:
            return "Onsite"
        return None

    def _score_role_fit(self, title: str, target_roles: list[str], max_points: float) -> float:
        if not target_roles or max_points <= 0:
            return 0.0

        title_key = normalize_title_key(title)
        title_tokens = set(title_key.split())
        seniority_tokens = {"senior", "staff", "principal", "lead", "junior", "jr", "sr"}
        title_core = title_tokens - seniority_tokens
        best = 0.0

        for role in target_roles:
            role_key = normalize_title_key(role)
            role_tokens = set(role_key.split())
            role_core = role_tokens - seniority_tokens
            sim = title_similarity(title_key, role_key)
            if role_core and role_core.issubset(title_core):
                containment = 1.0
            elif role_core:
                containment = len(role_core & title_core) / len(role_core)
            else:
                containment = 0.0
            match = max(sim, containment)

            # Soft-cap AI-named target roles when the title lacks AI-family markers,
            # unless the title already strongly matches that configured role family
            # (e.g. "Agent Platform", "Forward Deployed") without needing the word "AI".
            distinctive = role_core - {"engineer", "developer", "software"}
            strong_family = bool(distinctive) and distinctive.issubset(title_core)
            if (
                (role_core & _AI_TITLE_MARKERS)
                and not (title_core & _AI_TITLE_MARKERS)
                and not strong_family
            ):
                match *= 0.35

            best = max(best, match)

        return max_points * best

    def _score_ai_technical_fit(
        self,
        title: str,
        description: str | None,
        priority_skills: list[str],
        max_points: float,
    ) -> float:
        if not priority_skills or max_points <= 0:
            return 0.0

        haystack = normalize_text(f"{title} {description or ''}")
        ai_hits = 0
        platform_hits = 0
        for skill in priority_skills:
            key = skill.strip().lower()
            if not key:
                continue
            aliases = _SKILL_ALIASES.get(key, (key,))
            if any(self._phrase_in_text(alias, haystack) for alias in aliases):
                if key in _AI_CORE_SKILL_KEYS:
                    ai_hits += 1
                else:
                    platform_hits += 1

        # Soft targets: ~5 distinct AI skills and ~3 platform skills for full credit.
        ai_ratio = min(1.0, ai_hits / 5.0)
        platform_ratio = min(1.0, platform_hits / 3.0)
        # AI skills dominate this component; platform skills fill the remainder.
        blended = (0.8 * ai_ratio) + (0.2 * platform_ratio)
        return max_points * blended

    def _score_backend_platform(
        self, title: str, description: str | None, max_points: float
    ) -> float:
        if max_points <= 0:
            return 0.0
        if self._is_frontend_only(title):
            return 0.0

        haystack = normalize_text(f"{title} {description or ''}")
        hits = sum(1 for signal in _BACKEND_SIGNALS if self._phrase_in_text(signal, haystack))
        # ~8 distinct production/platform signals => full score
        ratio = min(1.0, hits / 8.0)
        return max_points * ratio

    def _score_seniority(self, title: str, max_points: float) -> float:
        if max_points <= 0:
            return 0.0
        seniority = extract_seniority(title)
        if seniority in {"principal", "staff"}:
            return max_points
        if seniority == "senior":
            return max_points * 0.85
        if seniority == "lead":
            return max_points * 0.7
        if seniority in {"junior", "intern"}:
            return 0.0
        # Unspecified / other — partial/neutral
        return max_points * 0.45

    def _score_remote_location(self, posting: NormalizedJobPosting, max_points: float) -> float:
        if max_points <= 0:
            return 0.0
        status = self._effective_remote_status(posting)
        if status == "Remote":
            return max_points
        if status == "Hybrid":
            return max_points * 0.5
        if status == "Onsite":
            # US onsite outside NYC hard-reject path — small/neutral.
            location = normalize_text(posting.location)
            if location in {"us", "united states", "usa", "u s"} or "united states" in location:
                return max_points * 0.25
            return max_points * 0.2
        # Unknown
        if posting.remote:
            return max_points
        return max_points * 0.15

    @staticmethod
    def _phrase_in_text(phrase: str, haystack: str) -> bool:
        normalized = normalize_text(phrase)
        if not normalized:
            return False
        if " " in normalized:
            return normalized in haystack
        return bool(re.search(rf"\b{re.escape(normalized)}\b", haystack))
