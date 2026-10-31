"""Pre-trade guard: every order that opens or adds exposure is reviewed against a set of rules.

Each rule is a small function that looks at a `Proposal` (the order plus the account as it is
now) and returns a reason to refuse it, or None. Rules run in order and the first refusal wins,
so the message the user sees names the most basic problem first.

Limits are editable from the UI and saved in data/limits.json. The MAX_NOTIONAL_USD cap in
config.py stays a hard ceiling, enforced again in lighter_api just before signing.
"""
import json
import time
from dataclasses import dataclass, field

import config
from i18n import L as tr  # rules take the limits dict as `L`, so the translator is `tr` here

LIMITS_FILE = config.DATA_DIR / "limits.json"
FEED_MAX_AGE = 10  # seconds without a price update before quotes count as stale
DAILY_PNL_TTL = 30

DEFAULT_LIMITS = {
    "per_order_usd": min(500.0, config.MAX_NOTIONAL_USD),
    "per_market_usd": 1500.0,
    "total_exposure_usd": 3000.0,
    "leverage_cap": 5,
    "daily_loss_usd": 100.0,
    "open_markets": 3,
    "slippage_bps_cap": 50,
    "stop_required": True,
}
LIMIT_RANGES = {  # accepted values from the UI: (min, max, integer?)
    "per_order_usd": (1, config.MAX_NOTIONAL_USD, False),
    "per_market_usd": (1, 1_000_000, False),
    "total_exposure_usd": (1, 1_000_000, False),
    "leverage_cap": (1, 50, True),
    "daily_loss_usd": (1, 1_000_000, False),
    "open_markets": (1, 50, True),
    "slippage_bps_cap": (1, 300, True),
}
_OLD_NAMES = {  # limits.json written by earlier versions
    "max_order_usd": "per_order_usd", "max_position_usd": "per_market_usd", "max_total_usd": "total_exposure_usd",
    "max_leverage": "leverage_cap", "max_daily_loss": "daily_loss_usd", "max_positions": "open_markets",
    "max_slippage_bps": "slippage_bps_cap", "require_stop_loss": "stop_required",
}


class Blocked(ValueError):
    """An order the guard refuses; the message is shown to the user as is."""


def sltp_trigger_error(side, entry, mark, stop_loss, take_profit):
    """Same rule as lighter-ts formulas/sltpTriggerValidation.ts (MIT, elliottech/lighter-ts):
    a long's SL must be below and its TP above the reference price (a short's the other way),
    checked against the entry/limit price and, for market orders, the mark price too."""
    refs = [(tr("prezzo d'entrata", "entry price"), entry)] + ([("mark price", mark)] if mark else [])
    for trigger, is_sl in ((stop_loss, True), (take_profit, False)):
        if not trigger:
            continue
        name = (tr("Lo stop-loss", "The stop-loss") if is_sl else tr("Il take-profit", "The take-profit"))
        if trigger <= 0:
            return tr(f"{name} deve essere maggiore di zero", f"{name} must be above zero")
        for ref_name, ref in refs:
            below = is_sl == (side > 0)  # long SL / short TP sit below the price
            if (trigger >= ref) if below else (trigger <= ref):
                return tr(f"{name} deve stare {'sotto' if below else 'sopra'} il {ref_name} ({ref:g})",
                         f"{name} must be {'below' if below else 'above'} the {ref_name} ({ref:g})")
    return None


@dataclass
class Proposal:
    account: dict | None
    market: object            # lighter_api.Market
    side: int                 # +1 buy, -1 sell
    size: float               # base amount, positive
    price: float              # expected fill (best bid/ask) or limit price
    stop: float | None = None
    target: float | None = None
    slippage_bps: float | None = None
    mark: float | None = None  # given for market orders
    daily_pnl: float | None = None
    notional: float = field(init=False)

    def __post_init__(self):
        self.notional = self.size * self.price

    @property
    def positions(self):
        return (self.account or {}).get("positions", [])

    @property
    def held(self):
        """Signed size already held in this market (0 when flat)."""
        return next((p["size"] for p in self.positions if p["market_id"] == self.market.id), 0.0)


# ---------- rules for orders that open or add exposure ----------
def rule_exchange_minimum(p, L):
    if p.size < p.market.min_base or p.notional < p.market.min_quote:
        return tr(f"Ordine sotto il minimo dell'exchange ({p.market.min_base:g} {p.market.symbol} o {p.market.min_quote:g} USD)",
                 f"Order below the exchange minimum ({p.market.min_base:g} {p.market.symbol} or {p.market.min_quote:g} USD)")


def rule_protection_side(p, L):
    return sltp_trigger_error(p.side, p.price, p.mark, p.stop, p.target)


def rule_stop_required(p, L):
    if L["stop_required"] and not p.stop:
        return tr("Imposta uno stop-loss: è obbligatorio nei tuoi limiti di rischio",
                 "Set a stop-loss: your risk limits require one")


def rule_slippage(p, L):
    if p.slippage_bps is not None and p.slippage_bps > L["slippage_bps_cap"]:
        return tr(f"Slippage oltre il tuo limite di {L['slippage_bps_cap']} bps",
                  f"Slippage above your {L['slippage_bps_cap']} bps limit")


def rule_order_size(p, L):
    if p.notional > L["per_order_usd"]:
        return tr(f"Ordine da ${p.notional:,.0f}: il tuo limite per ordine è ${L['per_order_usd']:,.0f}",
                  f"${p.notional:,.0f} order: your per-order limit is ${L['per_order_usd']:,.0f}")


def rule_account_loaded(p, L):
    if p.account is None:
        return tr("Account non ancora caricato", "Account not loaded yet")


def rule_no_flip(p, L):
    if p.held * p.side < 0:
        return tr("Hai una posizione opposta: chiudila (reduce-only) prima di girarti",
                 "You hold the opposite position: close it (reduce-only) before reversing")


def rule_daily_loss(p, L):
    if p.daily_pnl is None:
        return tr("Non riesco a verificare il PnL di oggi: nuove posizioni bloccate per sicurezza",
                  "Today's PnL can't be checked: new positions blocked to be safe")
    if p.daily_pnl <= -L["daily_loss_usd"]:
        return tr(f"Raggiunta la perdita massima di oggi: {p.daily_pnl:,.2f} USD su -{L['daily_loss_usd']:,.0f} (posizioni aperte incluse)",
                  f"Daily loss limit reached: {p.daily_pnl:,.2f} USD of -{L['daily_loss_usd']:,.0f} (open positions included)")


def rule_market_exposure(p, L):
    here = next((abs(x["value"]) for x in p.positions if x["market_id"] == p.market.id), 0.0)
    if here + p.notional > L["per_market_usd"]:
        return tr(f"Su {p.market.symbol} supereresti il limite di ${L['per_market_usd']:,.0f}",
                  f"This would exceed your ${L['per_market_usd']:,.0f} limit on {p.market.symbol}")


def rule_total_exposure(p, L):
    total = sum(abs(x["value"]) for x in p.positions) + p.notional
    if total > L["total_exposure_usd"]:
        return tr(f"L'esposizione totale supererebbe ${L['total_exposure_usd']:,.0f}",
                  f"Total exposure would exceed ${L['total_exposure_usd']:,.0f}")


def rule_open_markets(p, L):
    markets = {x["market_id"] for x in p.positions} | {p.market.id}
    if len(markets) > L["open_markets"]:
        return tr(f"Avresti più di {L['open_markets']} mercati aperti insieme",
                  f"You would have more than {L['open_markets']} markets open at once")


def _leverage(p):
    setting = p.account.get("settings", {}).get(p.market.id, {})
    return setting.get("leverage") or p.market.default_leverage


def rule_leverage(p, L):
    lev = _leverage(p)
    if lev and lev > L["leverage_cap"]:
        return tr(f"La leva su {p.market.symbol} è {lev:g}x, oltre il tuo limite di {L['leverage_cap']}x: abbassala prima",
                  f"{p.market.symbol} leverage is {lev:g}x, above your {L['leverage_cap']}x limit: lower it first")


def rule_margin(p, L):
    lev = _leverage(p)
    if lev and p.notional / lev > p.account["available"]:
        return tr("Margine disponibile insufficiente", "Not enough available margin")


OPENING_RULES = [
    rule_exchange_minimum, rule_protection_side, rule_stop_required, rule_slippage, rule_order_size,
    rule_account_loaded, rule_no_flip, rule_daily_loss, rule_market_exposure, rule_total_exposure,
    rule_open_markets, rule_leverage, rule_margin,
]


def rule_reduces_position(p, L):
    if p.held == 0 or p.held * p.side > 0:
        return tr("Reduce-only: non c'è una posizione da ridurre in quella direzione",
                 "Reduce-only: there is no position to reduce in that direction")
    if p.size > abs(p.held) + 1e-12:
        return tr("Reduce-only: la size supera la posizione aperta", "Reduce-only: size is larger than the open position")


class RiskGuard:
    def __init__(self, api, feed):
        self.api, self.feed = api, feed
        self.limits = dict(DEFAULT_LIMITS)
        if LIMITS_FILE.exists():
            saved = json.loads(LIMITS_FILE.read_text())
            self.limits.update({_OLD_NAMES.get(k, k): v for k, v in saved.items() if _OLD_NAMES.get(k, k) in DEFAULT_LIMITS})
        self._pnl_cache = (None, 0.0)

    def update(self, changes):
        for key, value in changes.items():
            if key == "stop_required":
                self.limits[key] = bool(value)
            elif key in LIMIT_RANGES:
                lo, hi, whole = LIMIT_RANGES[key]
                value = float(value)
                if not lo <= value <= hi:
                    raise Blocked(tr(f"{key}: valore ammesso tra {lo:g} e {hi:g}", f"{key}: allowed range {lo:g} to {hi:g}"))
                self.limits[key] = int(value) if whole else value
        LIMITS_FILE.write_text(json.dumps(self.limits, indent=1))
        return self.limits

    async def daily_pnl(self):
        value, at = self._pnl_cache
        if time.time() - at < DAILY_PNL_TTL:
            return value
        try:
            value = await self.api.daily_pnl()
        except Exception:
            value = None
        self._pnl_cache = (value, time.time())
        return value

    def quote(self, market_id, side):
        """Price an order would fill at: best ask to buy, best bid to sell. Refuses stale data."""
        stats = self.feed.stats.get(market_id)
        if not stats or time.time() - self.feed.updated_at > FEED_MAX_AGE:
            raise Blocked(tr("Prezzi non aggiornati: attendi che il feed riparta", "Prices are stale: wait for the feed to recover"))
        return (stats["ask"] if side > 0 else stats["bid"]) or stats["mark"]

    async def review(self, account, market_id, side, size, price, stop=None, target=None,
                     slippage_bps=None, reduce_only=False, mark=None):
        """Raise Blocked with the first broken rule; return quietly when the order may go."""
        market = self.api.markets.get(market_id)
        if not market:
            raise Blocked(tr("Mercato non disponibile", "Market not available"))
        proposal = Proposal(account, market, side, size, price, stop, target, slippage_bps, mark)
        if reduce_only:
            reason = rule_reduces_position(proposal, self.limits)
            if reason:
                raise Blocked(reason)
            return
        proposal.daily_pnl = await self.daily_pnl() if account is not None else None
        for rule in OPENING_RULES:
            reason = rule(proposal, self.limits)
            if reason:
                raise Blocked(reason)
