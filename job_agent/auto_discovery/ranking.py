"""Profile-aware lightweight listing ranking (before any full fetch or LLM call).

Flow per company:

1. Deterministic persona rejects on listing metadata (title/location only):
   internship/junior/entry, frontend-only, pure DevOps/SRE, NYC onsite-only,
   and locations that are explicitly outside the United States.
2. Novelty from stored evidence for the active profile generation:
   ``new`` (never evaluated), ``changed`` (listing hash differs or the ATS
   reports an update after the stored evaluation), ``unchanged`` (evidence is
   reusable — skipped without LLM), ``qualified_unsubmitted`` (stored QUALIFIED
   evidence never attached to an inbox batch — resubmitted without LLM), and
   ``cooldown`` (recently selected but produced no evidence — demoted so it
   cannot starve other candidates).
3. Deterministic rank: persona title/location score + freshness, ties broken by
   a stable identity key. ATS return order never influences selection.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

from job_agent.auto_discovery.types import LightweightCandidate
from job_agent.lifecycle.url import normalize_url
from job_agent.models.types import JobSearchProfile, NormalizedJobPosting
from job_agent.ranking.scoring import ProfileScoreCalculator

NOVELTY_NEW = "new"
NOVELTY_CHANGED = "changed"
NOVELTY_UNCHANGED = "unchanged"
NOVELTY_QUALIFIED_UNSUBMITTED = "qualified_unsubmitted"
NOVELTY_COOLDOWN = "cooldown"

# Lower tier sorts first. Unchanged candidates are never selected.
_TIER = {
    NOVELTY_QUALIFIED_UNSUBMITTED: 0,
    NOVELTY_NEW: 1,
    NOVELTY_CHANGED: 1,
    NOVELTY_COOLDOWN: 2,
}

# Selection memory (persisted in the company's registry stats between runs).
SELECTION_MEMORY_KEY = "selection_memory"
SELECTION_MEMORY_MAX_ENTRIES = 300
COOLDOWN_DAYS = 7

OUTCOME_EVALUATED = "evaluated"
OUTCOME_REUSED = "reused"
OUTCOME_NO_EVIDENCE = "no_evidence"

_US_STATE_ABBR = (
    "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|"
    "MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY"
)
_US_STATE_RE = re.compile(rf"(?:,|\s-)\s*(?:{_US_STATE_ABBR})\b")
_US_MARKERS_RE = re.compile(
    r"\b("
    r"united states|usa|u\.s\.a?|us|america|"
    r"san francisco|bay area|new york|nyc|brooklyn|seattle|austin|boston|chicago|"
    r"los angeles|denver|atlanta|portland|san diego|san jose|palo alto|mountain view|"
    r"sunnyvale|menlo park|redwood city|oakland|miami|dallas|houston|phoenix|"
    r"salt lake|pittsburgh|philadelphia|raleigh|nashville|minneapolis|detroit|"
    r"washington|california|texas|colorado|massachusetts|illinois|virginia"
    r")\b",
    re.IGNORECASE,
)
_NON_US_MARKERS_RE = re.compile(
    r"\b("
    r"canada|toronto|vancouver|montreal|ontario|quebec|british columbia|"
    r"united kingdom|uk|england|scotland|london|manchester|edinburgh|ireland|dublin|"
    r"germany|berlin|munich|hamburg|france|paris|netherlands|amsterdam|spain|madrid|"
    r"barcelona|portugal|lisbon|poland|warsaw|krakow|italy|milan|rome|switzerland|"
    r"zurich|geneva|austria|vienna|belgium|brussels|sweden|stockholm|denmark|"
    r"copenhagen|norway|oslo|finland|helsinki|czech|prague|romania|bucharest|"
    r"ukraine|kyiv|serbia|belgrade|estonia|tallinn|luxembourg|greece|athens|"
    r"india|bangalore|bengaluru|hyderabad|pune|chennai|mumbai|delhi|gurgaon|noida|"
    r"singapore|japan|tokyo|korea|seoul|china|beijing|shanghai|shenzhen|hong kong|"
    r"taiwan|taipei|philippines|manila|vietnam|indonesia|jakarta|malaysia|thailand|"
    r"bangkok|australia|sydney|melbourne|new zealand|auckland|brazil|sao paulo|"
    r"são paulo|mexico|mexico city|cdmx|argentina|buenos aires|colombia|bogota|"
    r"chile|santiago|peru|lima|israel|tel aviv|uae|dubai|abu dhabi|saudi|riyadh|"
    r"south africa|cape town|nigeria|lagos|kenya|nairobi|egypt|cairo|turkey|istanbul|"
    r"emea|apac|latam|europe|european union|asia"
    r")\b",
    re.IGNORECASE,
)

_scorer = ProfileScoreCalculator()


@dataclass(frozen=True, slots=True)
class StoredEvaluationState:
    """Latest stored GPT evidence for a listing (active profile generation)."""

    evaluation_id: str
    gpt_decision: str
    description_hash: str
    evaluated_at: str
    submitted_to_inbox: bool

    @classmethod
    def from_lookup(cls, state: dict[str, Any]) -> "StoredEvaluationState | None":
        evaluation = state.get("evaluation")
        if not isinstance(evaluation, dict):
            return None
        return cls(
            evaluation_id=str(evaluation.get("evaluation_id") or ""),
            gpt_decision=str(evaluation.get("gpt_decision") or ""),
            description_hash=str(evaluation.get("description_hash") or ""),
            evaluated_at=str(
                evaluation.get("evaluated_at") or evaluation.get("created_at") or ""
            ),
            submitted_to_inbox=bool(state.get("submitted_to_inbox")),
        )


@dataclass(slots=True)
class RankedListing:
    candidate: LightweightCandidate
    key: str
    score: float
    profile_score: float
    freshness: float
    novelty: str
    reject_reason: str | None = None
    state: StoredEvaluationState | None = None

    @property
    def sort_key(self) -> tuple[int, float, str]:
        return (_TIER.get(self.novelty, 9), -round(self.score, 3), self.key)


@dataclass(slots=True)
class RankingResult:
    selected: list[RankedListing]
    ranked: list[RankedListing]
    rejected: list[RankedListing]
    unchanged: list[RankedListing]
    below_threshold: list[RankedListing]
    deferred: list[RankedListing]


def candidate_key(cand: LightweightCandidate) -> str:
    """Stable identity for ordering, dedupe and selection memory."""
    external = (cand.external_job_id or "").strip()
    if external:
        return f"{cand.source}:{external}"
    return f"url:{normalize_url(cand.url) or cand.url}"


def classify_location(location: str | None) -> str:
    """``us`` | ``non_us`` | ``unknown`` from free-text listing location."""
    text = (location or "").strip()
    if not text:
        return "unknown"
    if _US_MARKERS_RE.search(text) or _US_STATE_RE.search(text):
        return "us"
    if _NON_US_MARKERS_RE.search(text):
        return "non_us"
    return "unknown"


def _parse_date(value: str | None) -> date | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def _remote_status(location: str | None) -> str | None:
    lowered = (location or "").lower()
    if "remote" in lowered:
        return "Remote"
    if "hybrid" in lowered:
        return "Hybrid"
    return None


def persona_reject_reason(
    cand: LightweightCandidate, profile: JobSearchProfile
) -> str | None:
    posting = _as_posting(cand, include_description=False)
    breakdown = _scorer.score_detailed(posting, profile)
    if breakdown.hard_reject:
        return breakdown.reject_reason
    if classify_location(cand.location) == "non_us":
        return "incompatible_location"
    return None


def _as_posting(
    cand: LightweightCandidate, *, include_description: bool
) -> NormalizedJobPosting:
    status = _remote_status(cand.location)
    return NormalizedJobPosting(
        title=cand.title,
        company_name=cand.company,
        location=cand.location or None,
        remote=status == "Remote",
        description=cand.description if include_description else None,
        url=cand.url,
        source=cand.source,
        description_hash=None,
        posted_date=_parse_date(cand.posted_date),
        remote_status=status,
    )


def profile_score(cand: LightweightCandidate, profile: JobSearchProfile) -> float:
    """Persona match on lightweight metadata only (0–100)."""
    return _scorer.score_detailed(
        _as_posting(cand, include_description=False), profile
    ).total


def freshness_bonus(posted_date: str | None, today: date) -> float:
    posted = _parse_date(posted_date)
    if posted is None:
        return 1.0
    age = (today - posted).days
    if age <= 7:
        return 5.0
    if age <= 30:
        return 3.0
    if age <= 90:
        return 1.0
    return 0.0


def classify_novelty(
    cand: LightweightCandidate,
    state: StoredEvaluationState | None,
    memory: dict[str, Any] | None,
    today: date,
) -> str:
    if state is None:
        if memory and _in_cooldown(memory, today):
            return NOVELTY_COOLDOWN
        return NOVELTY_NEW

    listing_hash = (cand.description_hash or "").strip()
    if listing_hash:
        changed = listing_hash != state.description_hash
    else:
        posted = _parse_date(cand.posted_date)
        evaluated = _parse_date(state.evaluated_at)
        changed = bool(posted and evaluated and posted > evaluated)
        if changed and memory:
            # Already re-fetched this listing version and found identical content.
            remembered = _parse_date(str(memory.get("posted") or ""))
            if (
                memory.get("outcome") == OUTCOME_REUSED
                and remembered is not None
                and posted is not None
                and posted <= remembered
            ):
                changed = False

    if changed:
        if memory and _in_cooldown(memory, today):
            return NOVELTY_COOLDOWN
        return NOVELTY_CHANGED
    if state.gpt_decision == "QUALIFIED" and not state.submitted_to_inbox:
        return NOVELTY_QUALIFIED_UNSUBMITTED
    return NOVELTY_UNCHANGED


def _in_cooldown(memory: dict[str, Any], today: date) -> bool:
    if memory.get("outcome") != OUTCOME_NO_EVIDENCE:
        return False
    at = _parse_date(str(memory.get("at") or ""))
    return at is not None and (today - at).days < COOLDOWN_DAYS


def rank_listings(
    listings: Iterable[LightweightCandidate],
    *,
    profile: JobSearchProfile,
    states: dict[str, StoredEvaluationState],
    memory: dict[str, dict[str, Any]] | None,
    top_k: int,
    min_rank_score: float,
    today: date | None = None,
) -> RankingResult:
    """Rank and select the best ``top_k`` listings deterministically.

    ``states`` and ``memory`` are keyed by :func:`candidate_key`.
    """
    today = today or datetime.now(timezone.utc).date()
    memory = memory or {}

    by_key: dict[str, LightweightCandidate] = {}
    for cand in listings:
        key = candidate_key(cand)
        existing = by_key.get(key)
        # Deterministic dedupe independent of ATS order.
        if existing is None or (cand.url, cand.title) < (existing.url, existing.title):
            by_key[key] = cand

    rejected: list[RankedListing] = []
    unchanged: list[RankedListing] = []
    below: list[RankedListing] = []
    eligible: list[RankedListing] = []
    for key in sorted(by_key):
        cand = by_key[key]
        reason = persona_reject_reason(cand, profile)
        p_score = 0.0 if reason else profile_score(cand, profile)
        fresh = freshness_bonus(cand.posted_date, today)
        state = states.get(key)
        item = RankedListing(
            candidate=cand,
            key=key,
            score=round(p_score + fresh, 3),
            profile_score=p_score,
            freshness=fresh,
            novelty=classify_novelty(cand, state, memory.get(key), today),
            reject_reason=reason,
            state=state,
        )
        if reason:
            rejected.append(item)
        elif item.novelty == NOVELTY_UNCHANGED:
            unchanged.append(item)
        elif (
            item.novelty != NOVELTY_QUALIFIED_UNSUBMITTED
            and p_score < min_rank_score
        ):
            below.append(item)
        else:
            eligible.append(item)

    eligible.sort(key=lambda r: r.sort_key)
    k = max(0, int(top_k))
    return RankingResult(
        selected=eligible[:k],
        ranked=eligible,
        rejected=rejected,
        unchanged=unchanged,
        below_threshold=below,
        deferred=eligible[k:],
    )


def load_selection_memory(stats: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(stats, dict):
        return {}
    raw = stats.get(SELECTION_MEMORY_KEY)
    if not isinstance(raw, dict):
        return {}
    return {str(k): dict(v) for k, v in raw.items() if isinstance(v, dict)}


def remember(
    memory: dict[str, dict[str, Any]],
    key: str,
    *,
    outcome: str,
    posted_date: str | None,
    today: date,
) -> None:
    memory[key] = {
        "outcome": outcome,
        "posted": (posted_date or "")[:10],
        "at": today.isoformat(),
    }


def trim_selection_memory(
    memory: dict[str, dict[str, Any]], today: date
) -> dict[str, dict[str, Any]]:
    """Bound memory size; drop entries older than 180 days, keep most recent."""
    horizon = today - timedelta(days=180)
    kept = [
        (key, value)
        for key, value in memory.items()
        if (_parse_date(str(value.get("at") or "")) or today) >= horizon
    ]
    kept.sort(key=lambda kv: (str(kv[1].get("at") or ""), kv[0]), reverse=True)
    return dict(kept[:SELECTION_MEMORY_MAX_ENTRIES])
