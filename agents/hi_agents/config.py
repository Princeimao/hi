"""Hi agent runtime configuration — everything comes from the environment.

`server/.env` (the local backend's secrets) is loaded at import time, before
the values below are frozen: importing `config` anywhere therefore works.
"""
import os

try:
    from dotenv import load_dotenv  # type: ignore[import-not-found]
    _here = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(_here, "..", "..", "server", ".env"))
    load_dotenv(os.path.join(_here, "..", "..", ".env"))
except ImportError:  # dotenv missing: plain environment only
    pass

HI_BACKEND_URL = os.environ.get("HI_BACKEND_URL", "ws://localhost:8787/ws")
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "")
ASI_API_KEY = os.environ.get("ASI_ONE_API_KEY", "")
ASI_BASE_URL = os.environ.get("ASI_ONE_BASE_URL", "https://api.asi1.ai/v1")
ASI_MODEL = os.environ.get("ASI_ONE_MODEL", "asi1")
ASI_MINI_MODEL = os.environ.get("ASI_ONE_MINI_MODEL", "asi1-mini")
AGENTVERSE_TOKEN = os.environ.get("AGENTVERSE", "")

# Fixed agent identity seeds — replace with your own secret seeds in production.
COORDINATOR_SEED = os.environ.get("HI_COORDINATOR_SEED", "hi companion coordinator seed phrase")
RESEARCHER_SEED = os.environ.get("HI_RESEARCHER_SEED", "hi companion researcher seed phrase")
PLANNER_SEED = os.environ.get("HI_PLANNER_SEED", "hi companion planner seed phrase")
INSIGHT_SEED = os.environ.get("HI_INSIGHT_SEED", "hi companion insight seed phrase")

AGENT_HOST = os.environ.get("HI_AGENT_HOST", "127.0.0.1")
AGENT_BASE_PORT = int(os.environ.get("HI_AGENT_BASE_PORT", "8790"))
