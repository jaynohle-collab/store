from datetime import datetime
from pydantic import BaseModel, Field, HttpUrl


class CompanyCreate(BaseModel):
    company_name: str = Field(..., max_length=255)
    notes: str | None = None


class JobCreate(BaseModel):
    company_name: str = Field(..., max_length=255)
    title: str = Field(..., max_length=255)
    url: HttpUrl | None = None
    source: str | None = None
    description: str | None = None
    description_hash: str | None = None
    status: str = Field(default="new", max_length=64)


class JobDuplicateCheck(BaseModel):
    company_name: str = Field(..., max_length=255)
    url: HttpUrl | None = None
    title: str | None = Field(None, max_length=255)
    description_hash: str | None = None


class SearchCompanyHistoryRequest(BaseModel):
    company_name: str = Field(..., max_length=255)


class JobUpdateStatus(BaseModel):
    job_id: int
    status: str = Field(..., max_length=64)


class ApplicationCreate(BaseModel):
    job_id: int
    stage: str = Field(..., max_length=128)
    notes: str | None = None


class JobHistoryItem(BaseModel):
    id: int
    company_name: str
    title: str
    url: str | None = None
    source: str | None = None
    description: str | None = None
    description_hash: str | None = None
    seen_count: int
    last_seen_at: datetime
    created_at: datetime
    status: str

    class Config:
        orm_mode = True


class DuplicateCheckResult(BaseModel):
    is_duplicate: bool
    existing_job_id: int | None = None


class UpdateStatusResult(BaseModel):
    job_id: int
    updated: bool
    status: str
