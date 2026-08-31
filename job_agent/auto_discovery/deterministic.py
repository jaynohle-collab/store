"""Deterministic rejects before LLM evaluation."""

from __future__ import annotations

import re
from urllib.parse import urlparse

from .types import LightweightCandidate

CLOSED_TITLE_PATTERNS = (
    re.compile(r"\b(closed|filled|cancelled|canceled|no longer (accepting|available))\b", re.I),
    re.compile(r"\(\s*(filled|closed|expired)\s*\)", re.I),
    re.compile(r"\bposition (has been |was )?(filled|closed)\b", re.I),
    re.compile(r"\barchiv(e|ed|ing)\b", re.I),
)


def deterministic_reject_reason(candidate: LightweightCandidate) -> str | None:
    """Return a hard-rejection reason, or None if the candidate may proceed to LLM."""
    title = (candidate.title or "").strip()
    if not title:
        return "missing title"
    for pattern in CLOSED_TITLE_PATTERNS:
        if pattern.search(title):
            return "closed or filled title"

    url = (candidate.url or "").strip()
    if not url:
        return "missing url"
    parsed = urlparse(url)
    if parsed.scheme.lower() not in {"http", "https"}:
        return "non-http url"
    if not parsed.netloc:
        return "url missing host"

    has_external = bool((candidate.external_job_id or "").strip())
    has_identity = bool(url) and (has_external or bool(parsed.path.strip("/")))
    if not has_identity:
        return "missing posting identity"

    if not (candidate.company or "").strip():
        return "missing company"
    if not (candidate.source or "").strip():
        return "missing source"

    return None


def filter_deterministic(
    candidates: list[LightweightCandidate],
) -> tuple[list[LightweightCandidate], list[tuple[LightweightCandidate, str]]]:
    kept: list[LightweightCandidate] = []
    rejected: list[tuple[LightweightCandidate, str]] = []
    for candidate in candidates:
        reason = deterministic_reject_reason(candidate)
        if reason:
            rejected.append((candidate, reason))
        else:
            kept.append(candidate)
    return kept, rejected
