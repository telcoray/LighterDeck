<p align="center"><img src="docs/logo.svg" alt="LighterDeck" width="420"></p>

# LighterDeck

A trading terminal for the perpetual futures on [Lighter](https://lighter.xyz), with server-side automations.

**Try it read-only at [lighterdeck.xyz](https://lighterdeck.xyz)**: charts, the calendar per market and funding, no account needed. To trade, run your own copy with your API key (below).

[Leggi in italiano](README.it.md) · The interface is available in English and Italian (button in the top bar).

## Features

| Area | What's there |
| --- | --- |
| Charts | 1, 2 or 4 charts (side by side or stacked), 14 timeframes, OHLC legend, volume, entry, liquidation, open orders (SL/TP/limit, draggable to move them) and the managed stop moving on the chart, mark price, macro events; each one can be turned on or off from **Elements** |
| Markets | Live prices for every perpetual, mark/index, funding (click it for the hourly rate over a week, month and year, the next funding countdown, what your position pays and the 24H/1W/1M history), open interest, order book with spread, market picker with search and categories |
| Orders | Market and limit, post-only, reduce-only, slippage in bps, size in USD / quantity / % of equity / $ risk to the stop; limit price, SL, TP and trailing previewed on the chart while you fill in the ticket; orders and full closes confirmed with a second click, no pop-ups |
| Protection | Native SL/TP sent together with the entry (OTO/OTOCO), TP and SL shown in the positions table and set or changed from there, partial close 25/50/75/100%, leverage and cross/isolated |
| Risk (optional) | Off by default, each one switched on by itself: limits per order, per market and total exposure as a % of equity, daily loss as a % of the equity at 00:00 UTC (open positions included), leverage, number of positions, mandatory stop-loss, no reversals |
| Automations | Managed stop (initial, breakeven, trailing) and trades on macro events (at the release time or on a range breakout), with a kill switch |
| Calendar | Its own page with filters by market, type (macro, energy, earnings, crypto, yours), impact, period and text, plus a short list for the selected market next to the ticket. This week's economic events (Forex Factory), official BEA releases and Fed meetings, energy reports (EIA crude and gas storage with EIA's holiday schedule, API bulletin, Baker Hughes rig count), quarterly earnings of the stocks on Lighter and of the largest US companies (Nasdaq calendar, with EPS estimate), Deribit's monthly and quarterly BTC/ETH option expiries, your own events for any market (a token unlock, an upgrade), opening hours of the main exchanges with their holidays, half-days and lunch breaks; the calendar, the chart dots and event trades follow the selected market (oil reports for WTI and Brent, a stock's own earnings, the largest companies' earnings for the indices, both currencies for a forex pair) |
| History | Trades grouped by order or as single fills, realized PnL worked out from each fill |
| Look | Five themes, English and Italian, layout that works in narrow windows and on phones |

```
frontend/   web page (HTML/CSS/JS, TradingView Lightweight Charts)
backend/    FastAPI: Lighter data, calendar, risk checks, order signing (official SDK), automation engine
deploy/     systemd services, nginx site for the public instance, example configuration
tools/      link preview card (og.png), exchange sessions for the market hours (exchange_hours.json)
```

## Run it locally

```
python -m venv .venv
.venv\Scripts\pip install -r backend\requirements.txt
.venv\Scripts\python backend\main.py
```
Then open http://127.0.0.1:8200 (on macOS/Linux use `.venv/bin/` instead of `.venv\Scripts\`).

Without an API key the deck is read-only: charts, prices, order book and calendar all work.
To trade, click **Read-only** in the top bar and connect an API key: the server checks it with
Lighter and saves it in `data/credentials.json` (it is never sent back to the browser). A key set
in the server's env file takes precedence and can't be changed from the UI.

## On a server

The backend listens only on 127.0.0.1:8200. It is not exposed to the internet; reach it through an SSH tunnel:

```
ssh -N -L 8200:127.0.0.1:8200 user@your-server
```
Then open http://127.0.0.1:8200 on your computer.

One-time install:

```
adduser --system --group --home /opt/lighterdeck lighterdeck
mkdir -p /var/lib/lighterdeck /etc/lighterdeck && chown lighterdeck: /var/lib/lighterdeck
# copy backend/, frontend/, deploy/ to /opt/lighterdeck
python3 -m venv /opt/lighterdeck/.venv && /opt/lighterdeck/.venv/bin/pip install -r /opt/lighterdeck/backend/requirements.txt
cp /opt/lighterdeck/deploy/lighterdeck.env.example /etc/lighterdeck/lighterdeck.env   # then fill it in
chown root:lighterdeck /etc/lighterdeck/lighterdeck.env && chmod 640 /etc/lighterdeck/lighterdeck.env
cp /opt/lighterdeck/deploy/lighterdeck.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now lighterdeck
```

## Public read-only site

With `PUBLIC_MODE=1` in the env file the deck runs as a public site (lighterdeck.xyz): it never loads
an API key, refuses every write request, hides automations and positions, and greets first-time
visitors with a thin bar (link to this repository and to open a Lighter account, `REFERRAL_URL`)
and a residence check. Visitors from the United States, the United Kingdom and Canada, where Lighter
isn't available, see a page that says so (country from Cloudflare's `CF-IPCountry` header). Your own
calendar events stay in each visitor's browser. Run it as a separate instance from your personal deck.

## Security

- A Lighter API key can open and close positions and withdraw to **your own** wallet, but it
  can't transfer funds to anyone else (that needs the wallet's signature). Use a dedicated API key
  index (e.g. 5), not the one the web app uses.
- Optional hard caps in the env file: `MAX_NOTIONAL_USD`, `MAX_ORDERS_PER_DAY` (empty = no cap).
  The risk limits on the Automations page are optional too: each applies only when ticked (saved in `data/limits.json`).
- The **Auto ON/OFF** button is the kill switch: when OFF the engine sends no orders.
  Stops already placed stay on Lighter.

## Automations

- **Managed stop** (per market): initial stop at -X% from entry, breakeven once profit reaches
  +Y%, trailing Z% from the best price (active from +W%). The stop is never loosened.
  On Lighter it is a real reduce-only stop-loss order, so it stays in place even if the server goes down.
  The trailing distance can be a %, a fixed $ amount or a multiple of ATR(14) on 15-minute candles.
  Turn it on straight from the order ticket (**Trailing stop**) or from the **Trailing** button on an open position.
- **Event trade**: long/short N seconds after the event, or a breakout of the range of the
  preceding minutes. The entry goes out with native SL/TP; trailing and breakeven then tighten the stop.
  Every automatic entry goes through the same checks as manual orders, including any risk limits you switched on.

The free calendar (Forex Factory) has times, impact, forecast and previous values, but **not the actual figure**.
Rules therefore react to the release time and to price movement, not to the published number.

## Credits

Margin, liquidation price and SL/TP formulas (`frontend/formulas.js`), `multiplier` conversions
and SL/TP trigger validation are adapted from
[elliottech/lighter-ts](https://github.com/elliottech/lighter-ts), MIT License, Copyright (c) 2026 Elliot Technologies, Inc.

Charts by [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0).
