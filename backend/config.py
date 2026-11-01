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

# Optional hard caps on every opening order the backend sends; unset means no cap.
MAX_NOTIONAL_USD = _env("MAX_NOTIONAL_USD", None, float)
MAX_ORDERS_PER_DAY = _env("MAX_ORDERS_PER_DAY", None, int)
MAX_SLIPPAGE_PCT = _env("MAX_SLIPPAGE_PCT", 0.5, float)  # worst-price margin for stop orders

DATA_DIR = Path(_env("DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)
CREDENTIALS_FILE = DATA_DIR / "credentials.json"

# Public read-only site (lighterdeck.xyz): never loads a key, refuses every write, and the UI
# shows the welcome bar. The personal deck runs without it, behind the SSH tunnel.
PUBLIC_MODE = _env("PUBLIC_MODE", "").lower() in ("1", "true", "yes")
REFERRAL_URL = _env("REFERRAL_URL", "https://app.lighter.xyz/?referral=7658993U&source=none")  # "open a Lighter account": the project's referral
GITHUB_URL = "https://github.com/telcoray/LighterDeck"
BLOCKED_COUNTRIES = {"US", "GB", "CA"}  # where Lighter isn't available
if PUBLIC_MODE:
    ACCOUNT_INDEX = API_KEY_INDEX = API_PRIVATE_KEY = CREDENTIALS_SOURCE = None

if CREDENTIALS_SOURCE is None and CREDENTIALS_FILE.exists() and not PUBLIC_MODE:
    _saved = json.loads(CREDENTIALS_FILE.read_text())
    ACCOUNT_INDEX, API_KEY_INDEX, API_PRIVATE_KEY = _saved["account_index"], _saved["api_key_index"], _saved["private_key"]
    CREDENTIALS_SOURCE = "ui"

HOST = _env("HOST", "127.0.0.1")
PORT = _env("PORT", 8200, int)

TRADING_ENABLED = ACCOUNT_INDEX is not None and API_KEY_INDEX is not None and bool(API_PRIVATE_KEY)
