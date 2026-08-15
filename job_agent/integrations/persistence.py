"""Persistence backend factory for local SQLite MCP vs remote Auth0-secured MCP."""

from __future__ import annotations

import logging
import os
from typing import Any, Literal

from ..memory.client import MemoryStore

logger = logging.getLogger(__name__)

PersistenceMode = Literal["local", "remote"]


def get_persistence_mode() -> PersistenceMode:
    """Return configured persistence mode.

    Production mode is ``remote`` (Auth0 + Vercel MCP + Neon).
    ``local`` preserves the existing SQLite / FastMCP workflow for development.
    """
    raw = os.environ.get("JOB_PERSISTENCE_MODE", "local").strip().lower()
    if raw in {"remote", "neon", "mcp"}:
        return "remote"
    return "local"


def create_memory_store(tool_client: Any | None = None) -> MemoryStore:
    """Create a MemoryStore for the configured persistence mode.

    - local: caller should provide a FastMCP/local tool client (or tests use mocks)
    - remote: builds an Auth0-authenticated remote MCP adapter
    """
    mode = get_persistence_mode()
    if mode == "remote":
        from .remote_mcp_client import RemoteMcpMemoryAdapter

        logger.info("Using remote MCP persistence (production path)")
        return MemoryStore(tool_client=tool_client or RemoteMcpMemoryAdapter())

    logger.info("Using local persistence mode (SQLite / local MCP fallback)")
    if tool_client is None:
        raise ValueError("tool_client is required when JOB_PERSISTENCE_MODE=local")
    return MemoryStore(tool_client=tool_client)
