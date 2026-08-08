from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Iterable, Protocol

from .interfaces import JobSearchProvider
from ..models.types import JobSearchProfile, RawJobPosting


class SearchExecutor(Protocol):
    """Abstract executor for search queries produced by the GPT provider."""

    def search(self, query: str) -> list[dict[str, Any]]:
        raise NotImplementedError


@dataclass
class GPTQueryGenerator:
    """Builds search queries from a job search profile."""

    max_queries: int = 4

    def generate_queries(self, profile: JobSearchProfile) -> list[str]:
        components: list[str] = []
        if profile.experience_level:
            components.append(profile.experience_level)
        if profile.keywords:
            components.extend(profile.keywords[:4])
        if profile.remote:
            components.append("remote")
        if profile.location:
            components.append(profile.location)

        keywords = [token for token in components if token]
        queries: list[str] = []

        if not keywords:
            return ["remote job opportunity"]

        primary = " ".join(keywords[:5])
        queries.append(primary)

        if profile.remote and profile.location:
            queries.append(f"{primary} remote {profile.location}")

        if profile.keywords:
            prioritized = self._extract_priority_terms(profile.keywords)
            if prioritized:
                queries.append(f"{prioritized} remote {profile.location or 'US'}")
                queries.append(f"{prioritized} {profile.experience_level or ''} {self._build_tag_string(profile.keywords)}")

        unique_queries = []
        for query in queries:
            normalized = " ".join(query.split())
            if normalized and normalized not in unique_queries:
                unique_queries.append(normalized)
            if len(unique_queries) >= self.max_queries:
                break

        return unique_queries

    def _extract_priority_terms(self, keywords: list[str]) -> str:
        normalized = [item for item in keywords if item.lower() not in {"remote", "us", "usa", "work from home"}]
        return " ".join(normalized[:5])

    def _build_tag_string(self, keywords: list[str]) -> str:
        tags = [term for term in keywords if term.upper() in {"MCP", "RAG", "LLM", "AI", "INFRA", "AGENT"}]
        return " ".join(tags) if tags else ""


class GPTSearchProvider(JobSearchProvider):
    """Hybrid search provider that uses GPT-generated queries for public job search."""

    def __init__(
        self,
        executor: SearchExecutor,
        query_generator: GPTQueryGenerator | None = None,
    ):
        self.executor = executor
        self.query_generator = query_generator or GPTQueryGenerator()

    def search(self, profile: JobSearchProfile) -> Iterable[RawJobPosting]:
        queries = self.query_generator.generate_queries(profile)
        results: list[RawJobPosting] = []
        seen_urls: set[str] = set()

        for query in queries:
            raw_results = self.executor.search(query)
            for item in raw_results:
                url = item.get("url")
                if url and url in seen_urls:
                    continue
                if url:
                    seen_urls.add(url)

                results.append(
                    RawJobPosting(
                        source=item.get("source", "gpt-public-search"),
                        raw_title=item.get("title", ""),
                        raw_company=item.get("company", ""),
                        raw_location=item.get("location"),
                        raw_description=item.get("description"),
                        raw_url=url,
                        raw_metadata=item.get("metadata", {}),
                    )
                )

        return results


class MockGPTSearchExecutor:
    """Mock search executor for development and testing."""

    def search(self, query: str) -> list[dict[str, Any]]:
        return [
            {
                "source": "mock-public-search",
                "title": "Senior AI Engineer",
                "company": "Example AI Labs",
                "location": "Remote",
                "description": f"Mock posting generated for query '{query}'.",
                "url": f"https://example.com/jobs/senior-ai-engineer-{abs(hash(query)) % 10000}",
                "metadata": {"query": query},
            },
            {
                "source": "mock-public-search",
                "title": "LLM Infrastructure Engineer",
                "company": "Open Agent Co",
                "location": "Remote",
                "description": f"Mock posting generated for query '{query}'.",
                "url": f"https://example.com/jobs/llm-infrastructure-{abs(hash(query)) % 10000 + 1}",
                "metadata": {"query": query},
            },
        ]
