/* ============================================================================
 * GoldSense AI — script.js
 * Real-Time Gold Futures Intelligence · 100% client-side simulation
 *
 * Architecture (independent modules, loosely coupled via a tiny event bus):
 *   00  Utils          — formatting, DOM helpers, number animations, RNG
 *   01  Config         — contract definitions, timeframes, insight templates
 *   02  MarketSim      — synthetic MCX gold futures engine (random walk)
 *   03  Analytics      — normalization, spreads, signals, arbitrage, insights
 *   04  AlertCenter    — alert generation, filtering, read state
 *   05  ChartLayer     — Chart.js wrappers + dependency-free canvas fallback
 *   06  UI             — rendering of KPIs, tables, signals, heatmap, toasts
 *   07  ModalLayer     — contract detail, scan overlay, execution, docs
 *   08  Router         — hash based view switching
 *   09  Search         — command palette style search
 *   10  Backtester     — strategy replay with synthetic results
 *   11  StatusBar      — IST clock + market session state
 *   12  Settings       — preferences persisted to localStorage
 *   13  Boot           — wiring and start-up sequence
 * ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
   * 00 · UTILS
   * ==================================================================== */
  const U = (() => {
    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    /** Format a number as Indian-locale currency, e.g. ₹72,842.50 */
    function inr(value, decimals) {
      const d = decimals === undefined ? 2 : decimals;
      const n = Number(value) || 0;
      return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
    }

    /** Format a percentage with an explicit sign, e.g. +1.12% */
    function pct(value, decimals) {
      const d = decimals === undefined ? 2 : decimals;
      const n = Number(value) || 0;
      return (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
    }

    /** Format a signed rupee delta, e.g. −₹25.00 */
    function signedInr(value) {
      const n = Number(value) || 0;
      return (n >= 0 ? '+' : '−') + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const round2 = (v) => Math.round(v * 100) / 100;
    const rand = (lo, hi) => lo + Math.random() * (hi - lo);
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const nowISO = () => new Date().toISOString();
    const timeAgo = (ts) => {
      const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
      if (s < 5) return 'just now';
      if (s < 60) return s + 's ago';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      return Math.floor(m / 60) + 'h ago';
    };
    const clockTime = (ts) =>
      new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    /** Seeded pseudo-random generator (mulberry32) for reproducible backtests. */
    function seeded(seed) {
      let a = seed >>> 0;
      return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const escapeHtml = (str) =>
      String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Create an element with class and optional innerHTML. */
    function make(tag, cls, html) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (html !== undefined) node.innerHTML = html;
      return node;
    }

    /**
     * Tween a number inside an element (used for "counting" micro-interactions).
     * Falls back to an instant write when prefers-reduced-motion is active.
     */
    function animateNumber(node, from, to, opts) {
      if (!node) return;
      const o = opts || {};
      const dur = o.duration || 620;
      const dec = o.decimals === undefined ? 2 : o.decimals;
      const fmt = o.format || ((v) => v.toFixed(dec));
      if (document.documentElement.dataset.motion === 'reduced' || Math.abs(to - from) < 0.005) {
        node.textContent = fmt(to);
        return;
      }
      const start = performance.now();
      const fromV = from;
      function frame(now) {
        const t = clamp((now - start) / dur, 0, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        node.textContent = fmt(fromV + (to - fromV) * eased);
        if (t < 1) requestAnimationFrame(frame);
        else node.textContent = fmt(to);
      }
      requestAnimationFrame(frame);
    }

    /** Restart a CSS animation class (e.g. price pulse). */
    function pulse(node, cls) {
      if (!node || !cls) return;
      node.classList.remove(cls);
      void node.offsetWidth; // force reflow so the animation replays
      node.classList.add(cls);
    }

    function debounce(fn, wait) {
      let t;
      return function () {
        clearTimeout(t);
        const args = arguments, ctx = this;
        t = setTimeout(() => fn.apply(ctx, args), wait);
      };
    }

    /** Size a canvas for the device pixel ratio and return its 2D context. */
    function canvas2d(canvas, cssHeight) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
      const h = cssHeight || canvas.clientHeight || 200;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.height = h + 'px';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx, w, h };
    }

    return { $, $$, inr, pct, signedInr, clamp, round2, rand, pick, nowISO, timeAgo, clockTime, seeded, escapeHtml, make, animateNumber, pulse, debounce, canvas2d };
  })();

  /* ======================================================================
   * 01 · CONFIG
   * ==================================================================== */
  const ACCENT = '#F5C542';
  const SERIES_COLORS = {
    GOLDM: '#F5C542',
    GOLDTEN: '#3B82F6',
    GOLDPETAL: '#22C55E',
    REF: '#F8FAFC',
    SPOT: '#A78BFA'
  };

  const CONTRACTS = [
    { id: 'GOLDM', label: 'Gold Mini', unit: '10 g', grams: 10, base: 72910.0, baseChange: 1.12, vol: 22, oi: 18420, note: 'Most liquid mini contract on MCX.' },
    { id: 'GOLDTEN', label: 'Gold Ten', unit: '1 g', grams: 1, base: 72875.4, baseChange: 0.97, vol: 18, oi: 9240, note: 'Tight per-gram quoting, low basis noise.' },
    { id: 'GOLDPETAL', label: 'Gold Petal', unit: '100 g', grams: 100, base: 72942.8, baseChange: 1.31, vol: 26, oi: 6115, note: 'Premium-heavy large lot, widest spreads.' }
  ];

  const SPOT_SEED = { price: 72842.5, change: 0.84 };
  const REFERENCE_SEED = 72900;

  const TIMEFRAMES = {
    '1H': { points: 60, stepMs: 60 * 1000, label: '1H' },
    '4H': { points: 80, stepMs: 3 * 60 * 1000, label: '4H' },
    '1D': { points: 96, stepMs: 15 * 60 * 1000, label: '1D' },
    '1W': { points: 84, stepMs: 60 * 60 * 1000, label: '1W' },
    '1M': { points: 90, stepMs: 4 * 60 * 60 * 1000, label: '1M' }
  };

  const SPREAD_THRESHOLD = 40; // ₹ — beyond this a dislocation is "actionable"
  const OI_HISTORY = 96;

  /** Human-readable reason templates used by the signal engine. */
  const SIGNAL_REASONS = {
    BUY: [
      (c, s) => `${c.id} is trading below normalized contract value by ₹${Math.abs(s.spread).toFixed(0)}.`,
      (c, s) => `Discount of ₹${Math.abs(s.spread).toFixed(0)} versus the AI reference — mean reversion favours longs.`,
      (c, s) => `${c.id} prints at a ${Math.abs(s.z).toFixed(1)}σ discount to fair value; accumulation zone.`
    ],
    SELL: [
      (c, s) => `Premium detected compared with normalized gold price (+₹${Math.abs(s.spread).toFixed(0)}).`,
      (c, s) => `${c.id} trades ${Math.abs(s.z).toFixed(1)}σ above fair value — premium is historically wide.`,
      (c, s) => `Richening basis of ₹${Math.abs(s.spread).toFixed(0)} argues for booking profits.`
    ],
    HOLD: [
      (c, s) => 'Price currently aligned with normalized value.',
      (c, s) => `Basis inside the ±₹${SPREAD_THRESHOLD} band — no edge worth taking.`,
      (c, s) => `Deviation of ₹${Math.abs(s.spread).toFixed(0)} is within normal noise for this contract.`
    ]
  };

  const INSIGHT_TEMPLATES = [
    (m) => `${m.a} is currently trading ₹${Math.abs(m.spreadA).toFixed(0)} ${m.dirA} its normalized reference price. The current spread exceeds the historical threshold, creating a potential arbitrage opportunity.`,
    (m) => `The ${m.b} leg is priced ${m.zB}σ away from fair value while ${m.a} remains anchored. Pairing them isolates ${m.oppPct.toFixed(3)}% of modelled spread with ${m.conf}% confidence.`,
    (m) => `Cross-contract dispersion has widened to ₹${Math.abs(m.spreadA).toFixed(0)} on ${m.a}. The normalizer flags a ${m.regime} regime, so ${m.action} before the basis decays.`,
    (m) => `${m.b} shows a ${m.conf}% conviction ${m.dir} profile. Over the last ${m.window} the mean absolute spread sat at ₹${m.mas}, so the current dislocation sits in the ${m.percentile} percentile.`,
    (m) => `Momentum and basis disagree: trend is ${m.trend}, yet ${m.a} carries a ₹${Math.abs(m.spreadA).toFixed(0)} premium. Momentum traders are paying for the move; the model is fading it.`,
    (m) => `Liquidity is concentrated in ${m.a} while ${m.b} carries the wider quote. Transferring size from ${m.b} into ${m.a} captures roughly ${m.oppPct.toFixed(3)}% gross before costs.`,
    (m) => `No single contract is mispriced enough to trade alone, but the ${m.a}/${m.b} pair implies a ${m.oppPct.toFixed(3)}% convergence gap. Confidence ${m.conf}%, risk ${m.risk.toLowerCase()}.`,
    (m) => `Gold futures are ${m.regime} with realized volatility at ${m.vol}% annualized. The AI engine keeps exposure hedged and only flags pairs where spread exceeds ₹${m.threshold}.`
  ];

  const DOCS = {
    documentation: {
      title: 'Documentation',
      html: `
        <p>GoldSense AI is a client-side prototype of a gold futures analytics terminal. Every number on screen is
        produced by a synthetic market engine running in your browser — no exchange connectivity, no backend, no
        order routing.</p>
        <h4>Normalization pipeline</h4>
        <ul>
          <li>Each contract is reduced to a <strong>10-gram equivalent</strong> price using its lot weight.</li>
          <li>The <strong>AI reference</strong> is a volume-weighted consensus of spot and the three contracts, smoothed over a rolling window.</li>
          <li>Spread = contract price − reference. The threshold for an actionable dislocation is <code>±₹40</code>.</li>
          <li>Confidence combines |z-score| of the spread, contract liquidity and recent spread volatility.</li>
        </ul>
        <h4>Arbitrage detection</h4>
        <p>Every contract pair is re-priced each cycle. Pairs are ranked by absolute difference, and the model
        proposes a buy on the cheaper leg against a sell on the richer leg. Legs are ranked by liquidity so the
        proposed size is achievable in theory.</p>
        <h4>Signals</h4>
        <p><span class="badge badge--buy">BUY</span> prints below fair value, <span class="badge badge--sell">SELL</span> above it,
        and <span class="badge badge--hold">HOLD</span> inside the noise band. Signals are analytical observations only.</p>
        <h4>Backtester</h4>
        <p>The backtester replays a seeded synthetic tape so the same configuration always returns the same curve.
        It is a visualisation of the strategy logic, not a performance claim.</p>
        <h4>Keyboard</h4>
        <ul><li><code>/</code> focus search · <code>Esc</code> close dialogs · <code>1</code>–<code>8</code> jump between views.</li></ul>`
    },
    privacy: {
      title: 'Privacy',
      html: `
        <p>GoldSense AI runs entirely inside your browser tab. There is no server, no telemetry, no analytics
        script and no third-party data call other than the public CDN that serves Chart.js and the web font.</p>
        <h4>What is stored locally</h4>
        <ul>
          <li>Interface preferences (accent colour, density, motion, feed speed) in <code>localStorage</code>.</li>
          <li>No personal data, no cookies, no identifiers, no account.</li>
        </ul>
        <h4>Third parties</h4>
        <p>Chart.js is loaded from jsDelivr and fonts from Google Fonts; both are optional — the dashboard renders
        with a built-in canvas fallback if the CDN is blocked. Simulated prices are generated in memory and are
        lost when the tab closes.</p>`
    },
    disclaimer: {
      title: 'Disclaimer',
      html: `
        <p><strong>GoldSense AI is a technology prototype for analytics and educational demonstration.</strong>
        Market prices shown in this frontend are simulated and should not be considered financial advice or an
        instruction to trade.</p>
        <h4>No financial advice</h4>
        <p>Nothing in this interface is a recommendation to buy or sell any security, commodity or derivative.
        BUY / SELL labels are model classifications of a synthetic dataset.</p>
        <h4>No execution</h4>
        <p>Order entry is disabled by design. The “Execute Analysis” and signal buttons only open an explanation of
        the analysis — no order is transmitted to any exchange, broker or venue.</p>
        <h4>Data accuracy</h4>
        <p>Prices, volumes, open interest and volatility are produced by a random-walk simulator. They do not
        represent MCX or any other real market and must never be used for pricing, risk or settlement decisions.</p>`
    }
  };

  /* ======================================================================
   * 02 · MARKET SIMULATION
   * A mean-reverting random walk around a slowly drifting reference price.
   * Each tick nudges prices, changes, spreads and volumes realistically.
   * ==================================================================== */
  const MarketSim = (() => {
    const state = {
      reference: REFERENCE_SEED,
      spot: SPOT_SEED.price,
      spotChange: SPOT_SEED.change,
      contracts: {},
      history: { labels: [], series: {}, spread: {}, volume: [] },
      cycle: 0,
      lastTick: Date.now()
    };

    // ---- initialise contract state -------------------------------------
    CONTRACTS.forEach((c) => {
      state.contracts[c.id] = {
        ...c,
        price: c.base,
        prev: c.base,
        open: c.base / (1 + c.baseChange / 100),
        change: c.baseChange,
        spread: c.base - REFERENCE_SEED,
        volume: Math.round(U.rand(8000, 16000)),
        oi: c.oi,
        vol24: c.vol,
        oiHistory: [],
        spark: []
      };
    });
    seedHistory();

    /** Build a plausible intraday tape for every timeframe up-front. */
    function seedHistory() {
      const rng = U.seeded(20240917);
      const ids = CONTRACTS.map((c) => c.id);
      Object.keys(TIMEFRAMES).forEach((tf) => {
        const spec = TIMEFRAMES[tf];
        const labels = [];
        const series = { REF: [], SPOT: [] };
        ids.forEach((id) => (series[id] = []));
        let ref = REFERENCE_SEED;
        const start = Date.now() - spec.points * spec.stepMs;
        for (let i = 0; i < spec.points; i++) {
          ref += (rng() - 0.5) * 26;
          ref = U.clamp(ref, REFERENCE_SEED - 260, REFERENCE_SEED + 260);
          labels.push(new Date(start + i * spec.stepMs));
          series.REF.push(U.round2(ref));
          ids.forEach((id, k) => {
            const base = state.contracts[id].base;
            const drift = (base - REFERENCE_SEED) * (0.55 + 0.45 * (i / spec.points));
            series[id].push(U.round2(ref + drift + (rng() - 0.5) * 46 - k * 2));
          });
          series.SPOT.push(U.round2(series.REF[series.REF.length - 1] - 58 + (rng() - 0.5) * 12));
        }
        state.history[tf] = { labels, series, spec };
      });
      // The dashboard chart mirrors the currently selected timeframe
      syncActiveView();
    }

    /** Point the convenience aliases at the active timeframe. */
    function syncActiveView() {
      const store = state.history[state.activeTf || '1D'];
      if (!store) return;
      state.history.labels = store.labels;
      state.history.series = store.series;
    }

    /** Widest pairwise spread — drives the Arbitrage KPI card. */
    function widestSpread() {
      const ids = CONTRACTS.map((c) => c.id);
      let best = { a: ids[0], b: ids[1], diff: 0 };
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const diff = state.contracts[ids[i]].price - state.contracts[ids[j]].price;
          if (Math.abs(diff) > Math.abs(best.diff)) best = { a: ids[i], b: ids[j], diff: U.round2(diff) };
        }
      }
      return best;
    }

    /** Rolling series of the widest pairwise spread, for the KPI sparkline. */
    function spreadHistory() {
      const store = state.history[state.activeTf || '1D'];
      if (!store) return [];
      const out = [];
      const n = store.labels.length;
      for (let i = 0; i < n; i++) {
        let m = 0, pa = '', pb = '';
        for (let a = 0; a < CONTRACTS.length; a++) {
          for (let b = a + 1; b < CONTRACTS.length; b++) {
            const d = Math.abs(store.series[CONTRACTS[a].id][i] - store.series[CONTRACTS[b].id][i]);
            if (d > m) { m = d; pa = CONTRACTS[a].id; pb = CONTRACTS[b].id; }
          }
        }
        out.push({ diff: m, a: pa, b: pb });
      }
      return out;
    }

    /** Recompute derived values (spread, change, sparkline buffers). */
    function recompute(id) {
      const c = state.contracts[id];
      c.spread = U.round2(c.price - state.reference);
      c.change = U.round2(((c.price - c.open) / c.open) * 100);
      c.spark.push(c.price);
      if (c.spark.length > 40) c.spark.shift();
    }

    /** One simulation cycle — the heart of the live feed. */
    function tick() {
      state.cycle += 1;
      state.lastTick = Date.now();

      // Reference price: slow drift with gentle mean reversion
      const refDrift = (REFERENCE_SEED - state.reference) * 0.02 + U.rand(-14, 14);
      state.reference = U.clamp(U.round2(state.reference + refDrift), REFERENCE_SEED - 320, REFERENCE_SEED + 320);

      // Spot tracks the reference with a persistent small discount
      state.spot = U.round2(state.reference - 57.5 + U.rand(-7, 7));

      // Each contract: Ornstein–Uhlenbeck style pull toward reference + noise
      CONTRACTS.forEach((def) => {
        const c = state.contracts[def.id];
        c.prev = c.price;
        const pull = (state.reference - c.price) * 0.045;
        const shock = U.rand(-def.vol, def.vol) * 0.42;
        c.price = U.round2(c.price + pull + shock);
        c.volume += Math.round(U.rand(12, 190));
        c.oi = Math.round(c.oi + U.rand(-9, 11));
        c.vol24 = U.round2(def.vol * (0.9 + Math.abs(shock) / def.vol) * 1.1);
        c.oiHistory.push(c.oi);
        if (c.oiHistory.length > OI_HISTORY) c.oiHistory.shift();
        recompute(def.id);
      });

      pushHistoryPoint();
      return state;
    }

    /** Append a live point to the active timeframe series. */
    function pushHistoryPoint() {
      const tf = state.activeTf || '1D';
      const store = state.history[tf];
      if (!store) return;
      const now = new Date();
      store.labels.push(now);
      store.series.REF.push(U.round2(state.reference));
      store.series.SPOT.push(state.spot);
      CONTRACTS.forEach((c) => store.series[c.id].push(state.contracts[c.id].price));
      const cap = TIMEFRAMES[tf].points + 60;
      if (store.labels.length > cap) {
        store.labels.shift();
        Object.keys(store.series).forEach((k) => store.series[k].shift());
      }
      syncActiveView();
    }

    /** Rebuild the seeded tape (used by "Reset simulation"). */
    function reset() {
      state.reference = REFERENCE_SEED;
      state.spot = SPOT_SEED.price;
      state.cycle = 0;
      CONTRACTS.forEach((c) => {
        const s = state.contracts[c.id];
        s.price = s.base; s.prev = s.base; s.open = c.base / (1 + c.baseChange / 100);
        s.change = c.baseChange; s.volume = Math.round(U.rand(8000, 16000));
        s.oi = c.oi; s.spark = []; s.oiHistory = [];
        recompute(c.id);
      });
      state.history = { labels: [], series: {}, spread: {}, volume: [] };
      seedHistory();
    }

    function get(id) { return state.contracts[id]; }
    function setActiveTimeframe(tf) { state.activeTf = tf; syncActiveView(); }

    return { state, tick, reset, recompute, widestSpread, spreadHistory, get, setActiveTimeframe, seedHistory };
  })();

  /* ======================================================================
   * 03 · ANALYTICS
   * Turns raw simulated prices into spreads, signals, arbitrage and text.
   * ==================================================================== */
  const Analytics = (() => {
    const cache = { signals: [], opportunities: [], pairs: [], insight: null, regime: 'Bullish', risk: 'Moderate' };

    /* Insight templates are drawn from a shuffled bag: every template is used once
       before any repeat, so "Generate New Insight" never re-prints the same copy. */
    let templateBag = [];
    function nextTemplate() {
      if (!templateBag.length) {
        templateBag = INSIGHT_TEMPLATES.map((t, i) => i);
        for (let i = templateBag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = templateBag[i]; templateBag[i] = templateBag[j]; templateBag[j] = tmp;
        }
      }
      return INSIGHT_TEMPLATES[templateBag.pop()];
    }

    /** z-score of a contract's spread against its own volatility envelope. */
    function zScore(c) {
      return c.spread / Math.max(c.vol24, 1);
    }

    /** Map |z| to a 0–100 conviction score. */
    function confidenceFromZ(z, kind) {
      if (kind === 'hold') return Math.round(U.clamp(60 + (1 - Math.min(Math.abs(z), 1)) * 24, 58, 84));
      return Math.round(U.clamp(52 + Math.abs(z) * 26, 55, 97));
    }

    /** Classify one contract into BUY / SELL / HOLD. */
    function signalFor(c) {
      const z = zScore(c);
      let type = 'HOLD';
      if (z <= -0.35) type = 'BUY';
      else if (z >= 0.35) type = 'SELL';
      const confidence = confidenceFromZ(z, type.toLowerCase());
      const pool = SIGNAL_REASONS[type];
      const reason = U.pick(pool);
      return {
        id: c.id, contract: c, type, z: U.round2(z), confidence,
        spread: c.spread, reason: reason(c, { spread: c.spread, z: U.round2(z) })
      };
    }

    /** Build the ranked signal set, ordered by conviction. */
    function computeSignals() {
      cache.signals = CONTRACTS.map((d) => signalFor(MarketSim.get(d.id)))
        .sort((a, b) => b.confidence - a.confidence);
      return cache.signals;
    }

    /** Analyse every unordered contract pair. */
    function computePairs() {
      const ids = CONTRACTS.map((c) => c.id);
      const pairs = [];
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const A = MarketSim.get(ids[i]);
          const B = MarketSim.get(ids[j]);
          const diff = U.round2(A.price - B.price);
          const pctDiff = (diff / MarketSim.state.reference) * 100;
          const vol = Math.sqrt(A.vol24 * A.vol24 + B.vol24 * B.vol24) || 1;
          const z = Math.abs(diff) / vol;
          const buy = diff < 0 ? A : B;   // cheaper leg
          const sell = diff < 0 ? B : A;  // richer leg
          // Liquidity + magnitude weighted conviction
          const liq = Math.min(1, (buy.volume + sell.volume) / 32000);
          const confidence = Math.round(U.clamp(44 + z * 22 + liq * 16, 52, 97));
          pairs.push({
            a: A.id, b: B.id, buy: buy.id, sell: sell.id, diff: Math.abs(diff),
            pct: Math.abs(pctDiff), z: U.round2(z), confidence,
            action: 'BUY ' + buy.id + ' → SELL ' + sell.id
          });
        }
      }
      cache.pairs = pairs.sort((x, y) => y.diff - x.diff);
      return cache.pairs;
    }

    /** Top opportunities worth surfacing (always three pairs exist). */
    function computeOpportunities() {
      const pairs = computePairs();
      cache.opportunities = pairs.slice(0, 3).map((p, i) => {
        const buy = MarketSim.get(p.buy);
        const sell = MarketSim.get(p.sell);
        const tier = p.confidence >= 85 ? 'high' : p.confidence >= 68 ? 'mid' : 'low';
        return {
          ...p,
          rank: i + 1,
          tier,
          notional: Math.round(Math.min(buy.volume, sell.volume) * 0.35),
          window: U.pick(['~2h', '~4h', '~1D', 'intraday']),
          detectedAt: Date.now() - state0() * 1000
        };
      });
      return cache.opportunities;
    }
    const state0 = () => Math.round(U.rand(4, 55));

    /** Market regime + risk read from aggregate basis behaviour. */
    function computeRegime() {
      const s = MarketSim.state;
      const ref = s.reference;
      const drift = (ref - REFERENCE_SEED) / REFERENCE_SEED * 100;
      const avgAbs = CONTRACTS.reduce((acc, d) => acc + Math.abs(s.contracts[d.id].spread), 0) / CONTRACTS.length;
      if (drift > 0.08) cache.regime = 'Bullish';
      else if (drift < -0.08) cache.regime = 'Bearish';
      else cache.regime = 'Range-bound';
      cache.risk = avgAbs > 38 ? 'High' : avgAbs > 16 ? 'Moderate' : 'Low';
      return cache;
    }

    /** Compose a fresh AI insight from live numbers. */
    function computeInsight() {
      const sig = cache.signals.length ? cache.signals : computeSignals();
      const pairs = cache.pairs.length ? cache.pairs : computePairs();
      const s = MarketSim.state;
      const top = sig[0];
      const second = sig[1] || top;
      const pair = pairs[0];
      const spreadA = top.spread;
      const metrics = {
        a: top.id,
        b: second.id,
        spreadA: U.round2(spreadA),
        dirA: spreadA >= 0 ? 'above' : 'below',
        dirB: second.type === 'BUY' ? 'BUY' : second.type,
        zB: Math.abs(second.z).toFixed(1),
        conf: top.confidence,
        oppPct: pair.pct,
        regime: cache.regime,
        risk: cache.risk,
        action: top.type === 'BUY' ? 'accumulating the cheaper leg' : top.type === 'SELL' ? 'fading the premium' : 'staying flat',
        window: U.pick(['30 minutes', '2 hours', 'one session']),
        mas: U.round2(CONTRACTS.reduce((a, d) => a + Math.abs(s.contracts[d.id].spread), 0) / 3).toFixed(0),
        percentile: U.pick(['82nd', '91st', '74th', '88th']),
        trend: U.pick(['firm', 'soft', 'flat']),
        vol: (CONTRACTS.reduce((a, d) => a + s.contracts[d.id].vol24, 0) / 3 / 10).toFixed(1),
        threshold: SPREAD_THRESHOLD
      };
      const text = nextTemplate()(metrics);
      cache.insight = { text, confidence: top.confidence, risk: cache.risk, condition: cache.regime };
      return cache.insight;
    }

    return { computeSignals, computePairs, computeOpportunities, computeRegime, computeInsight, zScore, cache };
  })();

  /* ======================================================================
   * 04 · ALERT CENTER
   * ==================================================================== */
  const AlertCenter = (() => {
    const MAX_ALERTS = 60;
    let items = [];
    let unread = 0;
    let seq = 0;
    const listeners = [];

    function subscribe(fn) { listeners.push(fn); }

    /** Recount unread from the live list — keeps the badge correct after trimming. */
    function recount() {
      unread = items.reduce((n, a) => n + (a.read ? 0 : 1), 0);
    }

    function push(kind, title, text) {
      const item = {
        id: 'a' + (++seq) + '-' + Date.now().toString(36),
        kind, title, text, ts: Date.now(), read: false
      };
      items.unshift(item);
      // Hard cap on retained alerts; recount so dropped reads never inflate the badge.
      if (items.length > MAX_ALERTS) items.length = MAX_ALERTS;
      recount();
      listeners.forEach((fn) => fn(item));
      return item;
    }

    function markAllRead() { items.forEach((i) => (i.read = true)); recount(); listeners.forEach((fn) => fn(null)); }
    function clear() { items = []; unread = 0; listeners.forEach((fn) => fn(null)); }

    /** Remove a single alert, recomputing the unread counter. */
    function remove(id) {
      const idx = items.findIndex((a) => a.id === id);
      if (idx === -1) return false;
      items.splice(idx, 1);
      recount();
      listeners.forEach((fn) => fn(null));
      return true;
    }
    function all() { return items; }
    function unreadCount() { return unread; }

    /** Seed a few historical alerts so the panel is never empty on load. */
    function seed() {
      const now = Date.now();
      items = [
        { id: 's1', kind: 'arb', title: 'Arbitrage spread detected', text: 'GOLDM vs GOLDPETAL spread exceeded threshold.', ts: now - 4 * 60000, read: false },
        { id: 's2', kind: 'vol', title: 'Volatility warning', text: 'Gold futures volatility increased by 8.4%.', ts: now - 19 * 60000, read: false },
        { id: 's3', kind: 'signal', title: 'AI signal updated', text: 'New BUY signal generated for GOLDM.', ts: now - 52 * 60000, read: true },
        { id: 's4', kind: 'info', title: 'Reference re-normalized', text: 'AI reference recomputed across 3 contracts.', ts: now - 96 * 60000, read: true }
      ];
      seq = 4;
      recount();
    }

    /** Occasionally raise new alerts based on live conditions. */
    function evaluate() {
      const s = MarketSim.state;
      const wide = MarketSim.widestSpread();
      if (Math.abs(wide.diff) > SPREAD_THRESHOLD && Math.random() < 0.22) {
        push('arb', 'Arbitrage spread detected', `${wide.a} vs ${wide.b} spread at ₹${Math.abs(wide.diff).toFixed(2)} — above the ₹${SPREAD_THRESHOLD} threshold.`);
      }
      const vol = Math.max.apply(null, CONTRACTS.map((c) => s.contracts[c.id].vol24));
      if (vol > 30 && Math.random() < 0.14) {
        push('vol', 'Volatility warning', `Gold futures volatility increased by ${(U.rand(4, 12)).toFixed(1)}%.`);
      }
      if (Math.random() < 0.08) {
        const sig = Analytics.cache.signals[0];
        if (sig) push('signal', 'AI signal updated', `New ${sig.type} signal generated for ${sig.id}.`);
      }
    }

    return { push, markAllRead, clear, remove, all, unreadCount, seed, evaluate, subscribe };
  })();

  /* ======================================================================
   * 05 · CHART LAYER
   * Primary renderer is Chart.js. If the CDN is unavailable, a dependency-free
   * canvas renderer draws an equivalent line/bar chart so nothing breaks.
   * ==================================================================== */
  const Charts = (() => {
    const registry = new Map();
    const hasChartJs = () => typeof window.Chart !== 'undefined';
    const listeners = [];

    function configureDefaults() {
      if (!hasChartJs()) return;
      const C = window.Chart;
      C.defaults.font.family = "'Inter', system-ui, sans-serif";
      C.defaults.font.size = 11;
      C.defaults.color = '#94A3B8';
      C.defaults.plugins.legend.display = false;
      C.defaults.plugins.tooltip.backgroundColor = 'rgba(9,13,24,0.95)';
      C.defaults.plugins.tooltip.borderColor = 'rgba(148,163,184,0.3)';
      C.defaults.plugins.tooltip.borderWidth = 1;
      C.defaults.plugins.tooltip.padding = 10;
      C.defaults.plugins.tooltip.cornerRadius = 8;
      C.defaults.plugins.tooltip.titleColor = '#F8FAFC';
      C.defaults.plugins.tooltip.bodyColor = '#CBD5E1';
      C.defaults.plugins.tooltip.boxPadding = 4;
      C.defaults.animation = { duration: 700, easing: 'easeOutQuart' };
      C.defaults.maintainAspectRatio = false;
    }

    /** Standard options factory for a financial line chart. */
    function baseOptions(opts) {
      const o = opts || {};
      return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: o.animate === false ? false : { duration: 700, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: o.tooltip || {}
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(148,163,184,0.07)', drawTicks: false },
            border: { display: false },
            ticks: { maxTicksLimit: 7, maxRotation: 0, color: '#64748B', callback: o.xTick }
          },
          y: {
            grid: { color: 'rgba(148,163,184,0.08)', drawTicks: false },
            border: { display: false },
            ticks: { maxTicksLimit: 6, color: '#64748B', callback: o.yTick }
          }
        }
      };
    }

    /** Money tick formatter shared by every price axis. */
    const moneyTick = (v) => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    const signedTick = (v) => (v >= 0 ? '+' : '−') + '₹' + Math.abs(v).toFixed(0);
    const timeTick = (label) => (label instanceof Date ? label.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : String(label));

    /** Gradient fill helper for area-style datasets. */
    function gradient(ctx, area, color, alpha) {
      if (!area) return 'rgba(0,0,0,0)';
      const g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
      g.addColorStop(0, hexToRgba(color, alpha === undefined ? 0.28 : alpha));
      g.addColorStop(1, hexToRgba(color, 0));
      return g;
    }
    function hexToRgba(hex, a) {
      const h = hex.replace('#', '');
      const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
    }

    function lineDs(label, data, color, opts) {
      const o = opts || {};
      return {
        label, data, borderColor: color, borderWidth: o.width || 2,
        pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: color,
        pointHoverBorderColor: '#0B1020', tension: 0.32, borderDash: o.dash || [],
        fill: o.fill ? 'origin' : false, spanGaps: true, order: o.order || 0
      };
    }

    function moneyTooltip(ctx) {
      return {
        label: (item) => item.dataset.label + ': ' + U.inr(item.parsed.y)
      };
    }

    /* ---------- fallback renderer (no Chart.js) ---------- */
    function drawFallback(canvas, spec) {
      const h = canvas.clientHeight || 240;
      const { ctx, w, h: H } = U.canvas2d(canvas, h);
      ctx.clearRect(0, 0, w, H);
      const data = spec.data;
      if (!data || !data.labels || !data.labels.length) return;
      const padL = 46, padR = 12, padT = 12, padB = 22;
      const iw = Math.max(10, w - padL - padR);
      const ih = Math.max(10, H - padT - padB);
      const sets = data.datasets.filter(Boolean);
      let min = Infinity, max = -Infinity;
      sets.forEach((s) => s.data.forEach((v) => { if (v < min) min = v; if (v > max) max = v; }));
      if (!isFinite(min)) return;
      if (max - min < 1) { max += 1; min -= 1; }
      const padY = (max - min) * 0.12; min -= padY; max += padY;
      const x = (i) => padL + (iw * i) / Math.max(1, data.labels.length - 1);
      const y = (v) => padT + ih - ((v - min) / (max - min)) * ih;

      // grid + y labels
      ctx.strokeStyle = 'rgba(148,163,184,0.09)'; ctx.fillStyle = '#64748B';
      ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const gy = padT + (ih * i) / 4;
        ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + iw, gy); ctx.stroke();
        const val = max - ((max - min) * i) / 4;
        ctx.fillText(spec.yFormat ? spec.yFormat(val) : val.toFixed(0), padL - 6, gy);
      }
      // x labels
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const every = Math.max(1, Math.floor(data.labels.length / 6));
      data.labels.forEach((l, i) => {
        if (i % every) return;
        const txt = l instanceof Date ? l.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : String(l);
        ctx.fillText(txt, x(i), padT + ih + 6);
      });
      // series
      sets.forEach((s) => {
        if (s.type === 'bar') {
          const bw = Math.max(2, iw / data.labels.length / (sets.length + 0.5));
          s.data.forEach((v, i) => {
            if (v == null) return;
            const y0 = y(Math.max(min, 0)), y1 = y(v);
            ctx.fillStyle = s.borderColor || s.backgroundColor;
            const bx = x(i) - (bw * sets.length) / 2 + sets.indexOf(s) * bw;
            ctx.fillRect(bx, Math.min(y0, y1), bw - 1, Math.abs(y1 - y0) || 1);
          });
        } else {
          ctx.beginPath(); ctx.lineWidth = s.borderWidth || 2; ctx.strokeStyle = s.borderColor;
          if (s.borderDash && s.borderDash.length) ctx.setLineDash(s.borderDash); else ctx.setLineDash([]);
          s.data.forEach((v, i) => { if (v == null) return; i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)); });
          ctx.stroke(); ctx.setLineDash([]);
          if (s.fill) {
            ctx.lineTo(x(s.data.length - 1), padT + ih); ctx.lineTo(padL, padT + ih); ctx.closePath();
            ctx.fillStyle = hexToRgba(s.borderColor, 0.12); ctx.fill();
          }
        }
      });
    }

    /* ---------- public API ---------- */
    function upsert(id, spec) {
      const existing = registry.get(id);
      const canvas = document.getElementById(id);
      if (!canvas) return null;

      if (hasChartJs()) {
        if (existing && existing.chart) {
          // Live refreshes redraw without animation so ticks never fight a
          // running transition; explicit spec.animate === true still animates
          // (used for timeframe switches).
          const animate = spec.animate === true;
          existing.chart.data = spec.data;
          existing.chart.options = spec.options || existing.chart.options;
          existing.chart.update(animate ? undefined : 'none');
          return existing.chart;
        }
        const chart = new window.Chart(canvas.getContext('2d'), {
          type: spec.type || 'line',
          data: spec.data,
          options: spec.options || baseOptions()
        });
        registry.set(id, { chart, spec });
        listeners.forEach((fn) => fn(id));
        return chart;
      }

      // Fallback path
      const wrap = canvas.parentElement;
      let entry = existing;
      if (!entry) { entry = { chart: null, spec }; registry.set(id, entry); }
      entry.spec = spec;
      drawFallback(canvas, spec);
      if (!entry._bound) {
        entry._bound = true;
        const onResize = U.debounce(() => { if (document.body.contains(canvas)) drawFallback(canvas, entry.spec); }, 150);
        window.addEventListener('resize', onResize);
      }
      listeners.forEach((fn) => fn(id));
      return null;
    }

    function destroy(id) {
      const e = registry.get(id);
      if (e && e.chart) e.chart.destroy();
      registry.delete(id);
    }

    function has(id) { return registry.has(id); }
    function get(id) { const e = registry.get(id); return e ? e.chart : null; }
    function onCreate(fn) { listeners.push(fn); }

    return { upsert, destroy, has, get, configureDefaults, baseOptions, lineDs, moneyTick, signedTick, timeTick, gradient, hexToRgba, moneyTooltip, hasChartJs, onCreate };
  })();

  /* ======================================================================
   * 06 · UI
   * ==================================================================== */
  const UI = (() => {
    const el = {};
    let alertFilter = 'all';
    let lastInsightText = '';
    let lastScanAt = Date.now();
    let sparkCanvases = {};

    function cacheElements() {
      [
        'kpiGrid', 'contractTbody', 'matrixTbody', 'signalList', 'signalCards', 'oppGrid', 'oppGridFull',
        'heatGrid', 'alertList', 'alertListFull', 'priceLegend', 'ticker', 'heroRef', 'heroCount', 'heroConf',
        'heroScanAge', 'arbSummary', 'arbMatrixTbody', 'marketStrip', 'contractCards', 'signalHistory',
        'alertStrip', 'scannerCycle', 'engineLatency', 'engineBar', 'insightQuote', 'insightConf', 'insightRisk',
        'insightCond', 'insightTyping', 'toastStack', 'statusPill', 'statusLabel', 'statusSub', 'bellBadge',
        'navAlertBadge', 'navSigBadge', 'navArbBadge', 'clockTime', 'clockDate', 'btResultGrid', 'scanSteps',
        'scanResult', 'cmName', 'cmPrice', 'cmChange', 'cmSignal', 'cmMetrics', 'cmExplain', 'cmEyebrow',
        'execTicket', 'docTitle', 'docBody', 'pageTitle', 'routeChip', 'searchInput', 'searchResults'
      ].forEach((id) => { el[id] = document.getElementById(id); });
      el.scrim = document.getElementById('sidebarScrim');
      el.sidebar = document.getElementById('sidebar');
    }

    /* ---------------- KPI cards ---------------- */
    function buildKpis() {
      const defs = [
        { key: 'SPOT', label: 'Gold Spot', sub: 'MCX spot · 10g' },
        { key: 'GOLDM', label: 'GOLDM', sub: 'Gold Mini · 10g' },
        { key: 'GOLDTEN', label: 'GOLDTEN', sub: 'Gold Ten · 1g' },
        { key: 'GOLDPETAL', label: 'GOLDPETAL', sub: 'Gold Petal · 100g' },
        { key: 'SPREAD', label: 'Arbitrage Spread', sub: 'Widest pair', arb: true }
      ];
      el.kpiGrid.innerHTML = '';
      sparkCanvases = {};
      defs.forEach((d) => {
        const card = U.make('article', 'kpi glass' + (d.arb ? ' kpi--arb' : ''));
        card.dataset.kpi = d.key;
        card.innerHTML = `
          <div class="kpi__top">
            <span class="kpi__label">${d.label}</span>
            <span class="kpi__chg tag" data-role="chg">—</span>
          </div>
          <div class="kpi__value" data-role="value">—</div>
          <div class="kpi__spark"><canvas data-spark="${d.key}"></canvas></div>
          <div class="kpi__foot"><span class="kpi__delta" data-role="delta">—</span><span data-role="sub">${d.sub}</span></div>`;
        el.kpiGrid.appendChild(card);
        sparkCanvases[d.key] = card.querySelector('canvas');
      });
    }

    /** Draw a small sparkline inside a KPI card (dependency-free). */
    function drawSpark(canvas, series, color) {
      if (!canvas || !series || series.length < 2) return;
      const { ctx, w, h } = U.canvas2d(canvas, 30);
      ctx.clearRect(0, 0, w, h);
      const min = Math.min.apply(null, series), max = Math.max.apply(null, series);
      const range = max - min || 1;
      const x = (i) => (w * i) / (series.length - 1);
      const y = (v) => h - 3 - ((v - min) / range) * (h - 6);
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, Charts.hexToRgba(color, 0.32));
      g.addColorStop(1, Charts.hexToRgba(color, 0));
      ctx.beginPath();
      series.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
      ctx.lineTo(x(series.length - 1), h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      ctx.beginPath();
      series.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
      ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
    }

    function updateKpis() {
      const s = MarketSim.state;
      const wide = MarketSim.widestSpread();
      const spotPrev = s.spot;
      const values = {
        SPOT: { v: s.spot, chg: s.spotChange, sub: 'MCX spot · 10g' },
        GOLDM: { v: s.contracts.GOLDM.price, chg: s.contracts.GOLDM.change, sub: 'Gold Mini · 10g' },
        GOLDTEN: { v: s.contracts.GOLDTEN.price, chg: s.contracts.GOLDTEN.change, sub: 'Gold Ten · 1g' },
        GOLDPETAL: { v: s.contracts.GOLDPETAL.price, chg: s.contracts.GOLDPETAL.change, sub: 'Gold Petal · 100g' },
        SPREAD: { v: Math.abs(wide.diff), chg: (Math.abs(wide.diff) / SPREAD_THRESHOLD) * 100 - 50, sub: wide.a + ' ↔ ' + wide.b }
      };
      Object.keys(values).forEach((key) => {
        const card = el.kpiGrid.querySelector('[data-kpi="' + key + '"]');
        if (!card) return;
        const d = values[key];
        const vEl = card.querySelector('[data-role="value"]');
        const cEl = card.querySelector('[data-role="chg"]');
        const dlEl = card.querySelector('[data-role="delta"]');
        const prev = parseFloat(String(vEl.dataset.raw || 0));
        U.animateNumber(vEl, prev, d.v, { format: (v) => U.inr(v) });
        vEl.dataset.raw = d.v;
        const up = d.chg >= 0;
        cEl.textContent = key === 'SPREAD' ? U.pct(d.chg, 1) : U.pct(d.chg);
        cEl.className = 'kpi__chg tag ' + (up ? 'tag--green' : 'tag--red');
        dlEl.textContent = key === 'SPREAD' ? 'threshold ₹40' : (up ? '▲' : '▼') + ' vs open';
        dlEl.className = 'kpi__delta ' + (up ? 'delta-up' : 'delta-down');
        card.querySelector('[data-role="sub"]').textContent = d.sub;
        if (prev && Math.abs(d.v - prev) > 0.005) {
          U.pulse(card, up ? 'tick-flash' : 'tick-flash--down');
          U.pulse(vEl, up ? 'price-flash-up' : 'price-flash-down');
        }
      });

      // Sparklines
      const colors = { SPOT: SERIES_COLORS.SPOT, GOLDM: SERIES_COLORS.GOLDM, GOLDTEN: SERIES_COLORS.GOLDTEN, GOLDPETAL: SERIES_COLORS.GOLDPETAL, SPREAD: '#60A5FA' };
      Object.keys(sparkCanvases).forEach((key) => {
        if (key === 'SPREAD') return;
        const src = key === 'SPOT'
          ? MarketSim.state.history.series.SPOT.slice(-40)
          : MarketSim.state.contracts[key].spark.length > 3 ? MarketSim.state.contracts[key].spark : MarketSim.state.history.series[key].slice(-40);
        drawSpark(sparkCanvases[key], src, colors[key]);
      });
      const spreadSeries = MarketSim.spreadHistory().slice(-40).map((p) => p.diff);
      drawSpark(sparkCanvases.SPREAD, spreadSeries, colors.SPREAD);

      // Hero + scanner metadata
      el.heroRef.textContent = U.inr(s.reference);
      el.heroConf.textContent = Analytics.cache.signals[0] ? Analytics.cache.signals[0].confidence + '%' : '—';
      el.scannerCycle.textContent = 'cycle ' + String(s.cycle).padStart(3, '0');
      el.engineLatency.textContent = U.rand(8, 26).toFixed(0) + ' ms';
      el.engineBar.style.width = U.clamp(60 + Math.abs(wide.diff) / 2, 55, 98).toFixed(0) + '%';
      updateTicker();
    }

    /** Scrolling price ticker under the hero. */
    function updateTicker() {
      const s = MarketSim.state;
      const items = [
        { k: 'SPOT', v: s.spot }, ...CONTRACTS.map((c) => ({ k: c.id, v: s.contracts[c.id].price }))
      ];
      const html = items.map((it) => {
        const c = s.contracts[it.k];
        const chg = c ? c.change : s.spotChange;
        return `<span class="ticker__item ${chg >= 0 ? 'up' : 'down'}"><b>${it.k}</b> ${U.inr(it.v)} ${U.pct(chg)}</span>`;
      }).join('');
      el.ticker.innerHTML = html + html; // duplicated for a seamless marquee loop
    }

    /* ---------------- tables ---------------- */
    function contractRow(c) {
      const sig = Analytics.cache.signals.find((s) => s.id === c.id) || {};
      const sigType = sig.type || 'HOLD';
      return `<tr data-contract="${c.id}">
        <td>
          <span class="contract-cell">
            <span class="contract-cell__mark">${c.id.slice(0, 2)}</span>
            <span><strong>${c.id}</strong><small>${c.label} · ${c.unit}</small></span>
          </span>
        </td>
        <td class="num td-strong">${U.inr(c.price)}</td>
        <td class="num">${U.inr(MarketSim.state.reference)}</td>
        <td class="num ${c.spread >= 0 ? 'spread-val--up' : 'spread-val--down'}">${U.signedInr(c.spread)}</td>
        <td class="num ${c.change >= 0 ? 'delta-up' : 'delta-down'}">${U.pct(c.change)}</td>
        <td><span class="badge badge--${sigType.toLowerCase()} badge--pulse">${sigType}</span></td>
        <td><button class="row-btn" type="button" data-open-contract="${c.id}">Analyze</button></td>
      </tr>`;
    }

    function renderContractTable() {
      el.contractTbody.innerHTML = CONTRACTS.map((d) => contractRow(MarketSim.get(d.id))).join('');
    }

    function renderMatrix() {
      const s = MarketSim.state;
      el.matrixTbody.innerHTML = CONTRACTS.map((d) => {
        const c = s.contracts[d.id];
        const sig = Analytics.cache.signals.find((x) => x.id === d.id) || { type: 'HOLD' };
        const native = c.price * (10 / c.grams); // per 10g → native lot price
        return `<tr>
          <td><span class="contract-cell"><span class="contract-cell__mark">${d.id.slice(0, 2)}</span>
            <span><strong>${d.id}</strong><small>${d.label}</small></span></span></td>
          <td>${c.unit} · ${c.grams} g</td>
          <td class="num">${U.inr(c.price)}</td>
          <td class="num">${U.inr(native)}</td>
          <td class="num">${c.oi.toLocaleString('en-IN')}</td>
          <td class="num">${c.volume.toLocaleString('en-IN')}</td>
          <td class="num">${c.vol24.toFixed(1)}%</td>
          <td class="num ${c.spread >= 0 ? 'spread-val--up' : 'spread-val--down'}">${U.signedInr(c.spread)}</td>
          <td><span class="badge badge--${sig.type.toLowerCase()}">${sig.type}</span></td>
          <td><button class="row-btn" type="button" data-open-contract="${d.id}">Detail</button></td>
        </tr>`;
      }).join('');
    }

    function renderMarketStrip() {
      const s = MarketSim.state;
      const wide = MarketSim.widestSpread();
      const avgVol = CONTRACTS.reduce((a, d) => a + s.contracts[d.id].v24 || 0, 0);
      const cards = [
        { t: 'AI Reference', v: U.inr(s.reference), s: 'Volume-weighted consensus' },
        { t: 'Widest Spread', v: U.inr(Math.abs(wide.diff)), s: wide.a + ' ↔ ' + wide.b },
        { t: 'Session Change', v: U.pct(s.spotChange), s: 'Spot vs. open' },
        { t: 'Aggregate Volume', v: CONTRACTS.reduce((a, d) => a + s.contracts[d.id].volume, 0).toLocaleString('en-IN'), s: 'Simulated lots' },
        { t: 'Market Regime', v: Analytics.cache.regime, s: 'Model classification' },
        { t: 'Risk Level', v: Analytics.cache.risk, s: 'Based on avg |spread|' }
      ];
      el.marketStrip.innerHTML = cards.map((c) => `<div class="stat glass"><span>${c.t}</span><strong>${c.v}</strong><small>${c.s}</small></div>`).join('');
    }

    function renderArbSummary() {
      const opps = Analytics.cache.opportunities;
      const actionable = opps.filter((o) => o.diff > SPREAD_THRESHOLD).length;
      const cards = [
        { t: 'Pairs scanned', v: '3', s: 'Every cycle' },
        { t: 'Actionable', v: String(actionable), s: 'Spread > ₹' + SPREAD_THRESHOLD },
        { t: 'Best edge', v: opps[0] ? opps[0].pct.toFixed(3) + '%' : '—', s: opps[0] ? opps[0].action : '' },
        { t: 'Avg confidence', v: (opps.reduce((a, o) => a + o.confidence, 0) / (opps.length || 1)).toFixed(0) + '%', s: 'Model blend' }
      ];
      el.arbSummary.innerHTML = cards.map((c) => `<div class="stat glass"><span>${c.t}</span><strong>${c.v}</strong><small>${U.escapeHtml(c.s)}</small></div>`).join('');

      el.arbMatrixTbody.innerHTML = Analytics.cache.pairs.map((p) => `<tr>
        <td><span class="contract-cell"><span class="contract-cell__mark">${p.a.slice(0, 2)}</span>
          <span><strong>${p.a} / ${p.b}</strong><small>pair</small></span></span></td>
        <td class="num">${U.inr(p.diff)}</td>
        <td class="num">${p.pct.toFixed(3)}%</td>
        <td><span class="badge badge--buy">BUY ${p.buy}</span> <span style="color:#64748B">→</span> <span class="badge badge--sell">SELL ${p.sell}</span></td>
        <td class="num">${p.confidence}%</td>
      </tr>`).join('');
    }

    /* ---------------- opportunities ---------------- */
    function oppCard(o) {
      const tierLabel = o.tier === 'high' ? 'High conviction' : o.tier === 'mid' ? 'Moderate' : 'Low conviction';
      return `<article class="opp opp--${o.tier}" data-opp="${o.buy}-${o.sell}" style="animation-delay:${o.rank * 60}ms">
        <div class="opp__head">
          <div>
            <span class="opp__id">Opportunity #${String(o.rank).padStart(2, '0')}</span>
            <div class="opp__route">${o.buy} <span class="arrow">→</span> ${o.sell}</div>
          </div>
          <span class="tag ${o.tier === 'high' ? 'tag--green' : o.tier === 'mid' ? 'tag--gold' : 'tag--blue'}">${tierLabel}</span>
        </div>
        <div class="opp__grid">
          <div class="opp__metric"><span>Price Difference</span><strong>₹${o.diff.toFixed(2)}</strong></div>
          <div class="opp__metric"><span>Est. Opportunity</span><strong>${o.pct.toFixed(3)}%</strong></div>
        </div>
        <div class="opp__conf">
          <div class="conf-row"><span>Confidence</span><b>${o.confidence}%</b></div>
          <div class="bar ${o.tier === 'high' ? 'bar--green' : o.tier === 'mid' ? 'bar--amber' : ''}"><span data-width="${o.confidence}"></span></div>
        </div>
        <div class="opp__action">${U.escapeHtml(o.action)}</div>
        <div class="opp__foot">
          <span class="opp__meta">z ${o.z} · est. ${U.inr(o.notional)} size</span>
          <button class="btn btn--sm btn--gold" type="button" data-exec="${o.buy}|${o.sell}">Execute Analysis</button>
        </div>
      </article>`;
    }

    function renderOpportunities() {
      const html = Analytics.cache.opportunities.map(oppCard).join('');
      if (el.oppGrid) el.oppGrid.innerHTML = html;
      if (el.oppGridFull) el.oppGridFull.innerHTML = html;
      setBadge('navArbBadge', Analytics.cache.opportunities.filter((o) => o.diff > SPREAD_THRESHOLD).length);
      // Animate confidence bars in
      requestAnimationFrame(() => {
        U.$$('.opp .bar span').forEach((b) => { b.style.width = b.dataset.width + '%'; });
      });
    }

    /* ---------------- signals ---------------- */
    function signalCard(s) {
      const cls = s.type.toLowerCase();
      const c = s.contract;
      const idx = Math.max(0, CONTRACTS.findIndex((d) => d.id === s.id));
      return `<article class="signal signal--${cls}" style="animation-delay:${idx * 70}ms">
        <div class="signal__top">
          <span class="signal__name"><strong>${s.id}</strong><small>${c.label} · ${c.unit}</small></span>
          <span class="badge badge--${cls} badge--pulse">${s.type}</span>
        </div>
        <div class="signal__conf"><b>${s.confidence}%</b><span class="signal__reason-inline" style="font-size:.7rem;color:#64748B">confidence</span></div>
        <div class="bar ${cls === 'buy' ? 'bar--green' : cls === 'sell' ? 'bar--red' : 'bar--amber'}"><span data-width="${s.confidence}"></span></div>
        <p class="signal__reason">${U.escapeHtml(s.reason)}</p>
        <div class="signal__foot"><span>z ${s.z >= 0 ? '+' : ''}${s.z}</span><span>${U.signedInr(s.spread)}</span></div>
      </article>`;
    }

    function renderSignals() {
      const html = Analytics.cache.signals.map(signalCard).join('');
      if (el.signalList) el.signalList.innerHTML = html;
      if (el.signalCards) el.signalCards.innerHTML = html;
      el.navSigBadge.textContent = Analytics.cache.signals.filter((s) => s.type !== 'HOLD').length;
      requestAnimationFrame(() => {
        U.$$('.signal .bar span').forEach((b) => { b.style.width = b.dataset.width + '%'; });
      });
    }

    function renderSignalHistory() {
      const rows = Analytics.cache.signals.map((s) => ({
        title: `${s.type} · ${s.id}`,
        text: s.reason,
        time: U.timeAgo(Date.now() - U.rand(2, 400) * 1000),
        badge: s.type
      }));
      el.signalHistory.innerHTML = rows.map((r) => `<li>
        <div class="timeline__top"><span class="badge badge--${r.badge.toLowerCase()}">${r.badge}</span><strong>${r.title}</strong><time>${r.time}</time></div>
        <p>${U.escapeHtml(r.text)}</p>
      </li>`).join('');
    }

    /* ---------------- contract cards (analysis view) ---------------- */
    function renderContractCards() {
      const s = MarketSim.state;
      el.contractCards.innerHTML = CONTRACTS.map((d) => {
        const c = s.contracts[d.id];
        const sig = Analytics.cache.signals.find((x) => x.id === d.id) || { type: 'HOLD', confidence: 70, reason: '' };
        const oiSeries = c.oiHistory;
        return `<article class="signal signal--${sig.type.toLowerCase()}">
          <div class="signal__top">
            <span class="signal__name"><strong>${d.id}</strong><small>${d.label} · ${d.unit} · OI ${c.oi.toLocaleString('en-IN')}</small></span>
            <span class="badge badge--${sig.type.toLowerCase()} badge--pulse">${sig.type}</span>
          </div>
          <div class="kpi__value" style="font-size:1.3rem">${U.inr(c.price)}</div>
          <div class="signal__conf"><b>${U.pct(c.change)}</b><span class="tag ${c.change >= 0 ? 'tag--green' : 'tag--red'}">24H</span><span style="font-size:.7rem;color:#64748B;margin-left:auto">vol ${c.vol24.toFixed(1)}%</span></div>
          <div class="bar ${sig.type === 'BUY' ? 'bar--green' : sig.type === 'SELL' ? 'bar--red' : 'bar--amber'}"><span data-width="${sig.confidence}"></span></div>
          <p class="signal__reason">${U.escapeHtml(sig.reason)}</p>
          <div class="opp__foot">
            <span class="opp__meta">basis ${U.signedInr(c.spread)} · vol ${c.volume.toLocaleString('en-IN')}</span>
            <button class="btn btn--sm btn--gold" type="button" data-open-contract="${d.id}">Analyze</button>
          </div>
        </article>`;
      }).join('');
      requestAnimationFrame(() => {
        U.$$('#contractCards .bar span').forEach((b) => { b.style.width = b.dataset.width + '%'; });
      });
    }

    /* ---------------- heatmap ---------------- */
    function renderHeatmap() {
      const s = MarketSim.state;
      const tiles = CONTRACTS.map((d) => ({ name: d.id, price: s.contracts[d.id].price, chg: s.contracts[d.id].change }));
      tiles.push({ name: 'AI REF', price: s.reference, chg: 0, ref: true });
      el.heatGrid.innerHTML = tiles.map((t, i) => {
        if (t.ref) {
          return `<div class="heat-tile heat-tile--ref" style="animation-delay:${i * 50}ms">
            <span class="heat-tile__name">${t.name}</span>
            <div class="heat-tile__price">${U.inr(t.price)}</div>
            <div class="heat-tile__chg" style="color:#94A3B8">reference</div>
            <span class="heat-tile__bar" style="color:#64748B"></span>
          </div>`;
        }
        const mag = U.clamp(Math.abs(t.chg) / 1.6, 0, 1);
        const base = t.chg >= 0 ? '34,197,94' : '239,68,68';
        const bg = `linear-gradient(160deg, rgba(${base},${(0.1 + mag * 0.42).toFixed(2)}), rgba(9,13,24,0.75))`;
        const color = t.chg >= 0 ? '#22C55E' : '#EF4444';
        return `<div class="heat-tile" style="--heat-bg:${bg};animation-delay:${i * 50}ms">
          <span class="heat-tile__name">${t.name}</span>
          <div class="heat-tile__price">${U.inr(t.price)}</div>
          <div class="heat-tile__chg" style="color:${color}">${U.pct(t.chg)}</div>
          <span class="heat-tile__bar" style="color:${color}"></span>
        </div>`;
      }).join('');
    }

    /* ---------------- alerts ---------------- */
    const ALERT_META = {
      arb: { icon: '🟢', color: '#22C55E' },
      vol: { icon: '🟡', color: '#F5C542' },
      signal: { icon: '🔵', color: '#3B82F6' },
      info: { icon: '⚪', color: '#94A3B8' }
    };

    function filteredAlerts() {
      const all = AlertCenter.all();
      if (alertFilter === 'unread') return all.filter((a) => !a.read);
      if (alertFilter === 'all') return all;
      return all.filter((a) => a.kind === alertFilter);
    }

    function alertRow(a) {
      const m = ALERT_META[a.kind] || ALERT_META.info;
      return `<li class="alert ${a.read ? '' : 'is-unread'}" style="--alert-color:${m.color}">
        <span class="alert__icon">${m.icon}</span>
        <div class="alert__body">
          <div class="alert__title">${U.escapeHtml(a.title)} <time>${U.timeAgo(a.ts)}</time></div>
          <p class="alert__text">${U.escapeHtml(a.text)}</p>
        </div>
        <div class="alert__actions">
          ${a.read ? '' : '<span class="alert__dot"></span>'}
          <button class="row-btn" type="button" data-dismiss-alert="${a.id}" aria-label="Dismiss alert">✕</button>
        </div>
      </li>`;
    }

    function renderAlerts() {
      const list = filteredAlerts();
      const html = list.length ? list.map(alertRow).join('') : '<li class="alerts-empty">No alerts match this filter.</li>';
      if (el.alertList) el.alertList.innerHTML = html;
      if (el.alertListFull) el.alertListFull.innerHTML = html;
      const unread = AlertCenter.unreadCount();
      el.bellBadge.textContent = unread > 9 ? '9+' : String(unread);
      el.bellBadge.dataset.count = unread;
      el.navAlertBadge.textContent = unread;
      el.alertStrip.innerHTML = [
        { t: 'Total Alerts', v: AlertCenter.all().length, s: 'this session' },
        { t: 'Unread', v: unread, s: 'awaiting review' },
        { t: 'Arbitrage', v: AlertCenter.all().filter((a) => a.kind === 'arb').length, s: 'spread events' },
        { t: 'Volatility', v: AlertCenter.all().filter((a) => a.kind === 'vol').length, s: 'risk events' }
      ].map((c) => `<div class="stat glass"><span>${c.t}</span><strong>${c.v}</strong><small>${c.s}</small></div>`).join('');
    }

    /* ---------------- insight ---------------- */
    function renderInsight(insight) {
      const targets = [
        { q: el.insightQuote, c: el.insightConf, r: el.insightRisk, m: el.insightCond, t: el.insightTyping },
        { q: document.getElementById('insightQuote2'), c: document.getElementById('insightConf2'), r: document.getElementById('insightRisk2'), m: document.getElementById('insightCond2'), t: null }
      ];
      targets.forEach((t) => {
        if (!t.q) return;
        typeText(t.q, insight.text);
        t.c.textContent = insight.confidence + '%';
        t.r.textContent = insight.risk;
        t.r.className = 'tag ' + (insight.risk === 'High' ? 'tag--red' : insight.risk === 'Low' ? 'tag--green' : 'tag--amber');
        t.m.textContent = insight.condition;
        t.m.className = 'tag ' + (insight.condition === 'Bullish' ? 'tag--green' : insight.condition === 'Bearish' ? 'tag--red' : 'tag--amber');
      });
      lastInsightText = insight.text;
    }

    /** Typewriter effect for the AI insight. */
    function typeText(node, text) {
      if (!node) return;
      if (document.documentElement.dataset.motion === 'reduced') { node.textContent = text; return; }
      node.textContent = '';
      let i = 0;
      const chunk = Math.max(2, Math.round(text.length / 90));
      (function step() {
        i = Math.min(text.length, i + chunk);
        node.textContent = text.slice(0, i);
        if (i < text.length) setTimeout(step, 16);
      })();
    }

    /* ---------------- toasts ---------------- */
    function toast(kind, title, text) {
      const t = U.make('div', 'toast toast--' + kind);
      const icons = { info: 'i-spark', good: 'i-check', warn: 'i-bell', bad: 'i-close' };
      t.innerHTML = `<span class="toast__icon"><svg class="ico ico--sm"><use href="#${icons[kind] || 'i-spark'}"/></svg></span>
        <div><strong>${U.escapeHtml(title)}</strong>${text ? '<p>' + U.escapeHtml(text) + '</p>' : ''}</div>
        <button class="toast__close" type="button" aria-label="Dismiss"><svg class="ico ico--xs"><use href="#i-close"/></svg></button>`;
      el.toastStack.appendChild(t);
      const kill = () => { t.classList.add('is-out'); setTimeout(() => t.remove(), 300); };
      t.querySelector('.toast__close').addEventListener('click', kill);
      setTimeout(kill, 4600);
    }

    function setBadge(sel, n) { const e = el[sel]; if (e) e.textContent = n; }

    return {
      cacheElements, buildKpis, updateKpis, updateTicker, renderContractTable, renderMatrix, renderMarketStrip,
      renderArbSummary, renderOpportunities, renderSignals, renderSignalHistory, renderContractCards,
      renderHeatmap, renderAlerts, renderInsight, toast, drawSpark, typeText, setBadge,
      get el() { return el; },
      setAlertFilter(f) { alertFilter = f; },
      getAlertFilter() { return alertFilter; },
      getLastInsight() { return lastInsightText; },
      markScanned() { lastScanAt = Date.now(); },
      scanAge() { return U.timeAgo(lastScanAt); }
    };
  })();

  /* ======================================================================
   * 07 · MODAL LAYER
   * ==================================================================== */
  const Modals = (() => {
    let lastFocus = null;
    let current = null;

    const nodes = {
      contract: document.getElementById('contractModal'),
      scan: document.getElementById('scanModal'),
      exec: document.getElementById('execModal'),
      doc: document.getElementById('docModal')
    };

    function open(node) {
      if (!node) return;
      lastFocus = document.activeElement;
      node.hidden = false;
      current = node;
      document.body.style.overflow = 'hidden';
      const focusable = node.querySelector('button, [href], input');
      if (focusable) setTimeout(() => focusable.focus(), 60);
    }

    function close(node) {
      const n = node || current;
      if (!n) return;
      n.hidden = true;
      current = null;
      document.body.style.overflow = '';
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    function closeAll() { Object.keys(nodes).forEach((k) => { if (nodes[k]) nodes[k].hidden = true; }); current = null; document.body.style.overflow = ''; }

    /* ---- contract detail modal ---- */
    function openContract(id) {
      const c = MarketSim.get(id);
      const sig = Analytics.cache.signals.find((s) => s.id === id) || Analytics.computeSignals().find((s) => s.id === id);
      const m = UI.el;
      m.cmEyebrow.textContent = 'MCX • ' + c.label + ' • ' + c.unit;
      m.cmName.textContent = c.id;
      m.cmPrice.textContent = U.inr(c.price);
      m.cmChange.textContent = U.pct(c.change) + '  ·  ' + U.signedInr(c.price - c.open) + ' today';
      m.cmChange.className = 'cm-change ' + (c.change >= 0 ? 'delta-up' : 'delta-down');
      m.cmSignal.textContent = sig.type;
      m.cmSignal.className = 'badge badge--lg badge--' + sig.type.toLowerCase() + ' badge--pulse';
      m.cmMetrics.innerHTML = [
        { t: 'Normalized Price', v: U.inr(MarketSim.state.reference) },
        { t: 'Current Spread', v: U.signedInr(c.spread) },
        { t: 'Historical Spread', v: '±₹' + (c.vol24 * 1.4).toFixed(0) },
        { t: 'Volume (24h)', v: c.volume.toLocaleString('en-IN') },
        { t: 'Open Interest', v: c.oi.toLocaleString('en-IN') },
        { t: 'Volatility', v: c.vol24.toFixed(1) + '%' },
        { t: 'AI Confidence', v: sig.confidence + '%' },
        { t: 'Z-Score', v: (sig.z >= 0 ? '+' : '') + sig.z }
      ].map((x) => `<div class="metric"><span>${x.t}</span><strong class="${x.t === 'Current Spread' ? (parseFloat(x.v) >= 0 ? 'delta-up' : 'delta-down') : ''}">${x.v}</strong></div>`).join('');
      m.cmExplain.textContent = sig.reason + ' The normalizer weights ' + c.label + ' by its open interest (' + c.oi.toLocaleString('en-IN') + ') and realized volatility (' + c.vol24.toFixed(1) + '%), producing a fair-value estimate of ' + U.inr(MarketSim.state.reference) + ' per 10g equivalent.';

      // per-contract mini chart
      const store = MarketSim.state.history[MarketSim.state.activeTf || '1D'];
      const labels = store.labels;
      const data = {
        labels,
        datasets: [
          Charts.lineDs(c.id, store.series[c.id], SERIES_COLORS[c.id], { fill: true, width: 2.2 }),
          Charts.lineDs('AI Reference', store.series.REF, SERIES_COLORS.REF, { dash: [5, 4], width: 1.4 })
        ]
      };
      Charts.upsert('chartModal', {
        data,
        type: 'line',
        options: Charts.baseOptions({ yTick: Charts.moneyTick, xTick: Charts.timeTick, tooltip: Charts.moneyTooltip() })
      });
      open(nodes.contract);
    }

    /* ---- execute analysis modal ---- */
    function openExec(buy, sell) {
      const B = MarketSim.get(buy), S = MarketSim.get(sell);
      const diff = S.price - B.price;
      const rows = [
        ['Leg 1 · BUY', B.id + ' @ ' + U.inr(B.price)],
        ['Leg 2 · SELL', S.id + ' @ ' + U.inr(S.price)],
        ['Gross difference', U.inr(diff)],
        ['Estimated edge', (diff / MarketSim.state.reference * 100).toFixed(3) + '%'],
        ['Modelled size', U.inr(Math.round(Math.min(B.volume, S.volume) * 0.35))],
        ['Model confidence', (Analytics.cache.pairs.find((p) => p.buy === buy && p.sell === sell) || { confidence: 80 }).confidence + '%'],
        ['Order routing', 'DISABLED — frontend only']
      ];
      UI.el.execTicket.innerHTML = rows.map((r) => `<div class="ticket-row"><span>${r[0]}</span><strong class="${r[0].indexOf('ROUTING') > -1 ? 'delta-down' : ''}">${r[1]}</strong></div>`).join('');
      document.getElementById('execTitle').textContent = 'Execute Analysis · ' + buy + ' / ' + sell;
      open(nodes.exec);
    }

    /* ---- documentation modal ---- */
    function openDoc(key) {
      const d = DOCS[key];
      if (!d) return;
      UI.el.docTitle.textContent = d.title;
      UI.el.docBody.innerHTML = d.html;
      open(nodes.doc);
    }

    /* ---- scan overlay ---- */
    let scanTimers = [];
    function openScan() {
      const steps = UI.el.scanSteps;
      steps.querySelectorAll('li').forEach((li) => li.classList.remove('is-active', 'is-done'));
      UI.el.scanResult.hidden = true;
      document.getElementById('scanDone').hidden = true;
      open(nodes.scan);
      scanTimers.forEach(clearTimeout); scanTimers = [];
      const items = Array.from(steps.querySelectorAll('li'));
      items.forEach((li, i) => {
        scanTimers.push(setTimeout(() => {
          li.classList.add('is-active');
          scanTimers.push(setTimeout(() => {
            li.classList.remove('is-active');
            li.classList.add('is-done');
            if (i === items.length - 1) {
              scanTimers.push(setTimeout(() => {
                UI.el.scanResult.hidden = false;
                document.getElementById('scanDone').hidden = false;
                UI.markScanned();
              }, 420));
            }
          }, 420));
        }, 380 + i * 340));
      });
    }
    function cancelScan() { scanTimers.forEach(clearTimeout); scanTimers = []; close(nodes.scan); }

    return { open, close, closeAll, openContract, openExec, openDoc, openScan, cancelScan, nodes };
  })();

  /* ======================================================================
   * 08 · ROUTER
   * ==================================================================== */
  const Router = (() => {
    const routes = ['dashboard', 'market', 'arbitrage', 'contracts', 'signals', 'alerts', 'backtest', 'settings'];
    const titles = {
      dashboard: 'Market Intelligence', market: 'Market Overview', arbitrage: 'Arbitrage Scanner',
      contracts: 'Contract Analysis', signals: 'AI Signals', alerts: 'Smart Alerts',
      backtest: 'Strategy Backtester', settings: 'Settings'
    };
    let current = 'dashboard';

    function go(name, opts) {
      if (routes.indexOf(name) === -1) name = 'dashboard';
      current = name;
      routes.forEach((r) => {
        const view = document.getElementById('view-' + r);
        if (!view) return;
        const active = r === name;
        view.classList.toggle('is-active', active);
        view.hidden = !active;
      });
      U.$$('#navList .nav__item').forEach((b) => {
        const active = b.dataset.route === name;
        b.classList.toggle('is-active', active);
        if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      });
      UI.el.pageTitle.textContent = titles[name] || 'Market Intelligence';
      UI.el.routeChip.textContent = titles[name] || name;
      if (!opts || !opts.silent) history.replaceState(null, '', '#/' + name);
      window.scrollTo({ top: 0, behavior: document.documentElement.dataset.motion === 'reduced' ? 'auto' : 'smooth' });
      onEnter(name);
    }

    /** Lazily (re)draw the charts belonging to a view. */
    function onEnter(name) {
      if (name === 'dashboard') { renderDashboardCharts(); }
      if (name === 'market') { renderOverviewCharts(); }
      if (name === 'contracts') { renderBasisChart(); }
      if (name === 'signals') { renderConfidenceChart(); }
      if (name === 'arbitrage') { renderArbFreqChart(); }
    }

    return { go, onEnter, get current() { return current; }, routes };
  })();

  /* ======================================================================
   * 09 · CHART BUILDERS (kept with UI concerns)
   * ==================================================================== */
  function activeStore() { return MarketSim.state.history[MarketSim.state.activeTf || '1D']; }

  function buildPriceChart(canvasId, opts) {
    const store = activeStore();
    const o = opts || {};
    // `animate: true` only for user-initiated timeframe switches.
    const animate = o.animate === true;
    const datasets = [
      Charts.lineDs('GOLDM', store.series.GOLDM, SERIES_COLORS.GOLDM, { width: 2 }),
      Charts.lineDs('GOLDTEN', store.series.GOLDTEN, SERIES_COLORS.GOLDTEN, { width: 2 }),
      Charts.lineDs('GOLDPETAL', store.series.GOLDPETAL, SERIES_COLORS.GOLDPETAL, { width: 2 }),
      Charts.lineDs('Normalized Gold Price', store.series.REF, SERIES_COLORS.REF, { width: 1.5, dash: [6, 4] })
    ];
    if (o.spot) datasets.push(Charts.lineDs('Spot', store.series.SPOT, SERIES_COLORS.SPOT, { width: 1.5, dash: [2, 3] }));
    return {
      data: { labels: store.labels, datasets },
      type: 'line',
      animate,
      options: Charts.baseOptions({
        animate,
        yTick: Charts.moneyTick, xTick: Charts.timeTick, tooltip: Charts.moneyTooltip()
      })
    };
  }

  function renderDashboardCharts(opts) {
    Charts.upsert('chartPrice', buildPriceChart('chartPrice', opts));
    buildLegend();
  }

  function renderOverviewCharts(opts) {
    const animate = (opts || {}).animate === true;
    Charts.upsert('chartOverview', buildPriceChart('chartOverview', { spot: true, animate }));

    const store = activeStore();
    // spread monitor: deviation from reference for each contract
    const spreadSets = CONTRACTS.map((d) => ({
      label: d.id,
      data: store.series[d.id].map((p, i) => U.round2(p - store.series.REF[i])),
      borderColor: SERIES_COLORS[d.id],
      backgroundColor: Charts.hexToRgba(SERIES_COLORS[d.id], 0.5),
      borderWidth: 1.8, pointRadius: 0, tension: 0.3, fill: false
    }));
    Charts.upsert('chartSpread', {
      data: { labels: store.labels, datasets: spreadSets },
      type: 'line',
      animate,
      options: Charts.baseOptions({
        animate,
        yTick: Charts.signedTick, xTick: Charts.timeTick,
        tooltip: { label: (i) => i.dataset.label + ': ' + U.signedInr(i.parsed.y) }
      })
    });

    // volume pulse (bar) — last 24 buckets of synthetic turnover
    const labels = [], g1 = [], g2 = [], g3 = [];
    for (let i = 0; i < 24; i++) {
      const t = i + 1;
      labels.push(t * 5 + 'm');
      g1.push(Math.round(800 + Math.abs(Math.sin(i / 2)) * 1400 + U.rand(-100, 100)));
      g2.push(Math.round(500 + Math.abs(Math.cos(i / 3)) * 900 + U.rand(-80, 80)));
      g3.push(Math.round(300 + Math.abs(Math.sin(i / 1.6)) * 700 + U.rand(-60, 60)));
    }
    const bar = (label, data, color) => ({ label, data, backgroundColor: Charts.hexToRgba(color, 0.7), borderColor: color, borderWidth: 1, borderRadius: 4 });
    Charts.upsert('chartVolume', {
      data: { labels, datasets: [bar('GOLDM', g1, SERIES_COLORS.GOLDM), bar('GOLDTEN', g2, SERIES_COLORS.GOLDTEN), bar('GOLDPETAL', g3, SERIES_COLORS.GOLDPETAL)] },
      type: 'bar',
      animate,
      options: Charts.baseOptions({
        animate,
        yTick: (v) => Number(v).toLocaleString('en-IN'),
        xTick: (l) => l,
        tooltip: { label: (i) => i.dataset.label + ': ' + Number(i.parsed.y).toLocaleString('en-IN') + ' lots' }
      })
    });
  }

  function renderBasisChart() {
    const s = MarketSim.state;
    const labels = CONTRACTS.map((d) => d.id);
    const data = CONTRACTS.map((d) => ({
      label: d.id,
      data: [s.contracts[d.id].spread],
      backgroundColor: s.contracts[d.id].spread >= 0 ? Charts.hexToRgba('#EF4444', 0.8) : Charts.hexToRgba('#22C55E', 0.8),
      borderColor: s.contracts[d.id].spread >= 0 ? '#EF4444' : '#22C55E',
      borderWidth: 1.5,
      borderRadius: 6
    }));
    Charts.upsert('chartBasis', {
      data: { labels, datasets: data },
      type: 'bar',
      options: Charts.baseOptions({ yTick: Charts.signedTick, tooltip: { label: (i) => U.signedInr(i.parsed.y) + ' vs reference' } })
    });
  }

  function renderConfidenceChart() {
    const sigs = Analytics.cache.signals;
    const labels = sigs.map((s) => s.id);
    const data = sigs.map((s) => ({
      label: s.id, data: [s.confidence],
      backgroundColor: Charts.hexToRgba(s.type === 'BUY' ? '#22C55E' : s.type === 'SELL' ? '#EF4444' : '#F5C542', 0.8),
      borderColor: s.type === 'BUY' ? '#22C55E' : s.type === 'SELL' ? '#EF4444' : '#F5C542',
      borderWidth: 1.5, borderRadius: 6
    }));
    Charts.upsert('chartConfidence', {
      data: { labels, datasets: data }, type: 'bar',
      options: Charts.baseOptions({ yTick: (v) => v + '%', tooltip: { label: (i) => i.parsed.y + '% confidence' } })
    });
  }

  function renderArbFreqChart() {
    const labels = [];
    const data = [];
    for (let i = 20; i >= 1; i--) {
      labels.push('c' + (MarketSim.state.cycle - i));
      data.push(Math.max(0, Math.round(U.rand(0, 3) * (Math.random() < 0.6 ? 1 : 0.4))));
    }
    data.push(Analytics.cache.opportunities.filter((o) => o.diff > SPREAD_THRESHOLD).length);
    labels.push('now');
    Charts.upsert('chartArbFreq', {
      data: { labels, datasets: [{ label: 'Opportunities', data, backgroundColor: Charts.hexToRgba('#F5C542', 0.7), borderColor: '#F5C542', borderWidth: 1, borderRadius: 4 }] },
      type: 'bar',
      options: Charts.baseOptions({ yTick: (v) => v, xTick: (l) => (String(l) === 'now' ? 'now' : ''), tooltip: { label: (i) => i.parsed.y + ' actionable pairs' } })
    });
  }

  /** Interactive legend chips for the main price chart. */
  function buildLegend() {
    const wrap = UI.el.priceLegend;
    if (!wrap) return;
    const entries = [['GOLDM', SERIES_COLORS.GOLDM], ['GOLDTEN', SERIES_COLORS.GOLDTEN], ['GOLDPETAL', SERIES_COLORS.GOLDPETAL], ['Normalized', SERIES_COLORS.REF]];
    wrap.innerHTML = entries.map((e, i) => `<button class="legend-chip" type="button" data-ds="${i}" style="color:${e[1]}"><i></i><span style="color:var(--text-dim)">${e[0]}</span></button>`).join('');
    wrap.querySelectorAll('.legend-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const chart = Charts.get('chartPrice');
        const idx = Number(chip.dataset.ds);
        if (chart) {
          const meta = chart.getDatasetMeta(idx);
          meta.hidden = !meta.hidden;
          chart.update();
        }
        chip.classList.toggle('is-off');
      });
    });
  }

  /* ======================================================================
   * 10 · SEARCH
   * ==================================================================== */
  const Search = (() => {
    const INDEX = [
      { label: 'Dashboard', route: 'dashboard', icon: 'i-dashboard', kind: 'section' },
      { label: 'Market Overview', route: 'market', icon: 'i-market', kind: 'section' },
      { label: 'Arbitrage Scanner', route: 'arbitrage', icon: 'i-arbitrage', kind: 'section' },
      { label: 'Contract Analysis', route: 'contracts', icon: 'i-contract', kind: 'section' },
      { label: 'AI Trading Signals', route: 'signals', icon: 'i-signal', kind: 'section' },
      { label: 'Smart Alerts', route: 'alerts', icon: 'i-bell', kind: 'section' },
      { label: 'Strategy Backtester', route: 'backtest', icon: 'i-backtest', kind: 'section' },
      { label: 'Settings', route: 'settings', icon: 'i-settings', kind: 'section' },
      { label: 'Gold Futures Price Movement chart', route: 'dashboard', icon: 'i-market', kind: 'chart' },
      { label: 'Contract Intelligence table', route: 'dashboard', icon: 'i-contract', kind: 'table' },
      { label: 'Contract Market Heatmap', route: 'dashboard', icon: 'i-layers', kind: 'heatmap' },
      { label: 'GoldSense AI Insight', route: 'dashboard', icon: 'i-spark', kind: 'insight' },
      { label: 'Arbitrage spread monitor', route: 'market', icon: 'i-arbitrage', kind: 'chart' },
      { label: 'GOLDM', route: 'contracts', icon: 'i-contract', kind: 'contract', focus: 'GOLDM' },
      { label: 'GOLDTEN', route: 'contracts', icon: 'i-contract', kind: 'contract', focus: 'GOLDTEN' },
      { label: 'GOLDPETAL', route: 'contracts', icon: 'i-contract', kind: 'contract', focus: 'GOLDPETAL' },
      { label: 'Generate new AI insight', route: 'signals', icon: 'i-spark', kind: 'action', action: 'insight' },
      { label: 'Run market scan', route: 'dashboard', icon: 'i-market', kind: 'action', action: 'scan' }
    ];

    let results = [];
    let activeIdx = -1;

    function search(q) {
      const term = q.trim().toLowerCase();
      if (!term) return [];
      const scored = INDEX.map((it) => {
        const hay = it.label.toLowerCase();
        let score = 0;
        if (hay === term) score = 100;
        else if (hay.indexOf(term) === 0) score = 80;
        else if (hay.indexOf(term) > -1) score = 60 - hay.indexOf(term);
        return { it, score };
      }).filter((x) => x.score > 0);
      // contracts also match by their label
      if (/gold|petal|mini|ten/.test(term)) {
        scored.push({ it: INDEX.find((x) => x.focus === 'GOLDM'), score: 40 });
        scored.push({ it: INDEX.find((x) => x.focus === 'GOLDPETAL'), score: 38 });
      }
      const seen = new Set();
      return scored.sort((a, b) => b.score - a.score).filter((x) => x.it && !seen.has(x.it.label) && seen.add(x.it.label)).map((x) => x.it);
    }

    function render(q) {
      const box = UI.el.searchResults;
      results = search(q);
      if (!q.trim()) { box.hidden = true; return; }
      activeIdx = -1;
      if (!results.length) {
        box.innerHTML = '<p class="search__empty">No matches. Try GOLDM, arbitrage, signals or alerts.</p>';
      } else {
        box.innerHTML = results.map((r, i) => `<button class="search__opt" type="button" data-idx="${i}" role="option">
          <svg class="ico ico--sm"><use href="#${r.icon}"/></svg>
          <span>${U.escapeHtml(r.label)}</span><small>${r.kind}</small></button>`).join('');
      }
      box.hidden = false;
      UI.el.searchInput.setAttribute('aria-expanded', 'true');
    }

    function choose(r) {
      if (!r) return;
      if (r.action === 'scan') Modals.openScan();
      else if (r.action === 'insight') { UI.renderInsight(Analytics.computeInsight()); }
      else if (r.focus) {
        Router.go(r.route);
        setTimeout(() => Modals.openContract(r.focus), 260);
      } else Router.go(r.route);
      closeSearch();
    }

    function closeSearch() {
      const box = UI.el.searchResults;
      box.hidden = true;
      UI.el.searchInput.setAttribute('aria-expanded', 'false');
      UI.el.searchInput.value = '';
    }

    function bind() {
      const input = UI.el.searchInput;
      input.addEventListener('input', (e) => render(e.target.value));
      input.addEventListener('focus', () => { if (input.value) render(input.value); });
      input.addEventListener('keydown', (e) => {
        const box = UI.el.searchResults;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (box.hidden) return;
          activeIdx = U.clamp(activeIdx + (e.key === 'ArrowDown' ? 1 : -1), 0, results.length - 1);
          box.querySelectorAll('.search__opt').forEach((b, i) => b.classList.toggle('is-active', i === activeIdx));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          choose(results[activeIdx >= 0 ? activeIdx : 0]);
        } else if (e.key === 'Escape') { closeSearch(); input.blur(); }
      });
      UI.el.searchResults.addEventListener('click', (e) => {
        const b = e.target.closest('.search__opt');
        if (b) choose(results[Number(b.dataset.idx)]);
      });
      document.addEventListener('click', (e) => {
        if (!e.target.closest('#search')) closeSearch();
      });
    }

    return { bind };
  })();

  /* ======================================================================
   * 11 · BACKTESTER
   * ==================================================================== */
  const Backtester = (() => {
    let busy = false;

    function currentConfig() {
      const strat = (document.querySelector('input[name="strategy"]:checked') || {}).value || 'arbitrage';
      const periodBtn = document.querySelector('#btPeriod .seg__btn.is-active');
      const period = periodBtn ? periodBtn.dataset.period : '1m';
      const capInput = document.getElementById('btCapital');
      let capital = parseInt(capInput && capInput.value, 10);
      if (!capital || capital < 10000) capital = 100000;
      const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[period];
      return { strat, period, months, capital };
    }

    /**
     * Simulate a strategy. Uses a seeded RNG derived from the configuration
     * so the same inputs always produce the same equity curve.
     */
    function run(cfg) {
      const rng = U.seeded(cfg.capital + cfg.months * 7919 + cfg.strat.length * 104729);
      const days = cfg.months * 30;
      const edge = { arbitrage: 0.0011, meanrev: 0.0009, spread: 0.0007 }[cfg.strat];
      let equity = cfg.capital;
      const curve = [equity];
      let peak = equity, maxDD = 0, wins = 0, losses = 0, trades = 0;
      for (let d = 0; d < days; d++) {
        // regime-ish noise with a mild drift
        const shock = (rng() - 0.48) * 0.012;
        const trade = rng() < 0.55 ? (rng() - 0.45) * 0.02 + edge : 0;
        if (rng() < 0.55) { trades++; if (trade >= 0) wins++; else losses++; }
        equity = Math.max(cfg.capital * 0.5, equity * (1 + shock + trade));
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, (peak - equity) / peak);
        curve.push(U.round2(equity));
      }
      const final = curve[curve.length - 1];
      const ret = ((final - cfg.capital) / cfg.capital) * 100;
      const winRate = trades ? (wins / trades) * 100 : 0;
      // monthly returns for the bar chart
      const monthly = [];
      for (let m = 0; m < cfg.months; m++) {
        const a = curve[Math.floor((m * 30) / curve.length * (curve.length - 1))];
        const b = curve[Math.floor(((m + 1) * 30) / cfg.months * (curve.length - 1))] || final;
        monthly.push(U.round2(((b - a) / a) * 100));
      }
      return { cfg, curve, final, ret, winRate, maxDD: maxDD * 100, trades, monthly, wins, losses };
    }

    function renderResult(res) {
      const g = UI.el.btResultGrid;
      const pos = res.ret >= 0;
      g.innerHTML = [
        { t: 'Initial Capital', v: U.inr(res.cfg.capital, 0), cls: '' },
        { t: 'Final Capital', v: U.inr(res.final, 0), cls: pos ? 'result--pos' : 'result--neg' },
        { t: 'Total Return', v: U.pct(res.ret), cls: pos ? 'result--pos' : 'result--neg' },
        { t: 'Win Rate', v: res.winRate.toFixed(1) + '%', cls: '' },
        { t: 'Max Drawdown', v: '−' + res.maxDD.toFixed(1) + '%', cls: 'result--neg' },
        { t: 'Number of Trades', v: String(res.trades), cls: '' }
      ].map((c) => `<div class="result ${c.cls}"><span>${c.t}</span><strong>${c.v}</strong></div>`).join('');

      // equity curve
      const labels = res.curve.map((_, i) => 'D' + i);
      Charts.upsert('chartEquity', {
        data: { labels, datasets: [Charts.lineDs('Equity', res.curve, '#22C55E', { fill: true, width: 2.2 })] },
        type: 'line',
        options: Charts.baseOptions({ yTick: (v) => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }), xTick: (l) => l, tooltip: { label: (i) => 'Equity: ' + U.inr(i.parsed.y, 0) } })
      });

      // monthly returns
      const mLabels = res.monthly.map((_, i) => 'M' + (i + 1));
      Charts.upsert('chartMonthly', {
        data: { labels: mLabels, datasets: [{ label: 'Return', data: res.monthly, backgroundColor: res.monthly.map((v) => Charts.hexToRgba(v >= 0 ? '#22C55E' : '#EF4444', 0.75)), borderColor: res.monthly.map((v) => v >= 0 ? '#22C55E' : '#EF4444'), borderWidth: 1, borderRadius: 4 }] },
        type: 'bar',
        options: Charts.baseOptions({ yTick: (v) => v + '%', tooltip: { label: (i) => U.pct(i.parsed.y) } })
      });

      document.getElementById('btTag').textContent = res.cfg.strat === 'arbitrage' ? 'Arbitrage' : res.cfg.strat === 'meanrev' ? 'Mean Reversion' : 'Spread Trading';
      document.getElementById('btResSub').textContent = res.cfg.months + ' month window · ' + res.wins + 'W / ' + res.losses + 'L · SIMULATED';
    }

    function runWithUI() {
      if (busy) return;
      busy = true;
      const cfg = currentConfig();
      const btn = document.getElementById('btRun');
      const progress = document.getElementById('btProgress');
      const bar = document.getElementById('btProgressBar');
      const label = document.getElementById('btProgressLabel');
      const skel = document.getElementById('btSkeleton');
      const out = document.getElementById('btOutput');

      btn.classList.add('is-busy');
      btn.disabled = true;
      progress.hidden = false;
      skel.hidden = true;
      out.hidden = true;
      bar.style.width = '0%';
      const stages = ['Generating synthetic tape…', 'Normalizing contract basis…', 'Applying ' + cfg.strat + ' rules…', 'Compiling performance…'];
      let p = 0;
      const step = setInterval(() => {
        p += 25;
        bar.style.width = p + '%';
        label.textContent = stages[Math.min(stages.length - 1, Math.floor(p / 25))];
        if (p >= 100) {
          clearInterval(step);
          setTimeout(() => {
            const res = run(cfg);
            renderResult(res);
            out.hidden = false;
            progress.hidden = true;
            btn.classList.remove('is-busy');
            btn.disabled = false;
            busy = false;
            UI.toast('good', 'Backtest complete', U.pct(res.ret) + ' simulated return over ' + cfg.months + ' month(s).');
          }, 320);
        }
      }, 260);
    }

    function bind() {
      const cap = document.getElementById('btCapital');
      const hint = document.getElementById('btCapitalHint');
      cap.addEventListener('input', () => { hint.textContent = U.inr(parseInt(cap.value, 10) || 0, 0); });
      document.getElementById('btPeriod').addEventListener('click', (e) => {
        const b = e.target.closest('.seg__btn');
        if (!b) return;
        document.querySelectorAll('#btPeriod .seg__btn').forEach((x) => x.classList.remove('is-active'));
        b.classList.add('is-active');
      });
      document.getElementById('btForm').addEventListener('submit', (e) => { e.preventDefault(); runWithUI(); });
    }

    return { bind, run, currentConfig };
  })();

  /* ======================================================================
   * 12 · STATUS BAR (clock + market session)
   * ==================================================================== */
  const StatusBar = (() => {
    let timer;
    function tickClock() {
      const now = new Date();
      const time = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
      const date = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short' });
      UI.el.clockTime.textContent = time + ' IST';
      UI.el.clockDate.textContent = date;
      const age = UI.scanAge();
      if (UI.el.heroScanAge) UI.el.heroScanAge.textContent = age;
    }
    function marketState() {
      // MCX gold futures roughly trade 09:15–23:30 IST, Mon–Sat.
      const now = new Date();
      const parts = now.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).split(',');
      const timePart = (parts[1] || '00:00:00').trim();
      const day = now.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short' });
      const [h, m] = timePart.split(':').map(Number);
      const mins = h * 60 + m;
      const closed = day === 'Sun' || mins < 555 || mins > 1410; // 9:15 → 23:30
      return { open: !closed, label: closed ? 'Market Closed' : 'Market Open' };
    }
    function refreshStatus() {
      const s = marketState();
      const pill = UI.el.statusPill;
      UI.el.statusLabel.textContent = s.label;
      pill.classList.toggle('is-closed', !s.open);
      UI.el.statusSub.textContent = s.open ? 'Simulated feed' : 'Reopens 09:15 IST';
    }
    function init() {
      tickClock(); refreshStatus();
      timer = setInterval(() => { tickClock(); refreshStatus(); }, 1000);
    }
    function destroy() { clearInterval(timer); }
    return { init, destroy, tickClock, refreshStatus };
  })();

  /* ======================================================================
   * 13 · SETTINGS
   * ==================================================================== */
  const Settings = (() => {
    const KEY = 'goldsense.settings';
    const defaults = { accent: 'gold', density: 'comfortable', motion: 'full', speed: 1, paused: false };
    let prefs = Object.assign({}, defaults);

    function load() {
      try { const raw = localStorage.getItem(KEY); if (raw) prefs = Object.assign(prefs, JSON.parse(raw)); } catch (e) { /* ignore */ }
      applyAll();
    }
    function save() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } }
    function applyAll() {
      const root = document.documentElement;
      root.dataset.accent = prefs.accent;
      root.dataset.density = prefs.density;
      root.dataset.motion = prefs.motion === 'reduced' ? 'reduced' : 'full';
      document.querySelectorAll('#accentSwatches .swatch').forEach((s) => s.classList.toggle('is-active', s.dataset.accent === prefs.accent));
      document.querySelectorAll('#speedSeg .seg__btn').forEach((s) => s.classList.toggle('is-active', Number(s.dataset.speed) === prefs.speed));
      const pause = document.getElementById('pauseSwitch');
      pause.classList.toggle('is-on', prefs.paused); pause.setAttribute('aria-checked', String(prefs.paused));
      const density = document.getElementById('densitySwitch');
      density.classList.toggle('is-on', prefs.density === 'compact'); density.setAttribute('aria-checked', String(prefs.density === 'compact'));
      const motion = document.getElementById('motionSwitch');
      motion.classList.toggle('is-on', prefs.motion === 'reduced'); motion.setAttribute('aria-checked', String(prefs.motion === 'reduced'));
      save();
    }

    function bind() {
      document.getElementById('accentSwatches').addEventListener('click', (e) => {
        const s = e.target.closest('.swatch'); if (!s) return;
        prefs.accent = s.dataset.accent; applyAll();
      });
      document.getElementById('speedSeg').addEventListener('click', (e) => {
        const s = e.target.closest('.seg__btn'); if (!s) return;
        prefs.speed = Number(s.dataset.speed); applyAll(); Boot.restartFeed();
      });
      const toggles = [
        ['pauseSwitch', 'paused'], ['densitySwitch', 'density'], ['motionSwitch', 'motion']
      ];
      toggles.forEach(([id, key]) => {
        const node = document.getElementById(id);
        node.addEventListener('click', () => {
          if (key === 'paused') prefs.paused = !prefs.paused;
          if (key === 'density') prefs.density = prefs.density === 'compact' ? 'comfortable' : 'compact';
          if (key === 'motion') prefs.motion = prefs.motion === 'reduced' ? 'full' : 'reduced';
          applyAll();
        });
      });
      document.getElementById('resetSimBtn').addEventListener('click', () => {
        MarketSim.reset();
        Boot.refreshAll(true);
        UI.toast('info', 'Simulation reset', 'Synthetic tape regenerated to seed values.');
      });
      document.getElementById('clearAllAlertsBtn').addEventListener('click', () => { AlertCenter.clear(); UI.renderAlerts(); UI.toast('info', 'Alerts cleared', 'Alert history emptied.'); });
    }

    function get(key) { return prefs[key]; }
    return { load, bind, get };
  })();

  /* ======================================================================
   * 14 · BOOT / MAIN LOOP
   * ==================================================================== */
  const Boot = (() => {
    let feedTimer = null;
    let cycleIndex = 0;

    /** Recompute every analytical layer after a price change. */
    function analyticsPass() {
      Analytics.computeSignals();
      Analytics.computeOpportunities();
      Analytics.computeRegime();
    }

    /** Full render of the current data into the DOM. */
    function refreshAll(force) {
      analyticsPass();
      UI.updateKpis();
      UI.renderContractTable();
      UI.renderMatrix();
      UI.renderSignals();
      UI.renderSignalHistory();
      UI.renderOpportunities();
      UI.renderHeatmap();
      UI.renderArbSummary();
      UI.renderMarketStrip();
      UI.renderContractCards();
      if (force || !UI.getLastInsight()) UI.renderInsight(Analytics.computeInsight());
      // update the visible charts
      const active = Router.current;
      if (active === 'dashboard') { Charts.upsert('chartPrice', buildPriceChart('chartPrice')); }
      if (active === 'market') { renderOverviewCharts(); }
      if (active === 'contracts') { renderBasisChart(); }
      if (active === 'signals') { renderConfidenceChart(); }
      if (active === 'arbitrage') { renderArbFreqChart(); }
    }

    /** One live cycle: advance the sim, refresh analytics + alerts + UI. */
    function cycle() {
      MarketSim.tick();
      refreshAll(false);
      AlertCenter.evaluate();
      cycleIndex++;
    }

    // Any alert mutation (push / remove / mark read / clear) repaints the UI
    // immediately, so badges never lag behind the data.
    AlertCenter.subscribe(() => UI.renderAlerts());

    function startFeed() {
      stopFeed();
      const speed = Settings.get('speed') || 1;
      const base = U.rand(2200, 3600) / speed;
      feedTimer = setInterval(() => { if (!Settings.get('paused')) cycle(); }, base);
      document.getElementById('tickRate').textContent = (base / 1000).toFixed(1) + 's';
    }
    function stopFeed() { clearInterval(feedTimer); feedTimer = null; }

    function wireGlobalEvents() {
      // route buttons anywhere in the app
      document.addEventListener('click', (e) => {
        const routeBtn = e.target.closest('[data-route]');
        if (routeBtn) { e.preventDefault(); Router.go(routeBtn.dataset.route); closeSidebar(); return; }
        const openC = e.target.closest('[data-open-contract]');
        if (openC) { Modals.openContract(openC.dataset.openContract); return; }
        const exec = e.target.closest('[data-exec]');
        if (exec) { const p = exec.dataset.exec.split('|'); Modals.openExec(p[0], p[1]); return; }
        const dismiss = e.target.closest('[data-dismiss-alert]');
        if (dismiss) { removeAlert(dismiss.dataset.dismissAlert); return; }
        const docBtn = e.target.closest('[data-doc]');
        if (docBtn) { Modals.openDoc(docBtn.dataset.doc); return; }
        const closeBtn = e.target.closest('[data-close]');
        if (closeBtn) { const m = closeBtn.closest('.modal'); Modals.close(m); }
      });

      // hero + view scan buttons
      ['scanBtn', 'marketScanBtn', 'arbScanBtn', 'contractsScanBtn', 'scanBtnMobile'].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.addEventListener('click', () => Modals.openScan());
      });
      document.getElementById('scanCancel').addEventListener('click', () => Modals.cancelScan());
      document.getElementById('scanDone').addEventListener('click', () => { Modals.close(); refreshAll(true); UI.toast('good', 'Scan complete', Analytics.cache.opportunities.length + ' potential opportunities detected.'); });

      // timeframe segmented controls (main + overview)
      wireTimeframe('timeframeSeg', 'chartPrice');
      wireTimeframe('moTfSeg', 'chartOverview');

      // chart reset
      document.getElementById('chartResetBtn').addEventListener('click', () => { renderDashboardCharts(); UI.toast('info', 'Chart reset', 'Series rebuilt from the live tape.'); });

      // insight buttons
      ['insightBtn', 'insightBtn2'].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.addEventListener('click', () => { UI.renderInsight(Analytics.computeInsight()); UI.toast('info', 'New insight generated', 'Model narrative refreshed.'); });
      });

      // signals: recompute + clear history
      document.getElementById('signalsRegenBtn').addEventListener('click', () => { refreshAll(true); UI.toast('info', 'Signals recomputed', 'Conviction scores refreshed.'); });
      document.getElementById('clearSignalHistory').addEventListener('click', () => { UI.renderSignalHistory(); });

      // alerts controls
      document.getElementById('markReadBtn').addEventListener('click', () => { AlertCenter.markAllRead(); });
      document.getElementById('markReadBtn2').addEventListener('click', () => { AlertCenter.markAllRead(); });
      document.getElementById('clearAlertsBtn').addEventListener('click', () => { AlertCenter.clear(); });
      wireAlertFilter('alertFilter');
      wireAlertFilter('alertFilterFull');

      // contract modal buy/sell (disabled execution)
      document.getElementById('cmBuy').addEventListener('click', () => disabledTrade('BUY'));
      document.getElementById('cmSell').addEventListener('click', () => disabledTrade('SELL'));

      // bell → alerts view
      document.getElementById('bellBtn').addEventListener('click', () => { Router.go('alerts'); U.pulse(document.getElementById('bellBtn').querySelector('svg'), 'bell-ring'); });
      document.getElementById('profileBtn').addEventListener('click', () => Router.go('settings'));

      // analyze contract (default = top signal)
      document.getElementById('analyzeBtn').addEventListener('click', () => {
        const top = Analytics.cache.signals[0];
        Modals.openContract(top ? top.id : 'GOLDM');
      });

      // keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== UI.el.searchInput) { e.preventDefault(); UI.el.searchInput.focus(); }
        if (e.key === 'Escape') Modals.closeAll();
        if (e.key >= '1' && e.key <= '8' && document.activeElement.tagName !== 'INPUT') {
          Router.go(Router.routes[Number(e.key) - 1]);
        }
      });

      // modal backdrop click
      Object.values(Modals.nodes).forEach((m) => { if (m) m.querySelector('.modal__backdrop').addEventListener('click', () => Modals.close(m)); });

      // sidebar (mobile)
      document.getElementById('sidebarToggle').addEventListener('click', openSidebar);
      document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
      UI.el.scrim.addEventListener('click', closeSidebar);
    }

    function disabledTrade(side) {
      UI.toast('warn', side + ' signal noted', 'Trading execution is disabled in this prototype.');
    }

    function removeAlert(id) {
      AlertCenter.remove(id);
    }

    function wireTimeframe(segId, chartId) {
      const seg = document.getElementById(segId);
      if (!seg) return;
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('.seg__btn');
        if (!b) return;
        seg.querySelectorAll('.seg__btn').forEach((x) => x.classList.remove('is-active'));
        b.classList.add('is-active');
        // keep the paired timeframe control in sync
        const twin = segId === 'timeframeSeg' ? document.getElementById('moTfSeg') : document.getElementById('timeframeSeg');
        if (twin) twin.querySelectorAll('.seg__btn').forEach((x) => x.classList.toggle('is-active', x.dataset.tf === b.dataset.tf));
        MarketSim.setActiveTimeframe(b.dataset.tf);
        // Timeframe switches animate the transition; live ticks do not.
        if (chartId === 'chartPrice') renderDashboardCharts({ animate: true });
        else renderOverviewCharts({ animate: true });
      });
    }

    function wireAlertFilter(segId) {
      const seg = document.getElementById(segId);
      if (!seg) return;
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('.seg__btn');
        if (!b) return;
        seg.querySelectorAll('.seg__btn').forEach((x) => x.classList.remove('is-active'));
        b.classList.add('is-active');
        UI.setAlertFilter(b.dataset.filter);
        // keep both filters in sync
        document.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('is-active', x.dataset.filter === b.dataset.filter));
        UI.renderAlerts();
      });
    }

    function openSidebar() { UI.el.sidebar.classList.add('is-open'); UI.el.scrim.hidden = false; document.getElementById('sidebarToggle').setAttribute('aria-expanded', 'true'); }
    function closeSidebar() { UI.el.sidebar.classList.remove('is-open'); UI.el.scrim.hidden = true; document.getElementById('sidebarToggle').setAttribute('aria-expanded', 'false'); }

    function init() {
      UI.cacheElements();
      Settings.load();
      Charts.configureDefaults();
      UI.buildKpis();
      AlertCenter.seed();
      MarketSim.setActiveTimeframe('1D');

      analyticsPass();
      UI.updateKpis();
      UI.renderContractTable();
      UI.renderMatrix();
      UI.renderSignals();
      UI.renderSignalHistory();
      UI.renderOpportunities();
      UI.renderHeatmap();
      UI.renderArbSummary();
      UI.renderMarketStrip();
      UI.renderContractCards();
      UI.renderAlerts();
      UI.renderInsight(Analytics.computeInsight());
      renderDashboardCharts();

      wireGlobalEvents();
      Search.bind();
      Backtester.bind();
      Settings.bind();
      StatusBar.init();
      startFeed();

      // initial view from hash
      const hash = (location.hash || '').replace('#/', '');
      Router.go(Router.routes.indexOf(hash) > -1 ? hash : 'dashboard', { silent: true });

      // gentle welcome
      setTimeout(() => UI.toast('info', 'GoldSense AI online', 'Simulated MCX feed connected · 3 contracts normalized.'), 700);
    }

    function restartFeed() { startFeed(); }

    return { init, cycle, refreshAll, startFeed, stopFeed, restartFeed, removeAlert };
  })();

  /* ======================================================================
   * 15 · GO
   * ==================================================================== */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', Boot.init);
  else Boot.init();

  // Expose a tiny surface for debugging in the console (optional, harmless).
  window.GoldSense = { MarketSim, Analytics, AlertCenter, Backtester, U, Router, Boot };
})();
