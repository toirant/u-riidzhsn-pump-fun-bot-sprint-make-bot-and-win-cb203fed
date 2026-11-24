[![Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/toirant/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/toirant/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Two-Tier Surge Pump.fun Bot

A trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty on make.fun. It trades paper SOL on a replay of pump.fun bonding-curve events (agent-fun/replay/v2) and is ranked on net PnL against holding cash.

## Strategy

Most pump.fun coins barely move (median peak ~1.15x off the first trade) while a few run 3x or more — but most of the migration move happens inside a single slot, faster than the 2-slot fill latency, so it cannot be caught. Holding loses: a coin bought at a 1.4x cross decays to ~0.5x of the entry by the end of the window, so stops must be tight and winners banked. Across every exit shape tested, the least-bad family is the same — buy a proven surge, sell at a modest take-profit, cut at -10% — but a selective entry trades only ~75 coins in 24h, about 19 in a 6-hour final window, a coin flip on the 20-coin minimum bar, while a broad entry trades plenty and bleeds. So the bot runs two tiers on one book:

- **Selective tier:** buys only coins that prove a **2.0–2.5x surge within 300 slots** of their first trade, **0.08 SOL** each, exits at **+50%**, **-10% stop**, **25% trailing stop**. This tier carries the PnL.
- **Filler tier:** buys the **1.3–2.0x surge band at the 0.01 SOL minimum** round trip, exits at **+25%**, **-8% stop**, **20% trailing stop**, and only while fewer than 4 positions are committed, so it never crowds out the selective tier. At 0.01 SOL its drag is ~0.0005 SOL a coin, and it lifts the traded-coin count far above the 20-coin bar.

Parameters are the local-sweep winners on the kit's full dev window; see `strategy.ts` (`DEFAULT_PARAMS`). Ideas tested and rejected on the dev window: reserve-based entry (real SOL 20–30, best -0.40), scalping (TP 1.2x, best -0.28 at 75 coins), and topping up filler runners to selective size (worse, -0.55 — it buys the top of the same move).

## Local backtest (kit dev window, 24h, `grade-local --driver process`)

| | This bot | Hold cash | Sniper pilot | Reversion pilot | Momentum pilot | Equal-weight |
|---|---|---|---|---|---|---|
| Net PnL (SOL) | **-0.277** (sweep mean over 4 fail draws: -0.236) | 0.000 | -0.468 | -3.887 | -9.460 | -0.019 |
| Coins traded | 330 | 0 | 351 | 195 | 46 | 5 |
| Round trips | 330 | 0 | 351 | 424 | 77 | 5 |
| Max drawdown | 0.029 | 0.000 | 0.052 | 0.482 | 0.956 | 0.009 |

Honest read: the bot **loses on the dev window** — no tested strategy beats hold-cash there, and the 90% bootstrap interval sits entirely below zero (-0.47 to -0.05 SOL). It is the least-bad of all tested designs on the metrics that matter for the final: lowest drawdown (0.029), 330 counted coins (about 83 in a 6-hour window, far above the 20-coin bar), and a fat right tail — one dev trip paid +0.10 SOL, and a bootstrap over 6-hour samples puts the chance of a positive final window at roughly 14% with the bar met. The final window is fresh coins, so that is a lottery ticket, not a forecast.

## Run

The grader runs `node /bot/main.ts` (Node 22.18+ runs TypeScript as-is). To grade locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot <this repo> --driver process
```

Note: the kit pilot's local sim (`tools/sim.ts`) only reads the first of the three dataset parts; grade-local reads all three, so always confirm a tune with `grade-local` before trusting it.

## Files

- `main.ts` — entrypoint: runs the strategy through the SDK shim.
- `strategy.ts` — the strategy (two-tier entry/exit rules, parameters).
- `vendor/agentfun-bot.ts` — the kit's SDK shim, vendored byte for byte (excluded from authorship counts).
- `LICENSE` — MIT.
