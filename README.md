# Job Search Memory MCP Server

A personal job search memory system implemented as a Python MCP service.

## Features

- Persistent SQLite storage
- SQLAlchemy ORM models
- Pydantic request/response schemas
- FastMCP tools for job memory operations

## Available tools

- `save_job`
- `check_duplicate_job`
- `get_job_history`
- `update_job_status`

## Run

```bash
python run_server.py
```

## Database

The SQLite file is created as `jobs_memory.db` in the project root.
