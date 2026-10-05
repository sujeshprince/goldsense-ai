# GoldSense AI

A dark-themed **gold futures analytics terminal** that runs entirely in the browser. It normalizes
MCX-style gold contracts to a common 10-gram equivalent, detects cross-contract arbitrage, ranks
every contract with a conviction score, and ships a backtester — all on a synthetic market engine
generated client-side.

Zero backend. Zero build step. Three files.

```
index.html    866 lines   markup, icon sprite, 8 views, 4 modals
style.css     978 lines   design tokens, components, responsive rules
script.js    2083 lines   simulation, analytics, charts, router, UI
```

## Run it

Open `index.html` in any modern browser. That's the whole install — it works from `file://`
because nothing uses ES modules or `fetch`.

```
start index.html
```

Or serve it, if you prefer:

```bash
npx http-server -p 8899 -c-1 .
```

## What's in it

**Dashboard** — hero, five live KPI cards, price chart, contract intelligence table, AI arbitrage
scanner, AI trading signals, AI insight panel, correlation heatmap, smart alerts.

**Market Overview** — spot vs. futures, volume/open interest, basis ladder.

**Arbitrage Scanner** — every contract pair re-priced each cycle, ranked by absolute difference,
with a buy on the cheaper leg against a sell on the richer leg.

**Contract Analysis** — per-contract z-score, spread distribution, band history, liquidity.

**Signals** — BUY / SELL / HOLD with animated conviction bars and the reasoning behind each call.

**Alerts** — filterable alert center with unread tracking.

**Backtesting** — seeded replay of the strategy logic with sharpe, sortino, max drawdown, win rate,
profit factor and net P&L.

**Settings** — accent theme, density, motion, feed speed, all persisted to `localStorage`.

Keyboard: `/` focuses search, `Esc` closes dialogs, `1`–`8` jump between views.

## How the numbers are made

There is no exchange connection. `MarketSim` is a **mean-reverting (Ornstein–Uhlenbeck style) random
walk** around a slowly drifting reference price:

1. Each contract carries a **lot weight**, so prices reduce to a 10-gram equivalent.
2. A volume-weighted consensus of spot plus the three contracts forms the **AI reference**, smoothed
   over a rolling window.
3. `spread = contract price − reference`. A dislocation beyond **±₹40** is actionable.
4. **Confidence** blends |z-score| of the spread, contract liquidity, and recent spread volatility.

Seeded contracts: `GOLDM`, `GOLDTEN`, `GOLDPETAL`, plus spot. Historical tape for all five
timeframes (1H / 4H / 1D / 1W / 1M) is seeded with a mulberry32 PRNG at boot; live ticks append to
the active timeframe every 2–4 seconds.

The backtester uses the same seeded generator, so a given configuration always replays to the same
curve.

## Tech notes

- **No dependencies.** Chart.js 4.4.3 loads from jsDelivr as an optional enhancement.
- **Canvas fallback.** If the CDN is blocked — offline, locked-down network, corporate proxy — the
  dashboard detects the absence of `Chart` and renders every chart through a small built-in canvas
  renderer, so the UI never comes up blank.
- **No `localStorage` requirement.** Settings degrade gracefully when storage is unavailable.
- Hash-based router (`#/dashboard`, `#/arbitrage`) so views work from `file://`.

## Testing

Logic was verified headlessly under jsdom with three suites:

| Suite | Coverage |
|---|---|
| `smoke.js` | 115 assertions — boot, rendering, router, ticks, timeframes, search, modals, scan overlay, alerts, backtester, settings, keyboard |
| `stress.js` | 600 simulation cycles — NaN guards, price bands, signal distribution, arbitrage invariants, alert buffer caps |
| `chartapi.js` | 67 assertions — Chart.js config surface (datasets, formatters, update modes) |

216 assertions, all passing. Real Chart.js rasterization can't be exercised under jsdom (no layout
engine), so pixel-level rendering is confirmed only in a browser.

## Disclaimer

GoldSense AI is a **front-end prototype built for demonstration purposes**.

It executes no trades, connects to no exchange, and routes no orders. The BUY and SELL buttons are
disabled by design — pressing one returns *"Trading execution is disabled in this prototype."* All
prices, volumes, spreads and signals come from a synthetic simulator and are **not financial
advice**. Nothing here is a recommendation to buy or sell any instrument.

MIT licensed.