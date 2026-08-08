from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Iterable

from ..models.types import JobInput, NormalizedJobPosting, JobSearchProfile


class JobSearchProvider(ABC):
    """Interface for a provider that supplies job inputs."""

    @abstractmethod
    def search(self, profile: JobSearchProfile) -> Iterable[JobInput]:
        """Return job inputs matching the provided profile."""
        raise NotImplementedError


class GPTSearchProvider(JobSearchProvider):
    """GPT-driven provider contract.

    External GPT reasoning and search is outside Python. This interface
    is only the contract for job inputs produced by that external agent.
    """
    pass


class JobNormalizer(ABC):
    """Interface for normalizing a job input into the agent model."""

    @abstractmethod
    def normalize(self, job_input: JobInput) -> NormalizedJobPosting:
        """Normalize a job input into the standardized agent schema."""
        raise NotImplementedError
