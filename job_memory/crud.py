from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import NoResultFound
from sqlalchemy.orm import Session

from . import models
from .schemas import ApplicationCreate, JobCreate, JobDuplicateCheck, JobHistoryItem, JobUpdateStatus


def get_or_create_company(session: Session, company_name: str) -> models.Company:
    statement = select(models.Company).where(models.Company.company_name == company_name)
    company = session.scalar(statement)
    if company is None:
        company = models.Company(company_name=company_name)
        session.add(company)
        session.flush()
    return company


def find_existing_job(
    session: Session,
    company_name: str,
    url: str | None = None,
    title: str | None = None,
    description_hash: str | None = None,
) -> models.Job | None:
    company = get_or_create_company(session, company_name)

    if url:
        statement = select(models.Job).where(models.Job.url == url)
        existing_job = session.scalar(statement)
        if existing_job is not None:
            return existing_job

    if title:
        statement = (
            select(models.Job)
            .where(models.Job.company_id == company.id)
            .where(models.Job.title == title)
        )
        existing_job = session.scalar(statement)
        if existing_job is not None:
            return existing_job

    if description_hash:
        statement = (
            select(models.Job)
            .where(models.Job.company_id == company.id)
            .where(models.Job.description_hash == description_hash)
        )
        existing_job = session.scalar(statement)
        if existing_job is not None:
            return existing_job

    return None


def save_job(session: Session, job_data: JobCreate) -> models.Job:
    company = get_or_create_company(session, job_data.company_name)
    existing_job = find_existing_job(
        session,
        company_name=job_data.company_name,
        url=str(job_data.url) if job_data.url else None,
        title=job_data.title,
        description_hash=job_data.description_hash,
    )

    if existing_job is not None:
        existing_job.seen_count += 1
        existing_job.last_seen_at = datetime.utcnow()
        if job_data.url and existing_job.url is None:
            existing_job.url = str(job_data.url)
        if job_data.description and existing_job.description is None:
            existing_job.description = job_data.description
        if job_data.description_hash and existing_job.description_hash is None:
            existing_job.description_hash = job_data.description_hash
        session.add(existing_job)
        session.flush()
        return existing_job

    job = models.Job(
        company_id=company.id,
        title=job_data.title,
        url=str(job_data.url) if job_data.url else None,
        source=job_data.source,
        description=job_data.description,
        description_hash=job_data.description_hash,
        seen_count=1,
        last_seen_at=datetime.utcnow(),
        status=job_data.status,
    )
    session.add(job)
    session.flush()
    return job


def check_duplicate_job(
    session: Session,
    company_name: str,
    url: str | None = None,
    title: str | None = None,
    description_hash: str | None = None,
) -> tuple[bool, int | None]:
    existing_job = find_existing_job(
        session,
        company_name=company_name,
        url=url,
        title=title,
        description_hash=description_hash,
    )
    if existing_job is None:
        return False, None
    return True, existing_job.id


def get_job_history(session: Session) -> list[JobHistoryItem]:
    statement = (
        select(models.Job, models.Company.company_name)
        .join(models.Company)
        .order_by(models.Job.created_at.desc())
    )
    result = session.execute(statement).all()
    history: list[JobHistoryItem] = []
    for job, company_name in result:
        history.append(
            JobHistoryItem(
                id=job.id,
                company_name=company_name,
                title=job.title,
                url=job.url,
                source=job.source,
                description=job.description,
                description_hash=job.description_hash,
                seen_count=job.seen_count,
                last_seen_at=job.last_seen_at,
                created_at=job.created_at,
                status=job.status,
            )
        )
    return history


def search_company_history(session: Session, company_name: str) -> list[JobHistoryItem]:
    statement = (
        select(models.Job, models.Company.company_name)
        .join(models.Company)
        .where(models.Company.company_name == company_name)
        .order_by(models.Job.last_seen_at.desc(), models.Job.created_at.desc())
    )
    result = session.execute(statement).all()
    history: list[JobHistoryItem] = []
    for job, company_name in result:
        history.append(
            JobHistoryItem(
                id=job.id,
                company_name=company_name,
                title=job.title,
                url=job.url,
                source=job.source,
                description=job.description,
                description_hash=job.description_hash,
                seen_count=job.seen_count,
                last_seen_at=job.last_seen_at,
                created_at=job.created_at,
                status=job.status,
            )
        )
    return history


def update_job_status(session: Session, job_update: JobUpdateStatus) -> models.Job | None:
    statement = select(models.Job).where(models.Job.id == job_update.job_id)
    job = session.scalar(statement)
    if job is None:
        return None
    job.status = job_update.status
    session.add(job)
    session.flush()
    return job


def create_application(session: Session, application_data: ApplicationCreate) -> models.Application:
    job = session.get(models.Job, application_data.job_id)
    if job is None:
        raise NoResultFound(f"Job id={application_data.job_id} does not exist")
    application = models.Application(
        job_id=job.id,
        stage=application_data.stage,
        notes=application_data.notes,
    )
    session.add(application)
    session.flush()
    return application
