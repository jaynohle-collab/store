from __future__ import annotations

import hashlib
import re

STOP_WORDS = {
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
}

TITLE_REPLACEMENTS = {
    r"\b(sr|sr\.|senior)\b": "senior",
    r"\b(jr|jr\.|junior)\b": "junior",
    r"\b(ai|artificial intelligence)\b": "artificial intelligence",
    r"\b(ml|machine learning)\b": "machine learning",
    r"\b(llm|large language model|large language models)\b": "large language model",
    r"\b(nlp|natural language processing)\b": "natural language processing",
    r"\b(gen(?:erative)? ai|generative artificial intelligence)\b": "generative ai",
    r"\b(rag|retrieval augmented generation)\b": "retrieval augmented generation",
}

SENIORITY_MAP = {
    "intern": "intern",
    "junior": "junior",
    "senior": "senior",
    "staff": "staff",
    "principal": "principal",
    "lead": "lead",
    "director": "director",
}

ROLE_FAMILY_KEYWORDS = {
    "engineer": "engineering",
    "developer": "engineering",
    "scientist": "science",
    "researcher": "research",
    "manager": "management",
    "architect": "architecture",
    "analyst": "analysis",
    "designer": "design",
    "specialist": "specialist",
    "operator": "operations",
}

SKILL_TERMS = {
    "artificial intelligence",
    "machine learning",
    "large language model",
    "natural language processing",
    "generative ai",
    "retrieval augmented generation",
    "deep learning",
    "python",
    "cloud",
    "infrastructure",
    "devops",
    "kubernetes",
    "docker",
    "agents",
    "agent",
    "rl",
    "reinforcement learning",
    "distributed",
    "scaling",
    "platform",
    "data",
    "research",
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
}

LOCATION_NORMALIZATION = {
    "usa": "us",
    "united states": "us",
    "u.s.": "us",
    "u.s.a.": "us",
    "remote": "remote",
}


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    normalized = value.lower()
    normalized = normalized.replace("&", " and ")
    normalized = re.sub(r"[^\w\s]+", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def normalize_company_name(company_name: str) -> str:
    normalized = normalize_text(company_name)
    for suffix in COMPANY_SUFFIXES:
        normalized = re.sub(rf"\b{re.escape(suffix)}\b", "", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def normalize_title(title: str) -> str:
    normalized = normalize_text(title)
    for pattern, replacement in TITLE_REPLACEMENTS.items():
        normalized = re.sub(pattern, replacement, normalized)
    tokens = [token for token in normalized.split() if token not in STOP_WORDS]
    return " ".join(tokens)


def extract_seniority(title: str) -> str | None:
    normalized = normalize_title(title)
    for token in normalized.split():
        if token in SENIORITY_MAP:
            return SENIORITY_MAP[token]
    return None


def extract_role_family(title: str) -> str | None:
    normalized = normalize_title(title)
    for pattern, family in ROLE_FAMILY_KEYWORDS.items():
        if re.search(rf"\b{re.escape(pattern)}\b", normalized):
            return family
    return None


def extract_keyword_set(title: str, description: str | None = None) -> set[str]:
    title_tokens = normalize_title(title).split()
    description_tokens = normalize_text(description).split() if description else []
    tokens = title_tokens + description_tokens
    exclude_tokens = set(STOP_WORDS) | set(SENIORITY_MAP.values()) | set(ROLE_FAMILY_KEYWORDS.keys())
    keywords = {
        token
        for token in tokens
        if token and token not in exclude_tokens and len(token) > 2
    }
    return keywords


def extract_skill_set(title: str, description: str | None = None) -> set[str]:
    normalized = normalize_title(title)
    if description:
        normalized = f"{normalized} {normalize_text(description)}"

    return {
        skill
        for skill in SKILL_TERMS
        if re.search(rf"\b{re.escape(skill)}\b", normalized)
    }


def normalize_location(location: str | None) -> str | None:
    if not location:
        return None
    normalized = normalize_text(location)
    for pattern, replacement in LOCATION_NORMALIZATION.items():
        normalized = re.sub(rf"\b{re.escape(pattern)}\b", replacement, normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized or None


def compute_description_hash(description: str | None) -> str | None:
    if not description:
        return None
    normalized = normalize_text(description)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
