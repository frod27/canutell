"""Frame validation against the JSON Schemas exported from the zod protocol (packages/protocol/schema).

Zod is the single source of truth; `pnpm protocol:schema` regenerates the schemas, and a TypeScript test
fails if they are stale. Every frame this service receives *and* sends is validated here.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

REPO_ROOT = Path(__file__).resolve().parents[4]


def schema_dir() -> Path:
    return Path(os.environ.get("CANUTELL_SCHEMA_DIR", REPO_ROOT / "packages" / "protocol" / "schema"))


class ProtocolError(ValueError):
    """A frame does not match the protocol schema."""


@lru_cache(maxsize=2)
def _validator(name: str) -> Draft202012Validator:
    schema = json.loads((schema_dir() / f"{name}.json").read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _check(name: str, frame: Any) -> dict[str, Any]:
    errors = sorted(_validator(name).iter_errors(frame), key=lambda e: list(e.path))
    if errors:
        raise ProtocolError(f"{name}: {errors[0].message} at {list(errors[0].path)}")
    return frame


def parse_server_frame(raw: str | bytes) -> dict[str, Any]:
    try:
        frame = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ProtocolError(f"invalid JSON: {e}") from e
    return _check("server-message", frame)


def check_client_frame(frame: dict[str, Any]) -> dict[str, Any]:
    return _check("client-message", frame)


def prompt_key(prompt: dict[str, Any], round_: int) -> str:
    """Same identity the server uses to measure latency (packages/protocol/src/views.ts promptKey)."""
    return f"return:{prompt['stakeId']}" if prompt["kind"] == "return" else f"{prompt['kind']}:{round_}"
