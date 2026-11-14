<p align="center"><img src="docs/logo.svg" alt="LighterDeck" width="420"></p>

# LighterDeck

A trading terminal for the perpetual futures on [Lighter](https://lighter.xyz), with server-side automations.

**Try it at [lighterdeck.xyz](https://lighterdeck.xyz)**: charts, the calendar per market, funding and paper trading on Lighter's live prices, no account needed. To trade for real, run your own copy with your API key (below).

[Leggi in italiano](README.it.md) · The interface is available in English, Italian, Chinese (Simplified) and Korean (language menu in the top bar).

## Features

[Order ticket design notes (Italian)](docs/order-ticket.it.md) · Inventory and open decisions for the final ticket.

| Area | What's there |
| --- | --- |
| Charts | 1, 2 or 4 charts (side by side or stacked), 14 timeframes, OHLC legend, volume, entry, liquidation, open orders (SL/TP/limit, draggable to move them) and the managed stop moving on the chart, mark price, macro events, your fills (buy and sell arrows, details on hover), price alerts; each one can be turned on or off from **Elements**. Right-click a price for a limit, the ticket's SL/TP, the position's SL/TP or an alert; right-click a line to cancel that order, remove the alert, stop the trailing or close the position |
| Markets | Live prices for every perpetual, mark/index, funding (click it for the hourly rate over a week, month and year, the next funding countdown, what your position pays and the 24H/1W/1M history), open interest, order book with spread, market picker with search and categories; context badges in the market bar and on each chart: a high-impact event in the next hour, unusual funding (and whether your position pays it), the underlying exchange closed or about to close, your position close to liquidation |
| Orders | Market and limit, post-only, reduce-only, slippage in bps, size in USD / quantity / % of equity / $ risk to the stop; limit price, SL, TP and trailing previewed on the chart while you fill in the ticket; orders and full closes confirmed with a second click, no pop-ups |
| Protection | Native SL/TP sent together with the entry (OTO/OTOCO); scaled exits (2 to 5 take-profit levels, each closing its share of the position, stop to breakeven once TP1 fills); TP and SL shown in the positions table and set or changed from there; partial close 25/50/75/100%, reverse, leverage and cross/isolated |
| Positions | Size with its unit, value, margin with the leverage, entry, mark, liquidation, PnL in $ and % of margin; the market name opens its chart |
| Pair trading | Spread charts of one market over another (search "ETH/BTC", the **Spread** tab or **÷ Spread**), with z-score bands; the Spread tab ranks classic pairs by how stretched they are. On a spread chart the ticket buys one market and sells the other for the same dollar value, checking both legs first and offering to close the first if the second fails. The pair shows as one row (its own quantities, entry and current ratio, combined PnL, funding, nearer liquidation), closes in one click, and has an SL/TP on the ratio |
| Alerts | Price alerts from a chart's right-click or the A key, as lines you can drag; a toast, a sound and a browser notification when the price reaches them, while LighterDeck is open |
| Paper trading | The same screen with simulated money on live prices: market and limit fills, SL/TP, scaled exits, trailing stop, hourly funding and liquidation run in the browser, and the time you were away is replayed from candles. Always on at lighterdeck.xyz, one switch on your own deck |
| Keyboard | B / S side, M / L order type, Enter to send, F close, H close half, R reverse, C cancel limits (the last four need a second press), A alert at the pointer, U funding details, 1–9 and 0 load your favourites into the selected chart, Shift+1–4 select the chart, [ ] or Ctrl with the arrows the timeframe (among those in the toolbar), / search, ? the full list; each key also shows on its button |
| Risk (optional) | Off by default, each one switched on by itself: limits per order, per market and total exposure as a % of equity, daily loss as a % of the equity at 00:00 UTC (open positions included), leverage, number of positions, mandatory stop-loss, no reversals |
| Automations | Managed stop (initial, breakeven, trailing, in PnL % with the position's leverage) and trades on macro events (at the release time or on a range breakout), with a kill switch |
| Calendar | Its own page with filters by market, type (macro, energy, earnings, crypto, yours), impact, period and text, plus a short list for the selected market next to the ticket. This week's economic events (Forex Factory), official BEA releases and Fed meetings, energy reports (EIA crude and gas storage with EIA's holiday schedule, API bulletin, Baker Hughes rig count), quarterly earnings of the stocks on Lighter and of the largest US companies (Nasdaq calendar, with EPS estimate), Deribit's monthly and quarterly BTC/ETH option expiries, your own events for any market (a token unlock, an upgrade), opening hours of the main exchanges with their holidays, half-days and lunch breaks; the calendar, the chart dots and event trades follow the selected market (oil reports for WTI and Brent, a stock's own earnings, the largest companies' earnings for the indices, both currencies for a forex pair) |
| Account | Equity, today's PnL, available margin, leverage and margin used; a PnL curve that leaves out deposits and withdrawals (or the equity curve with them marked), period stats (return, max drawdown, best and worst day, green and red days, volume), a PnL calendar where a click shows that day's trades, realized PnL and funding per market |
| History | Trades grouped by order or as single fills, realized PnL worked out from each fill |
| Links | Every page has its own address (`/trade/WTI`, `/calendar`, `/account`…): share a market (its link preview shows that market's chart, price and 24h change), bookmark a page, use the browser's back button |
| Look | Six themes, English, Italian, Chinese and Korean, layout that works in narrow windows and on phones |

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

## Tests

```
python tests/run_offline.py     # fakes instead of Lighter: nothing leaves your computer
python tests/testnet.py         # real orders on Lighter's testnet, no real money
```

`tests/testnet.py` sends the smallest orders each market accepts through the same code the deck trades
with, and cleans up after itself: leverage with decimals, cross/isolated, limit orders moved and
cancelled, a market entry with SL and TP, conditional orders, TWAP, a basket, Chase and Iceberg on the
engine, RFQ, trades and funding history. It refuses to start on anything that isn't a testnet. Put a
testnet account's API key in `data/testnet.env` (git-ignored):

```
TESTNET_ACCOUNT_INDEX=...
TESTNET_API_KEY_INDEX=...
TESTNET_API_PRIVATE_KEY=...
```

Name one or more scenarios to run only those (`python tests/testnet.py limit twap`, `--list` for the names).

The browser-key path (orders signed in the page) has its own run, `tests/browser_testnet.js`. Start an
instance on the testnet with `LIGHTER_URL=https://testnet.zklighter.elliot.ai`, `PUBLIC_MODE=1` and
`BROWSER_TRADING=1`, connect the testnet key in the page, then in the browser console:

```
await (await import("/tests/browser_testnet.js")).run()
```

## Public site

With `PUBLIC_MODE=1` in the env file the deck runs as a public site (lighterdeck.xyz): it never loads
an API key, refuses every write request, and runs the trade screen in paper trading (simulated money,
kept in each visitor's browser). It greets first-time
visitors with a thin bar (link to this repository and to open a Lighter account, `REFERRAL_URL`)
and a residence check. Visitors from the United States, the United Kingdom and Canada, where Lighter
isn't available, see a page that says so (country from Cloudflare's `CF-IPCountry` header). Your own
calendar events stay in each visitor's browser. Run it as a separate instance from your personal deck.

Add `BROWSER_TRADING=1` and live trading comes first: each visitor connects their own Lighter API key,
which stays in their browser (orders are signed there with Lighter's official signer and go straight to
Lighter; the server never receives the key). Paper trading becomes a choice, one click under the ticket,
and is remembered per browser. `LD_VAULT_KEY` (a secret of your own, kept off the repository) also lets
visitors hand a second API key to the server, encrypted, for the automations that must run with the page
closed.

## Security

- A Lighter API key can open and close positions and withdraw to **your own** wallet, but it
  can't transfer funds to anyone else (that needs the wallet's signature). Use a dedicated API key
  index (e.g. 5), not the one the web app uses.
- Optional hard caps in the env file: `MAX_NOTIONAL_USD`, `MAX_ORDERS_PER_DAY` (empty = no cap).
  The risk limits on the Automations page are optional too: each applies only when ticked (saved in `data/limits.json`).
- The **Auto ON/OFF** button is the kill switch: when OFF the engine sends no orders.
  Stops already placed stay on Lighter.

## Automations

- **Managed stop** (per market): initial stop at -X% from entry, breakeven once the PnL reaches
  +Y%, trailing from the best price (active from a PnL of +W%). PnL % is measured on margin, so it
  includes the position's leverage, as in the positions table. The stop is never loosened.
  On Lighter it is a real reduce-only stop-loss order, so it stays in place even if the server goes down.
  The trailing distance is a PnL % by default, or a price %, a fixed $ amount or a multiple of ATR(14) on 15-minute candles.
  Turn it on straight from the order ticket (**Trailing stop**) or from the **Trailing** button on an open position.
- **Scaled exits**: **+ TP** in the ticket splits the take-profit into 2 to 5 levels, each a reduce-only
  order for its share of the position. A market entry places them at once; for a limit entry they go
  out once it fills. With **Stop to breakeven after TP1** the stop moves to the entry price when the first level fills.
  Those last two need Auto ON.
- **Pair SL/TP**: a stop-loss and a take-profit on a pair's ratio (long leg over short leg). Lighter can't
  trigger on a ratio, so LighterDeck checks it every 2 seconds while Auto is ON and closes both legs' pair
  quantities when one is reached.
- **Event trade**: long/short N seconds after the event, or a breakout of the range of the
  preceding minutes. The entry goes out with native SL/TP; trailing and breakeven then tighten the stop.
  Every automatic entry goes through the same checks as manual orders, including any risk limits you switched on.

The free calendar (Forex Factory) has times, impact, forecast and previous values, but **not the actual figure**.
Rules therefore react to the release time and to price movement, not to the published number.

## Credits

The link preview cards use the Inter and JetBrains Mono fonts (SIL Open Font License, licences in `backend/fonts/`).

Margin, liquidation price and SL/TP formulas (`frontend/formulas.js`), `multiplier` conversions
and SL/TP trigger validation are adapted from
[elliottech/lighter-ts](https://github.com/elliottech/lighter-ts), MIT License, Copyright (c) 2026 Elliot Technologies, Inc.

The language button's translate icon is from Google's [Material Symbols](https://github.com/google/material-design-icons) (Apache-2.0).

Charts by [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0).

Orders signed in the browser use Lighter's official signer, built unchanged from
[elliottech/lighter-go](https://github.com/elliottech/lighter-go) (Apache-2.0) to WebAssembly, with Go's `wasm_exec.js`
(BSD-style licence): see `frontend/signer/README.md`.

## License

LighterDeck is released under the [MIT License](LICENSE).
