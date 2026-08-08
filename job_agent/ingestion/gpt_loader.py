from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..models.types import JobInput


class GPTJobIngestionError(ValueError):
    pass


@dataclass
class GPTJobRecord:
    company: str
    title: str
    url: str
    description: str
    location: str | None = None
    source: str | None = None
    required_skills: list[str] | None = None
    preferred_skills: list[str] | None = None
    remote_status: bool | None = None
    salary: str | None = None
    posted_date: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "GPTJobRecord":
        required_fields = ["company", "title", "url", "description"]
        missing = [field for field in required_fields if not data.get(field)]
        if missing:
            raise GPTJobIngestionError(
                f"Missing required GPT job fields: {', '.join(missing)}"
            )

        return cls(
            company=str(data["company"]).strip(),
            title=str(data["title"]).strip(),
            url=str(data["url"]).strip(),
            description=str(data["description"]).strip(),
            location=str(data["location"]).strip() if data.get("location") else None,
            source=str(data["source"]).strip() if data.get("source") else None,
            required_skills=list(data["required_skills"]) if data.get("required_skills") else None,
            preferred_skills=list(data["preferred_skills"]) if data.get("preferred_skills") else None,
            remote_status=bool(data["remote_status"]) if data.get("remote_status") is not None else None,
            salary=str(data["salary"]).strip() if data.get("salary") else None,
            posted_date=str(data["posted_date"]).strip() if data.get("posted_date") else None,
        )

    def to_job_input(self) -> JobInput:
        return JobInput(
            company=self.company,
            title=self.title,
            url=self.url,
            description=self.description,
            source=self.source or "gpt-job-search",
            location=self.location,
            metadata=self._build_metadata(),
        )

    def _build_metadata(self) -> dict[str, str] | None:
        metadata: dict[str, str] = {}
        if self.required_skills:
            metadata["required_skills"] = ", ".join(str(skill).strip() for skill in self.required_skills)
        if self.preferred_skills:
            metadata["preferred_skills"] = ", ".join(str(skill).strip() for skill in self.preferred_skills)
        if self.remote_status is not None:
            metadata["remote_status"] = str(self.remote_status)
        if self.salary:
            metadata["salary"] = self.salary
        if self.posted_date:
            metadata["posted_date"] = self.posted_date
        return metadata or None


class GPTJobLoader:
    def __init__(self, payload: dict[str, Any]):
        self.payload = payload

    def load_jobs(self) -> list[JobInput]:
        if not isinstance(self.payload, dict):
            raise GPTJobIngestionError("GPT payload must be a JSON object")

        jobs = self.payload.get("jobs")
        if jobs is None:
            raise GPTJobIngestionError("GPT payload must include a 'jobs' list")
        if not isinstance(jobs, list):
            raise GPTJobIngestionError("GPT payload 'jobs' must be a list")

        job_inputs: list[JobInput] = []
        for index, raw_job in enumerate(jobs):
            if not isinstance(raw_job, dict):
                raise GPTJobIngestionError(f"Job item at index {index} must be an object")
            record = GPTJobRecord.from_dict(raw_job)
            job_inputs.append(record.to_job_input())

        return job_inputs
