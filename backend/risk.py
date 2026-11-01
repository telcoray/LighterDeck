"""Pre-trade guard: every order that opens or adds exposure is reviewed against a set of rules.

Each rule is a small function that looks at a `Proposal` (the order plus the account as it is
now) and returns a reason to refuse it, or None. Rules run in order and the first refusal wins,
so the message the user sees names the most basic problem first.

A few checks always run because the exchange would refuse the order anyway (minimum size, margin,
SL/TP side, stale prices). The risk limits are optional: each one has its own switch in the UI and
all are off by default. Limits are saved in data/limits.json. Size and loss limits are a % of the
account's equity, so they follow the account as it grows or shrinks; the daily loss is a % of the
equity at 00:00 UTC. The optional MAX_NOTIONAL_USD cap in the env file is checked again in
lighter_api just before signing.
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
    "per_order_pct": 5.0,         # % of equity, notional of one order
    "per_market_pct": 15.0,       # % of equity, notional held in one market
    "total_exposure_pct": 50.0,   # % of equity, notional across all markets
    "leverage_cap": 5,
    "daily_loss_pct": 3.0,        # % of the equity at 00:00 UTC
    "open_markets": 3,
    "slippage_bps_cap": 50,       # default slippage for market orders (a setting, not a limit)
}
# limits that only apply when switched on; stop_required and no_flip are switches alone
OPTIONAL = ("per_order_pct", "per_market_pct", "total_exposure_pct", "daily_loss_pct",
            "leverage_cap", "open_markets", "stop_required", "no_flip")
LIMIT_RANGES = {  # accepted values from the UI: (min, max, integer?)
    "per_order_pct": (0.1, 1000, False),
    "per_market_pct": (0.1, 2000, False),
    "total_exposure_pct": (0.1, 5000, False),
    "leverage_cap": (1, 50, True),
    "daily_loss_pct": (0.1, 100, False),
    "open_markets": (1, 50, True),
    "slippage_bps_cap": (1, 300, True),
}
PCT_LIMITS = ("per_order_pct", "per_market_pct", "total_exposure_pct", "daily_loss_pct")
_USD_NAMES = {f"{k[:-4]}_usd": k for k in PCT_LIMITS}  # dollar limits of earlier versions, converted once
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
    check_sides: bool = True   # SL/TP side check; off for the live ticket preview, on when the order is sent
    notional: float = field(init=False)

    @property
    def equity(self):
        return (self.account or {}).get("total_value") or 0.0

    def cap(self, L, key):
        """A % limit in dollars: of today's starting equity for the daily loss, of current equity otherwise."""
        base = self.equity - (self.daily_pnl or 0) if key == "daily_loss_pct" else self.equity
        return base * L[key] / 100

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
    if not p.check_sides:
        return None
    return sltp_trigger_error(p.side, p.price, p.mark, p.stop, p.target)


def on(L, key):
    return L["on"].get(key, False)


def rule_stop_required(p, L):
    if on(L, "stop_required") and not p.stop:
        return tr("Imposta uno stop-loss: è obbligatorio nei tuoi limiti di rischio",
                 "Set a stop-loss: your risk limits require one")


def _pct(L, key):
    return f"{L[key]:g}%"


def rule_order_size(p, L):
    if not on(L, "per_order_pct"):
        return None
    cap = p.cap(L, "per_order_pct")
    if p.notional > cap:
        return tr(f"Ordine da ${p.notional:,.0f}: il tuo limite per ordine è {_pct(L, 'per_order_pct')} del capitale (${cap:,.0f})",
                  f"${p.notional:,.0f} order: your per-order limit is {_pct(L, 'per_order_pct')} of equity (${cap:,.0f})")


def rule_account_loaded(p, L):
    if p.account is None or p.equity <= 0:
        return tr("Account non ancora caricato", "Account not loaded yet")


def rule_no_flip(p, L):
    if on(L, "no_flip") and p.held * p.side < 0:
        return tr("Hai una posizione opposta: chiudila (reduce-only) prima di girarti",
                 "You hold the opposite position: close it (reduce-only) before reversing")


def rule_daily_loss(p, L):
    if not on(L, "daily_loss_pct"):
        return None
    if p.daily_pnl is None:
        return tr("Non riesco a verificare il PnL di oggi: nuove posizioni bloccate per sicurezza",
                  "Today's PnL can't be checked: new positions blocked to be safe")
    cap = p.cap(L, "daily_loss_pct")
    if p.daily_pnl <= -cap:
        return tr(f"Raggiunta la perdita massima di oggi: {p.daily_pnl:,.2f} USD, limite -{_pct(L, 'daily_loss_pct')} (-${cap:,.0f}), posizioni aperte incluse",
                  f"Daily loss limit reached: {p.daily_pnl:,.2f} USD, limit -{_pct(L, 'daily_loss_pct')} (-${cap:,.0f}), open positions included")


def rule_market_exposure(p, L):
    if not on(L, "per_market_pct"):
        return None
    here = next((abs(x["value"]) for x in p.positions if x["market_id"] == p.market.id), 0.0)
    cap = p.cap(L, "per_market_pct")
    if here + p.notional > cap:
        return tr(f"Su {p.market.symbol} supereresti il limite di {_pct(L, 'per_market_pct')} del capitale (${cap:,.0f})",
                  f"This would exceed your {_pct(L, 'per_market_pct')} of equity limit on {p.market.symbol} (${cap:,.0f})")


def rule_total_exposure(p, L):
    if not on(L, "total_exposure_pct"):
        return None
    total = sum(abs(x["value"]) for x in p.positions) + p.notional
    cap = p.cap(L, "total_exposure_pct")
    if total > cap:
        return tr(f"L'esposizione totale supererebbe il {_pct(L, 'total_exposure_pct')} del capitale (${cap:,.0f})",
                  f"Total exposure would exceed {_pct(L, 'total_exposure_pct')} of equity (${cap:,.0f})")


def rule_open_markets(p, L):
    if not on(L, "open_markets"):
        return None
    markets = {x["market_id"] for x in p.positions} | {p.market.id}
    if len(markets) > L["open_markets"]:
        return tr(f"Avresti più di {L['open_markets']} mercati aperti insieme",
                  f"You would have more than {L['open_markets']} markets open at once")


def _leverage(p):
    setting = p.account.get("settings", {}).get(p.market.id, {})
    return setting.get("leverage") or p.market.default_leverage


def rule_leverage(p, L):
    lev = _leverage(p)
    if on(L, "leverage_cap") and lev and lev > L["leverage_cap"]:
        return tr(f"La leva su {p.market.symbol} è {lev:g}x, oltre il tuo limite di {L['leverage_cap']}x: abbassala prima",
                  f"{p.market.symbol} leverage is {lev:g}x, above your {L['leverage_cap']}x limit: lower it first")


def rule_margin(p, L):
    lev = _leverage(p)
    if lev and p.notional / lev > p.account["available"]:
        return tr("Margine disponibile insufficiente", "Not enough available margin")


OPENING_RULES = [
    rule_exchange_minimum, rule_protection_side, rule_stop_required, rule_account_loaded,
    rule_order_size, rule_no_flip, rule_daily_loss, rule_market_exposure, rule_total_exposure,
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
        self.limits = {**DEFAULT_LIMITS, "on": {k: False for k in OPTIONAL}}
        self._usd_to_convert = {}
        if LIMITS_FILE.exists():
            saved = {_OLD_NAMES.get(k, k): v for k, v in json.loads(LIMITS_FILE.read_text()).items()}
            self.limits.update({k: v for k, v in saved.items() if k in DEFAULT_LIMITS})
            self.limits["on"].update({k: bool(v) for k, v in (saved.get("on") or {}).items() if k in OPTIONAL})
            self._usd_to_convert = {_USD_NAMES[k]: v for k, v in saved.items() if k in _USD_NAMES and _USD_NAMES[k] not in saved}
        self._pnl_cache = (None, 0.0)

    def convert_usd_limits(self, account):
        """Dollar limits saved by earlier versions become the same share of today's equity, once."""
        equity = (account or {}).get("total_value") or 0
        if not self._usd_to_convert or equity <= 0:
            return
        for key, usd in self._usd_to_convert.items():
            lo, hi, _ = LIMIT_RANGES[key]
            self.limits[key] = min(hi, max(lo, round(usd / equity * 100, 1)))
        self._usd_to_convert = {}
        LIMITS_FILE.write_text(json.dumps(self.limits, indent=1))

    def update(self, changes):
        for key, value in changes.items():
            if key == "on":
                self.limits["on"].update({k: bool(v) for k, v in value.items() if k in OPTIONAL})
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
                     slippage_bps=None, reduce_only=False, mark=None, check_sides=True):
        """Raise Blocked with the first broken rule; return quietly when the order may go."""
        market = self.api.markets.get(market_id)
        if not market:
            raise Blocked(tr("Mercato non disponibile", "Market not available"))
        self.convert_usd_limits(account)
        proposal = Proposal(account, market, side, size, price, stop, target, slippage_bps, mark, check_sides=check_sides)
        if reduce_only:
            reason = rule_reduces_position(proposal, self.limits)
            if reason:
                raise Blocked(reason)
            return
        if account is not None and on(self.limits, "daily_loss_pct"):
            proposal.daily_pnl = await self.daily_pnl()
        for rule in OPENING_RULES:
            reason = rule(proposal, self.limits)
            if reason:
                raise Blocked(reason)
