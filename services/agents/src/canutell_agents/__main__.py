"""python -m canutell_agents — run the agent service (see service.py for configuration)."""

import asyncio
import logging
import os

from .service import build_from_env, serve


def main() -> None:
    logging.basicConfig(level=os.environ.get("AGENT_LOG_LEVEL", "INFO"), format="%(asctime)s %(name)s %(message)s")
    service = build_from_env()
    asyncio.run(serve(service, os.environ.get("AGENT_HOST", "127.0.0.1"), int(os.environ.get("AGENT_PORT", "8790"))))


if __name__ == "__main__":
    main()
