"""Settings read from environment (on the VPS: /etc/lighterdeck/lighterdeck.env)."""
import json
import os
from pathlib import Path


def _env(name, default=None, cast=str):
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return cast(v)


LIGHTER_URL = _env("LIGHTER_URL", "https://mainnet.zklighter.elliot.ai")
LIGHTER_WS = LIGHTER_URL.replace("https://", "wss://") + "/stream"

# Trading credentials. Without them the deck runs read-only (charts, calendar, positions off).
# The environment wins; otherwise the key added from the UI (data/credentials.json) is used.
ACCOUNT_INDEX = _env("LIGHTER_ACCOUNT_INDEX", None, int)
API_KEY_INDEX = _env("LIGHTER_API_KEY_INDEX", None, int)
API_PRIVATE_KEY = _env("LIGHTER_API_PRIVATE_KEY", None)
CREDENTIALS_SOURCE = "env" if API_PRIVATE_KEY else None

# Token required by the browser UI (header X-Token / ?token=).
DASH_TOKEN = _env("DASH_TOKEN", None)

# Hard safety limits, enforced on every order the backend sends.
MAX_NOTIONAL_USD = _env("MAX_NOTIONAL_USD", 500.0, float)
MAX_ORDERS_PER_DAY = _env("MAX_ORDERS_PER_DAY", 40, int)
MAX_SLIPPAGE_PCT = _env("MAX_SLIPPAGE_PCT", 0.5, float)

DATA_DIR = Path(_env("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)
CREDENTIALS_FILE = DATA_DIR / "credentials.json"

if CREDENTIALS_SOURCE is None and CREDENTIALS_FILE.exists():
    _saved = json.loads(CREDENTIALS_FILE.read_text())
    ACCOUNT_INDEX, API_KEY_INDEX, API_PRIVATE_KEY = _saved["account_index"], _saved["api_key_index"], _saved["private_key"]
    CREDENTIALS_SOURCE = "ui"

HOST = _env("HOST", "127.0.0.1")
PORT = _env("PORT", 8200, int)

TRADING_ENABLED = ACCOUNT_INDEX is not None and API_KEY_INDEX is not None and bool(API_PRIVATE_KEY)
