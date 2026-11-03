"""Automations for visitors of the public site who trade with their API key in the browser (live.js).

Trailing stops, breakeven, scaled exits and event trades have to run while the page is closed, so a
visitor who turns them on gives the server a second, dedicated API key: a different index from the
one in their browser, so the two never compete for nonces, and one they can revoke on Lighter at any
time. It is kept encrypted (AES-256-GCM, master key LD_VAULT_KEY from the server's env, never in
data/) in data/users/<account>/key.json, decrypted only in memory, never logged, and deleted with the
visitor's whole folder when they turn automations off. An API key can't send funds to other
addresses: withdrawals go to the account's own wallet only.

Each visitor gets their own Engine (rules, kill switch, managed stops) and limits in that folder,
running exactly as the deck's own. Requests are tied to an account by a Lighter auth token the
browser signs with its key: Lighter is asked whether the token is valid for that account, and the
answer is cached until the token expires.
"""
import asyncio
import base64
import json
import logging
import os
import shutil
import time

import config
from engine import Engine
from lighter_api import UserAPI
from risk import RiskGuard

log = logging.getLogger("users")

USERS_DIR = config.DATA_DIR / "users"
TOKEN_CACHE = 2000  # tokens remembered at most (each valid for minutes)


class Users:
    def __init__(self, api, feed, calendar):
        self.api, self.feed, self.calendar = api, feed, calendar
        self.engines = {}   # account -> Engine
        self._tasks = {}    # account -> its engine's loop
        self._tokens = {}   # auth token -> (account, api key index, valid until)
        self._lock = asyncio.Lock()

    @property
    def available(self):
        return config.PUBLIC_MODE and config.BROWSER_TRADING and bool(config.VAULT_KEY)

    # ---------- the vault ----------
    @staticmethod
    def _aes():
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        return AESGCM(base64.b64decode(config.VAULT_KEY))

    @staticmethod
    def _dir(account):
        return USERS_DIR / str(int(account))

    def _seal(self, account, key_index, private_key):
        nonce = os.urandom(12)
        # the account and key index are bound to the ciphertext: a key file can't be moved to another account
        ct = self._aes().encrypt(nonce, private_key.encode(), f"{account}:{key_index}".encode())
        return {"api_key_index": key_index, "nonce": base64.b64encode(nonce).decode(), "key": base64.b64encode(ct).decode(),
                "since": time.time()}

    def _open(self, account, sealed):
        return self._aes().decrypt(base64.b64decode(sealed["nonce"]), base64.b64decode(sealed["key"]),
                                   f"{account}:{sealed['api_key_index']}".encode()).decode()

    # ---------- engines ----------
    async def start(self):
        """At start-up: an engine for every visitor who left automations on."""
        if not self.available:
            return
        for f in USERS_DIR.glob("*/key.json"):
            account = int(f.parent.name)
            try:
                await self._run(account, json.loads(f.read_text()))
            except Exception as e:  # a key revoked on Lighter meanwhile: keep the file, show it as failing
                log.warning("#%s automations not started: %s", account, e)

    async def _run(self, account, sealed):
        api = UserAPI(self.api, account, sealed["api_key_index"])
        await api.connect(self._open(account, sealed))
        d = self._dir(account)
        engine = Engine(api, self.feed, self.calendar, RiskGuard(api, self.feed, d), d, name=f"#{account} ")
        self.engines[account] = engine
        self._tasks[account] = asyncio.create_task(engine.run())
        return engine

    async def turn_on(self, account, browser_key_index, key_index, private_key):
        """Check the dedicated key with Lighter, keep it encrypted and start the visitor's engine."""
        if key_index == browser_key_index:
            raise ValueError("same key")
        async with self._lock:
            await self.turn_off(account, keep_rules=True)
            d = self._dir(account)
            d.mkdir(parents=True, exist_ok=True)
            sealed = self._seal(account, key_index, private_key)
            api = UserAPI(self.api, account, key_index)
            await api.connect(private_key)  # ValueError when Lighter doesn't accept it: nothing is kept
            await api.close()
            f = d / "key.json"
            f.write_text(json.dumps(sealed))
            try:
                os.chmod(f, 0o600)
            except OSError:
                pass
            engine = await self._run(account, sealed)
            engine.note(f"automations turned on with API key #{key_index}", "warning")
            return engine

    async def turn_off(self, account, keep_rules=False):
        """Stop the engine and delete the key (and, unless replacing it, the visitor's whole folder)."""
        task = self._tasks.pop(account, None)
        if task:
            task.cancel()
        engine = self.engines.pop(account, None)
        if engine:
            await engine.api.close()
        d = self._dir(account)
        if keep_rules:
            (d / "key.json").unlink(missing_ok=True)
        elif d.exists():
            shutil.rmtree(d)

    async def close(self):
        for account in list(self.engines):
            task = self._tasks.pop(account, None)
            if task:
                task.cancel()
            await self.engines.pop(account).api.close()

    # ---------- who is asking ----------
    async def account_of(self, token):
        """(account, api key index) of a valid Lighter auth token; raises PermissionError otherwise."""
        hit = self._tokens.get(token)
        now = time.time()
        if hit and now < hit[2]:
            return hit[0], hit[1]
        try:
            deadline, account, key_index, _sig = token.split(":")
            deadline, account, key_index = int(deadline), int(account), int(key_index)
        except (AttributeError, ValueError):
            raise PermissionError("bad token")
        if deadline < now:
            raise PermissionError("token expired")
        try:  # Lighter checks the signature against the account's registered key
            await self.api._get("/api/v1/accountActiveOrders", {"account_index": account, "market_id": 0},
                                headers={"authorization": token})
        except Exception:
            raise PermissionError("token refused by Lighter")
        if len(self._tokens) >= TOKEN_CACHE:
            self._tokens = {k: v for k, v in self._tokens.items() if v[2] > now}
        self._tokens[token] = (account, key_index, min(deadline, now + 3600))
        return account, key_index
