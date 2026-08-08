from fastmcp import FastMCP

from .crud import (
    save_job,
    check_duplicate_job,
    get_job_history as get_job_history_items,
    update_job_status,
)

from .database import SessionLocal, init_db
from .schemas import (
    JobCreate,
    JobUpdateStatus,
)

init_db()

mcp = FastMCP("job-memory-server")


@mcp.tool()
def save_job_memory(
    company_name: str,
    title: str,
    url: str | None = None,
    description: str | None = None,
    description_hash: str | None = None,
    source: str | None = None,
    status: str = "new",
):
    """
    Save a job into persistent memory.

    Required:
    - company_name
    - title

    Optional:
    - url
    - description
    - description_hash
    - source
    - status
    """

    data = JobCreate(
        company_name=company_name,
        title=title,
        url=url,
        description=description,
        description_hash=description_hash,
        source=source,
        status=status,
    )

    with SessionLocal() as session:
        job = save_job(session, data)
        session.commit()

        return {
            "id": job.id,
            "company": job.company.company_name,
            "title": job.title,
            "url": job.url,
            "status": job.status,
        }


@mcp.tool()
def check_duplicate(
    company_name: str,
    description_hash: str | None = None,
):
    """
    Check if a job already exists.
    """

    with SessionLocal() as session:
        duplicate, job_id = check_duplicate_job(
            session,
            company_name,
            description_hash,
        )

        return {
            "duplicate": duplicate,
            "existing_job_id": job_id,
        }


@mcp.tool(name="get_job_history")
def get_job_history():
    """
    Retrieve all previously discovered job postings from persistent memory.
    """

    with SessionLocal() as session:
        jobs = get_job_history_items(session)

        return [
            {
                "id": job.id,
                "company": job.company_name,
                "title": job.title,
                "url": job.url,
                "status": job.status,
            }
            for job in jobs
        ]


@mcp.tool()
def update_status(
    job_id: int,
    status: str,
):
    """
    Update job status.
    """

    data = JobUpdateStatus(
        job_id=job_id,
        status=status,
    )

    with SessionLocal() as session:
        job = update_job_status(
            session,
            data,
        )

        session.commit()

        return {
            "updated": job is not None,
            "job_id": job_id,
            "status": status,
        }
