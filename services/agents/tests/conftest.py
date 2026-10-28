import json
from pathlib import Path
from typing import Any

import pytest

from canutell_agents.protocol import REPO_ROOT

FIXTURES = REPO_ROOT / "packages" / "protocol" / "fixtures" / "views.jsonl"


@pytest.fixture(scope="session")
def views() -> list[dict[str, Any]]:
    """Real per-seat views (with prompts) recorded from seeded matches by `pnpm protocol:fixtures`."""
    return [json.loads(line) for line in Path(FIXTURES).read_text().splitlines() if line.strip()]
