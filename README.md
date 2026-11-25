# Tiny Bot — Snap-Back + Trend Ride on Solana

[![Bounty](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/h05meigames/makefun-tiny-bot-gorun/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![Reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/h05meigames/makefun-tiny-bot-gorun/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

Entry for the make.fun bounty [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) — a tiny paper-trading bot for hourly Solana bars that decides when to hold SOL (and the other universe assets) and when to sit in USDC.

Referral: https://make.fun/r/0ene8b3q

## Strategy

Long only, all 7 universe symbols (FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF). Per symbol, over its own closes:

- **EMA(6) / EMA(24)**, seeded as the mean of their first span of closes.
- **RSI(10)**, Wilder-smoothed.
- **12-bar return** (momentum).

**Entry A — snap-back:** RSI below 32, close more than 2% under EMA(24), and down more than 3% over the last 12 bars. Buy the panic, expecting the snap back toward the trend.

**Entry B — trend-ride:** EMA(6) crosses above EMA(24) while the 12-bar return is over +2%. Buy the confirmed uptrend and ride it.

**Exit (whole position):** RSI above 65, or +10% take-profit, or −12% stop-loss, or EMA(6) crossing back below EMA(24). Exit reasons are re-read on every bar the symbol actually has — a symbol that missed its hour is never traded on its stale close.

**Sizing:** equity split over n slots (n = min(universe, max open positions)); each buy the smallest of equity / n, the 25% max-weight cap, and unspent cash; sells first, then buys in universe order, at most 16 orders per bar, 100 bps max slippage. Fully deterministic: no clock, no environment, no randomness.

## Local results (kit dev window, 136 hourly bars)

Graded with the kit's own grader (`node cli/makefun.mjs grade-local --kit . --bot . --driver process --worktree`):

| Metric | This bot | Buy-and-hold baseline |
| --- | --- | --- |
| Net PnL | **+$316.92 USDC** | −$869.34 USDC |
| Return | +3.17% | −8.69% |
| Trades | 24 | 7 |
| Max drawdown | 2.58% | 10.92% |
| Win rate | 78.6% | — |
| Symbols traded | 7 | — |

Best symbols: WIF +$91.88 (6 trades), POPCAT +$86.38 (4), FARTCOIN +$58.26 (3). Only SOL was slightly negative (−$0.81). Guardrails met: 24 trades (min 8), max drawdown 2.58% (max 25%).

## Run

```sh
node main.ts
```

Runs on Node 22.18+ (the grader runs Node 22.23.4), speaking the `agent-fun/bars-replay/v1` line protocol on stdin/stdout via the kit's SDK in `vendor/` (copied verbatim from the kit, as its RULES.txt instructs). No network, no outside data, no secrets.

## License

MIT — see [LICENSE](LICENSE).
