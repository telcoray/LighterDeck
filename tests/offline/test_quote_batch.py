"""Quote submission and nonce ordering with a fake Lighter transport."""
import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

os.environ["DATA_DIR"] = tempfile.mkdtemp()
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from lighter_api import CancelQuote, LighterAPI, ModifyQuote, PlaceQuote, QuoteBatchOutcomeUnknown


class FakeSigner:
    def __init__(self):
        self.nonce = 40
        self.sent = []
        self.fail_signing = False
        self.lose_response = False
        self.delay = 0

    def sign(self, kind, **params):
        if self.fail_signing:
            return None, None, None, "bad signature"
        return kind, params, str(params["nonce"]), None

    def sign_create_order(self, **params):
        return self.sign("create", **params)

    def sign_modify_order(self, **params):
        return self.sign("modify", **params)

    def sign_cancel_order(self, **params):
        return self.sign("cancel", **params)

    async def send_tx_batch(self, types, infos):
        await asyncio.sleep(self.delay)
        nonces = [info["nonce"] for info in infos]
        assert nonces == list(range(self.nonce, self.nonce + len(infos)))
        self.nonce += len(infos)
        self.sent.append((types, infos))
        if self.lose_response:
            raise TimeoutError()
        return SimpleNamespace(code=200, tx_hash=list(map(str, nonces)))


def setup():
    api = LighterAPI()
    signer = api.signer = FakeSigner()
    api.markets[1] = SimpleNamespace(size_int=lambda size: round(abs(size) * 10),
                                     round_price=lambda price: round(price, 1),
                                     price_int=lambda price: round(price * 10))

    async def get(path, params):
        assert path == "/api/v1/nextNonce" and params["api_key_index"] == api.api_key_index
        await asyncio.sleep(signer.delay)
        return {"nonce": signer.nonce}

    api._get = get
    return api, signer


async def main():
    api, signer = setup()
    actions = [PlaceQuote(1, 100, -2, 11.23), ModifyQuote(1, 201, 2, 12), CancelQuote(1, 202)]
    hashes, next_hashes = await asyncio.gather(
        api.send_quote_batch(actions), api.send_quote_batch([CancelQuote(1, 203)]))
    assert hashes == ("40", "41", "42") and next_hashes == ("43",)
    types, infos = signer.sent[0]
    assert types == ["create", "modify", "cancel"]
    from lighter import SignerClient
    assert infos[0]["time_in_force"] == SignerClient.ORDER_TIME_IN_FORCE_POST_ONLY
    assert infos[0]["price"] == 112 and infos[0]["base_amount"] == 20 and infos[0]["is_ask"]
    print("PASS mixed batch and concurrent callers preserve nonce and action order")

    signer.fail_signing = True
    try:
        await api.send_quote_batch(actions)
    except RuntimeError as exc:
        assert "bad signature" in str(exc) and len(signer.sent) == 2
    else:
        raise AssertionError("expected signing error")
    print("PASS signing failure prevents submission")

    signer.fail_signing = False
    signer.lose_response = True
    try:
        await api.send_quote_batch(actions)
    except QuoteBatchOutcomeUnknown as exc:
        assert exc.tx_hashes == ("44", "45", "46") and len(signer.sent) == 3
    else:
        raise AssertionError("expected unknown outcome")
    print("PASS timeout exposes signed hashes without replay")


async def benchmark():
    api, signer = setup()
    signer.delay = 0.015
    start = time.perf_counter()
    batches = 60
    size = 15
    samples = []
    for i in range(batches):
        first_action = i * size
        ready = start + (first_action + size - 1) / 300
        await asyncio.sleep(max(0, ready - time.perf_counter()))
        actions = [ModifyQuote(1, j % size, 2, 12) for j in range(first_action, first_action + size)]
        await api.send_quote_batch(actions)
        done = time.perf_counter()
        samples.extend(done - (start + j / 300) for j in range(first_action, first_action + size))
    elapsed = time.perf_counter() - start
    p99 = sorted(samples)[int(len(samples) * 0.99) - 1]
    print(f"{len(samples)} actions, {len(signer.sent)} batches, {len(samples) / elapsed:.1f} actions/s, p99 {p99 * 1000:.1f} ms")


if __name__ == "__main__":
    asyncio.run(benchmark() if "--benchmark" in sys.argv else main())
