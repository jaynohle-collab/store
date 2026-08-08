from __future__ import annotations

import hashlib
import re

COMMON_JOB_WORDS = {
    "and",
    "for",
    "with",
    "in",
    "to",
    "of",
    "the",
    "on",
    "a",
    "an",
    "at",
    "by",
    "from",
    "as",
    "or",
    "role",
    "position",
    "opening",
    "hiring",
    "opportunity",
    "job",
    "jobs",
    "opportunities",
}

COMPANY_SUFFIXES = {
    "inc",
    "incorporated",
    "llc",
    "ltd",
    "corp",
    "corporation",
    "co",
    "company",
    "gmbh",
    "plc",
}

TEXT_NORMALIZATION_REGEX = re.compile(r"[^\w\s]+")
WHITESPACE_NORMALIZATION_REGEX = re.compile(r"\s+")


def normalize_fingerprint_text(value: str | None) -> str:
    if not value:
        return ""

    normalized = value.lower()
    normalized = normalized.replace("&", " and ")
    normalized = TEXT_NORMALIZATION_REGEX.sub(" ", normalized)
    normalized = WHITESPACE_NORMALIZATION_REGEX.sub(" ", normalized).strip()
    return normalized


def normalize_company_key(company_name: str | None) -> str:
    normalized = normalize_fingerprint_text(company_name)
    for suffix in COMPANY_SUFFIXES:
        normalized = re.sub(rf"\b{re.escape(suffix)}\b", "", normalized)
    normalized = WHITESPACE_NORMALIZATION_REGEX.sub(" ", normalized).strip()
    return normalized


def normalize_title_key(title: str | None) -> str:
    normalized = normalize_fingerprint_text(title)
    tokens = [token for token in normalized.split() if token not in COMMON_JOB_WORDS]
    return " ".join(tokens)


def normalize_description_text(description: str | None) -> str:
    return normalize_fingerprint_text(description)


def compute_description_hash(description: str | None) -> str | None:
    normalized = normalize_description_text(description)
    if not normalized:
        return None
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def token_overlap(left: str | None, right: str | None) -> float:
    if not left or not right:
        return 0.0

    left_tokens = set(left.split())
    right_tokens = set(right.split())
    if not left_tokens or not right_tokens:
        return 0.0

    return len(left_tokens & right_tokens) / max(len(left_tokens), len(right_tokens))


def title_similarity(left: str | None, right: str | None) -> float:
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    return token_overlap(left, right)


def description_similarity(left: str | None, right: str | None) -> float:
    return token_overlap(left, right)
