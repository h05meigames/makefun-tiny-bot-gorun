// Tiny Bot: snap-back dip buys + trend rides on hourly Solana bars.
//
// Strategy (original, long only, all 7 universe symbols):
//   Per symbol, over its own closes, track three readouts:
//     - EMA(6) and EMA(24), seeded as the mean of their first span of closes.
//     - RSI(10), Wilder-smoothed (first average = mean of the first 10 changes).
//     - The 12-bar return, close now vs close 12 bars ago.
//   Entry A, snap-back: the symbol is washed out — RSI below 32, the close more
//     than 2% under EMA(24), and down more than 3% over the last 12 bars. Buy the
//     panic, expecting the snap back toward the trend.
//   Entry B, trend-ride: EMA(6) crosses above EMA(24) while the 12-bar return is
//     over +2%. Buy the confirmed uptrend and ride it.
//   Exit, the whole position: RSI above 65 (overbought), or the position worth
//     10% over its cost (take profit), or 12% under it (stop loss), or EMA(6)
//     crossing back below EMA(24) (trend broken). Each exit reason is re-read
//     on every bar the symbol actually has, so a sell the market refuses is sent
//     again while it still holds — but a symbol that missed its hour is never
//     traded on its stale close.
//   Sizing: equity split over n slots, n = min(universe, caps.max_open_positions);
//     each buy the smallest of equity / n, caps.max_weight_bps of equity, and the
//     cash this reply has not spent yet; below the minimum notional it buys
//     nothing. Sells go first, then buys in universe order, at most
//     caps.max_orders_per_bar in all. Each order caps slippage at 100 bps past
//     the close it was decided on.
//   Determinism: no clock, no environment, no randomness — the same bars give
//     the same orders, run after run. Warm-up batches only seed indicators;
//     no order is decided on one.
//
// The harness runs `node /bot/main.ts` with this directory mounted at /bot;
// vendor/makefun-bars.ts is the kit's own SDK, copied verbatim (the kit's
// RULES.txt tells entrants to copy it there).

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 6;
const SLOW_SPAN = 24;
const RSI_SPAN = 10;
const MOMENTUM_BARS = 12;
const DIP_RSI_BELOW = 32;
const DIP_UNDER_TREND_BPS = 200; // close >2% under EMA(24)
const DIP_DROP_BPS = 300; // down >3% over 12 bars
const RIDE_MOMENTUM_BPS = 200; // up >2% over 12 bars
const EXIT_RSI_ABOVE = 65;
/** Take profit: worth 11/10 of its cost. */
const TAKE = [11n, 10n] as const;
/** Stop loss: worth 22/25 of its cost (-12%). */
const STOP = [22n, 25n] as const;
const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the previous bar, once both are set. */
  gap: number | null;
  /** fast - slow after this bar. */
  now: number | null;
  /** The last MOMENTUM_BARS + 1 closes, oldest first. */
  closes: number[];
  last: number | null;
  /** The first RSI_SPAN changes, while the Wilder averages are not set yet. */
  first: number[];
  gain: number | null;
  loss: number | null;
}

const series = new Map<string, Series>();

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_SPAN, warm: [], value: null },
      slow: { span: SLOW_SPAN, warm: [], value: null },
      gap: null,
      now: null,
      closes: [],
      last: null,
      first: [],
      gain: null,
      loss: null,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  stepEma(s.fast, c);
  stepEma(s.slow, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  s.closes.push(c);
  if (s.closes.length > MOMENTUM_BARS + 1) s.closes.shift();
  if (s.last !== null) {
    const change = c - s.last;
    if (s.gain === null || s.loss === null) {
      s.first.push(change);
      if (s.first.length === RSI_SPAN) {
        s.gain = s.first.reduce((a, x) => a + (x > 0 ? x : 0), 0) / RSI_SPAN;
        s.loss = s.first.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / RSI_SPAN;
      }
    } else {
      s.gain = (s.gain * (RSI_SPAN - 1) + (change > 0 ? change : 0)) / RSI_SPAN;
      s.loss = (s.loss * (RSI_SPAN - 1) + (change < 0 ? -change : 0)) / RSI_SPAN;
    }
  }
  s.last = c;
  return s;
}

function rsi(s: Series): number | null {
  if (s.gain === null || s.loss === null) return null;
  const moved = s.gain + s.loss;
  return moved === 0 ? 50 : (100 * s.gain) / moved;
}

/** 12-bar return in bps, or null before MOMENTUM_BARS + 1 closes. */
function momentumBps(s: Series): number | null {
  if (s.closes.length < MOMENTUM_BARS + 1) return null;
  const old = s.closes[0]!;
  const now = s.closes[s.closes.length - 1]!;
  return ((now - old) * 10_000) / old;
}

/** Whether a held position exits on this close. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, r: number | null, trendBroken: boolean): boolean {
  if (trendBroken) return true;
  if (r !== null && r > EXIT_RSI_ABOVE) return true;
  const value = state.value(symbol, held.qty);
  return value * TAKE[1] >= held.cost * TAKE[0] || value * STOP[1] <= held.cost * STOP[0];
}

await runBars({
  onBatch(state, batch) {
    const dipBuy = new Set<string>();
    const rideBuy = new Set<string>();
    const trendBroken = new Set<string>();
    for (const bar of batch.bars) {
      const s = push(bar);
      if (bar.v === '0') continue; // a zero-volume bar signals nothing
      const r = rsi(s);
      const mom = momentumBps(s);
      if (s.gap !== null && s.now !== null) {
        if (s.now > 0 && s.gap <= 0 && mom !== null && mom > RIDE_MOMENTUM_BPS) rideBuy.add(bar.symbol);
        if (s.now < 0 && s.gap >= 0) trendBroken.add(bar.symbol);
      }
      if (
        r !== null &&
        mom !== null &&
        r < DIP_RSI_BELOW &&
        mom < -DIP_DROP_BPS &&
        s.slow.value !== null &&
        s.last !== null &&
        s.last * 10_000 < s.slow.value * (10_000 - DIP_UNDER_TREND_BPS)
      ) {
        dipBuy.add(bar.symbol);
      }
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    // Only symbols with a bar in THIS batch get a decision: a symbol that missed
    // its hour must not be bought or sold on a stale close (the final window
    // allows up to 2% missing hours per asset, so this is not theoretical).
    const fresh = new Set(batch.bars.map((b) => b.symbol));
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol);
      if (s === undefined) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (exits(state, symbol, held, rsi(s), trendBroken.has(symbol))) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else if (dipBuy.has(symbol) || rideBuy.has(symbol)) {
        entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
