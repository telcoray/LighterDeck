"""Market logos from Lighter's asset CDN, downloaded once and served from data/logos.

The file name comes from the tokenlist (`logo` + `logo_extension`), never from the URL,
so a request can only ever read one of the known logos.
"""
import asyncio
import logging
import re
import time

import aiohttp

import config

log = logging.getLogger("logos")

CDN = "https://assets.lighter.xyz/fe/token/"
DIR = config.DATA_DIR / "logos"
DIR.mkdir(parents=True, exist_ok=True)
RETRY_MISSING = 7 * 86400  # Lighter adds logos over time; look again after a week
TYPES = {"svg": "image/svg+xml", "png": "image/png", "webp": "image/webp", "jpg": "image/jpeg"}
SAFE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class Logos:
    def __init__(self):
        self._locks = {}

    async def get(self, market):
        """(bytes, content_type) for a market, or None when Lighter has no logo for it."""
        name, ext = market.logo, market.logo_ext
        if not name or not SAFE.match(name) or ext not in TYPES:
            return None
        path = DIR / f"{name}.{ext}"
        missing = DIR / f"{name}.missing"
        if path.exists():
            return path.read_bytes(), TYPES[ext]
        if missing.exists() and time.time() - missing.stat().st_mtime < RETRY_MISSING:
            return None
        async with self._locks.setdefault(name, asyncio.Lock()):
            if path.exists():  # another request fetched it meanwhile
                return path.read_bytes(), TYPES[ext]
            try:
                async with aiohttp.ClientSession(headers={"User-Agent": "LighterDeck/1.0"}) as s:
                    async with s.get(f"{CDN}{name}.{ext}", timeout=aiohttp.ClientTimeout(total=10)) as r:
                        body = await r.read() if r.status == 200 else None
            except Exception as e:
                log.info("logo %s not fetched: %s", name, e)
                return None  # network error: try again on the next request
            if not body or len(body) > 512_000:
                missing.touch()
                return None
            path.write_bytes(body)
            missing.unlink(missing_ok=True)
            return body, TYPES[ext]
