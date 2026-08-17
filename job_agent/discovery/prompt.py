"""Discovery-only prompt for OpenAI web search job finding."""

from __future__ import annotations

import os
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

DEFAULT_DISCOVERY_TIME_ZONE = "America/Los_Angeles"


def resolve_discovery_calendar_date(
    *,
    time_zone: str | None = None,
    now: datetime | None = None,
    discovery_date: str | None = None,
) -> tuple[str, str]:
    """Return ``(YYYY-MM-DD, time_zone_name)`` for discovery freshness.

    ``discovery_date`` and ``now`` are injectable so unit tests do not depend on
    the system clock.
    """
    tz_name = (
        (time_zone if time_zone is not None else os.environ.get("DISCOVERY_TIME_ZONE"))
        or DEFAULT_DISCOVERY_TIME_ZONE
    ).strip() or DEFAULT_DISCOVERY_TIME_ZONE

    if discovery_date is not None:
        date.fromisoformat(discovery_date)
        return discovery_date, tz_name

    instant = now if now is not None else datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    local_day = instant.astimezone(ZoneInfo(tz_name)).date().isoformat()
    return local_day, tz_name


def build_discovery_prompt(
    *,
    discovery_date: str | None = None,
    time_zone: str | None = None,
    now: datetime | None = None,
) -> str:
    """Return the instruction prompt for unattended daily job discovery.

    The model is a discovery layer only. It must not score, dedupe, classify
    reposts, or persist jobs — that remains the Python Job Agent's job.
    """
    today, tz_name = resolve_discovery_calendar_date(
        discovery_date=discovery_date,
        time_zone=time_zone,
        now=now,
    )
    return f"""You are the Jay Job discovery layer only.

Your sole job is to find CURRENT public job postings and extract raw job fields.
You MUST NOT:
- score candidates or rank fit
- decide duplicates
- decide reposts / SAME_POSTING / NEW_JOB
- persist jobs to any database, MCP, or storage system
- invent match scores, recommendations, or candidate reasoning

Today's discovery date is {today} in {tz_name}.

Freshness rules (calendar days in {tz_name}):
1) "posted today" means posted_date exactly equals {today}
2) if results are insufficient, include jobs posted in the previous 3 calendar days only
3) if still insufficient, expand to the previous 7 calendar days only
Never knowingly include future, expired, closed, filled, or archived jobs.

Search the public web for currently open roles matching:

Target roles:
- Senior AI Engineer
- Staff AI Engineer
- Principal AI Engineer
- AI Infrastructure Engineer
- Agent Platform Engineer
- Backend Engineer with AI focus
- Forward Deployed Engineer
- Generative AI Engineer
- LLM Platform Engineer

Technical priorities (prefer postings that mention several):
- LLMs / large language models
- AI agents / agent orchestration
- MCP (Model Context Protocol)
- RAG / retrieval systems
- AI infrastructure
- distributed backend systems
- cloud platforms
- developer productivity platforms
- healthcare AI
- enterprise AI

Candidate level: Senior, Staff, or Principal only.

Exclude:
- Junior / entry-level / internship
- frontend-only roles
- pure DevOps / pure SRE roles
- NYC onsite-only roles

Location preference:
- United States
- Remote / remote-first / remote-friendly preferred

Preferred sources when available:
- company career pages
- Greenhouse, Lever, Ashby
- LinkedIn public postings
- Wellfound, Built In, Indeed
- other public job boards

Prefer direct job posting URLs over search-result or listing-index URLs.

Return ONLY structured JSON matching the required schema.
For each job:
- company, title, url, location, source, description are strings
- required_skills and preferred_skills are string arrays (use [] when unknown)
- remote_status is exactly one of: "Remote", "Hybrid", "Onsite", or "" if unknown
- salary is a string, or "" when unavailable
- posted_date is YYYY-MM-DD when an exact posting date can be established, otherwise ""

Do not add extra fields. Do not include markdown. Do not include candidate scores.
""".strip()


DISCOVERY_JSON_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["jobs"],
    "properties": {
        "jobs": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "company",
                    "title",
                    "url",
                    "location",
                    "source",
                    "description",
                    "required_skills",
                    "preferred_skills",
                    "remote_status",
                    "salary",
                    "posted_date",
                ],
                "properties": {
                    "company": {"type": "string"},
                    "title": {"type": "string"},
                    "url": {"type": "string"},
                    "location": {"type": "string"},
                    "source": {"type": "string"},
                    "description": {"type": "string"},
                    "required_skills": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "preferred_skills": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "remote_status": {"type": "string"},
                    "salary": {"type": "string"},
                    "posted_date": {"type": "string"},
                },
            },
        }
    },
}
