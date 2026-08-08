from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from .models import Base

DATABASE_FILE = Path(__file__).resolve().parent.parent / "jobs_memory.db"
ENGINE = create_engine(f"sqlite:///{DATABASE_FILE}", echo=False, future=True)
SessionLocal = sessionmaker(bind=ENGINE, autoflush=False, autocommit=False, future=True)


def init_db() -> None:
    DATABASE_FILE.parent.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=ENGINE)
