"""Discovery-only prompt for OpenAI web search job finding."""

from __future__ import annotations


def build_discovery_prompt() -> str:
    """Return the instruction prompt for unattended daily job discovery.

    The model is a discovery layer only. It must not score, dedupe, classify
    reposts, or persist jobs — that remains the Python Job Agent's job.
    """
    return """You are the Jay Job discovery layer only.

Your sole job is to find CURRENT public job postings and extract raw job fields.
You MUST NOT:
- score candidates or rank fit
- decide duplicates
- decide reposts / SAME_POSTING / NEW_JOB
- persist jobs to any database, MCP, or storage system
- invent match scores, recommendations, or candidate reasoning

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

Freshness priority:
1) jobs posted today
2) jobs posted in the previous 3 days
3) if results are insufficient, expand to the previous 7 days

Never intentionally include expired, closed, filled, or archived postings.

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
- remote_status is one of: "Remote", "Hybrid", "Onsite", or "" if unknown
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
