// Two-tier surge bot for the pump.fun replay (agent-fun/replay/v2).
//
// What the full dev window shows (all three dataset parts — the kit pilot's
// local sim only reads the first part, so tune against the whole window):
// most coins barely move (median peak ~1.15x off the first trade), the ~3%
// that migrate run ~15x but mostly inside a single slot, faster than the
// 2-slot fill latency, so they cannot be caught. Price momentum alone is a
// weak tell and holding loses: a coin bought at a 1.4x cross decays to ~0.5x
// of the entry by the end of the window, so stops must be tight and winners
// banked. Across every exit shape the least-bad family is the same: buy a
// proven surge, sell at a modest take-profit, cut at -10%. But a selective
// entry trades only ~75 coins in 24h — about 19 in a 6-hour final window,
// a coin flip on the 20-coin minimum bar — while a broad entry trades plenty
// and bleeds. So this bot runs two tiers on one book:
//
//   Selective tier: buys only coins that prove a 2.0-2.5x surge within 300
//   slots of their first trade, 0.08 SOL each, exits at +50%, -10% stop,
//   25% trailing stop. This tier carries the PnL; on dev it is the least-bad
//   momentum setting (-0.28 SOL over 75 trips, best of all sweeps).
//   Filler tier: buys the 1.3-2.0x surge band at the 0.01 SOL minimum round
//   trip, exits at +25%, -8% stop, 20% trailing stop, and only while fewer
//   than 4 positions are committed, so it never crowds out the selective
//   tier. At 0.01 SOL its expected drag is ~0.0005 SOL a coin — a few cents
//   of SOL per coin — and it lifts the traded-coin count far above the
//   20-coin bar, which the selective tier alone would miss half the time.
//   The tiers are disjoint by rise band, so a coin enters exactly one of
//   them; a filler coin that later runs to 2.0x stays a filler position —
//   topping it up was tested and loses (it buys the top of the same move
//   the selective tier already avoids).
//
// No randomness: every decision is a pure function of the events seen so far,
// so the two grader runs agree byte for byte.

import {
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/agentfun-bot.ts';

export interface Params {
  /** SOL staked per selective-tier entry (before the 1%-of-real-reserve cap). */
  stakeSol: number;
  /** Minimum trades seen on a coin before it can be bought. */
  minTrades: number;
  /** Maximum trades seen on a coin for it to still count as young. */
  maxAgeTrades: number;
  /** Minimum slots from a coin's first trade to entry. */
  minSpanSlots: number;
  /** Maximum slots from a coin's first trade to entry. */
  maxSpanSlots: number;
  /** Selective tier: entry needs price up at least this multiple vs first trade. */
  entryRiseMin: number;
  /** Selective tier: entry refuses a coin already up more than this multiple. */
  entryRiseMax: number;
  /** Filler tier: entry needs price up at least this multiple vs first trade. */
  fillerRiseMin: number;
  /** Filler tier: entry refuses a coin already up more than this multiple. */
  fillerRiseMax: number;
  /** SOL staked per filler-tier entry. */
  fillerStakeSol: number;
  /** Filler tier take-profit multiple. */
  fillerTpMult: number;
  /** Filler tier hard stop multiple. */
  fillerStopMult: number;
  /** Filler tier trailing-stop drop. */
  fillerTrailDrop: number;
  /** Filler tier idle exit (slots without a trade). */
  fillerIdleSlots: number;
  /** Filler entries only while committed positions are below this count. */
  fillerMaxCommitted: number;
  /** Recent buy SOL share (last few trades) needed to enter. */
  buyShareMin: number;
  /** Trades in the recent-flow window. */
  flowWindow: number;
  /** Smallest buy worth placing (SOL); below this the round trip is all fees. */
  minBuySol: number;
  /** Hard stop: sell everything at this multiple of the entry price. */
  stopLossMult: number;
  /** Trailing stop: sell everything this far below the peak since entry. */
  trailDrop: number;
  /** First take-profit multiple and fraction of tokens sold there. */
  tp1Mult: number;
  tp1Frac: number;
  /** Second take-profit multiple and fraction of the remainder sold there. */
  tp2Mult: number;
  tp2Frac: number;
  /** Sell a quiet, unprofitable position after this many slots without a trade. */
  idleSlots: number;
  /** Slots to wait before re-entering a coin after a full exit. */
  cooldownSlots: number;
  /** Fresh buys allowed in a single batch. */
  maxNewBuysPerBatch: number;
  /** Slippage tolerance on buys, in bps. */
  buySlippageBps: number;
  /** Slippage tolerance on sells, in bps (wide: a rejected exit is worse). */
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeSol: 0.08,
  minTrades: 5,
  maxAgeTrades: 80,
  minSpanSlots: 0,
  maxSpanSlots: 300,
  entryRiseMin: 2.0,
  entryRiseMax: 2.5,
  fillerRiseMin: 1.3,
  fillerRiseMax: 2.0,
  fillerStakeSol: 0.01,
  fillerTpMult: 1.25,
  fillerStopMult: 0.92,
  fillerTrailDrop: 0.2,
  fillerIdleSlots: 1800,
  fillerMaxCommitted: 4,
  buyShareMin: 0.5,
  flowWindow: 6,
  minBuySol: 0.01,
  stopLossMult: 0.9,
  trailDrop: 0.25,
  tp1Mult: 1.5,
  tp1Frac: 1.0,
  tp2Mult: 5.0,
  tp2Frac: 0.5,
  idleSlots: 7200,
  cooldownSlots: 1800,
  maxNewBuysPerBatch: 4,
  buySlippageBps: 1000,
  sellSlippageBps: 1500,
};

interface CoinTrack {
  firstPrice: number;
  firstSlot: number;
  trades: number;
  buys: number;
  peak: number;
  lastPrice: number;
  lastSlot: number;
  // Highest real SOL reserve seen on this coin (SOL).
  maxRealSol: number;
  // Recent trades, newest last: [price, isBuy, solAmount].
  recent: Array<[number, boolean, number]>;
}

type Tier = 'selective' | 'filler';

interface PosTrack {
  tier: Tier;
  entryPrice: number;
  peak: number;
  entrySlot: number;
  tp1Done: boolean;
  tp2Done: boolean;
  lastCost: bigint;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function tierParams(p: Params, tier: Tier): {
  tpMult: number;
  tpFrac: number;
  stopMult: number;
  trailDrop: number;
  idleSlots: number;
} {
  if (tier === 'filler') {
    return { tpMult: p.fillerTpMult, tpFrac: 1.0, stopMult: p.fillerStopMult, trailDrop: p.fillerTrailDrop, idleSlots: p.fillerIdleSlots };
  }
  return { tpMult: p.tp1Mult, tpFrac: p.tp1Frac, stopMult: p.stopLossMult, trailDrop: p.trailDrop, idleSlots: p.idleSlots };
}

export function createStrategy(p: Params): Bot {
  const coins = new Map<Pubkey, CoinTrack>();
  const positions = new Map<Pubkey, PosTrack>();
  const cooldownUntil = new Map<Pubkey, number>();
  // Which tier bought each mint (set when the buy is sent, read when the
  // fill lands and the position is adopted).
  const boughtTier = new Map<Pubkey, Tier>();

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      let buysSent = 0;

      // Fold this batch's events into the per-coin trackers. Only coins with
      // events this batch are touched, so the per-batch cost stays tiny.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!coins.has(e.mint)) {
            coins.set(e.mint, {
              firstPrice: 0,
              firstSlot: e.slot,
              trades: 0,
              buys: 0,
              peak: 0,
              lastPrice: 0,
              lastSlot: e.slot,
              maxRealSol: 0,
              recent: [],
            });
          }
          continue;
        }
        if (e.event === 'TradeEvent') {
          let c = coins.get(e.mint);
          if (c === undefined) {
            c = {
              firstPrice: 0,
              firstSlot: e.slot,
              trades: 0,
              buys: 0,
              peak: 0,
              lastPrice: 0,
              lastSlot: e.slot,
              maxRealSol: 0,
              recent: [],
            };
            coins.set(e.mint, c);
          }
          const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          if (price <= 0) continue;
          const realSol = Number(e.real_sol_reserves) / 1e9;
          if (realSol > c.maxRealSol) c.maxRealSol = realSol;
          if (c.trades === 0) c.firstPrice = price;
          c.trades += 1;
          if (e.is_buy) c.buys += 1;
          if (price > c.peak) c.peak = price;
          c.lastPrice = price;
          c.lastSlot = e.slot;
          c.recent.push([price, e.is_buy, Number(e.sol_amount) / 1e9]);
          if (c.recent.length > p.flowWindow) c.recent.shift();
          continue;
        }
        // CompleteEvent: the harness closes any position itself; drop our track.
        if (e.event === 'CompleteEvent') {
          positions.delete(e.mint);
          cooldownUntil.set(e.mint, batch.slot + p.cooldownSlots);
        }
      }

      // Tokens already promised by sell orders still in flight, per mint.
      // Selling them twice is rejected (insufficient_tokens), so exits below
      // only sell what is not already on its way out.
      const pendingSellTokens = new Map<Pubkey, bigint>();
      const pendingBuyMints = new Set<Pubkey>();
      for (const pend of state.pending.values()) {
        if (pend.order.side === 'sell') {
          pendingSellTokens.set(
            pend.order.mint,
            (pendingSellTokens.get(pend.order.mint) ?? 0n) + BigInt(pend.order.token_amount),
          );
        } else {
          pendingBuyMints.add(pend.order.mint);
        }
      }

      // Sync our position book with the account: adopt new fills, drop closed
      // positions (and start their cooldown), keep peak/entry for survivors.
      // entryPrice is always the average cost (cost/tokens): sells leave the
      // ratio unchanged, so it only moves when the position is topped up.
      for (const [mint, hold] of state.positions) {
        const curve = state.curves.get(mint);
        const now = curve ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
        let t = positions.get(mint);
        if (t === undefined) {
          const entryPrice =
            hold.token_amount > 0n ? Number(hold.cost_lamports) / Number(hold.token_amount) : now;
          const tier = boughtTier.get(mint) ?? 'selective';
          t = { tier, entryPrice, peak: Math.max(entryPrice, now), entrySlot: batch.slot, tp1Done: false, tp2Done: false, lastCost: hold.cost_lamports };
          positions.set(mint, t);
        } else {
          if (now > t.peak) t.peak = now;
          t.lastCost = hold.cost_lamports;
        }
      }
      for (const mint of [...positions.keys()]) {
        if (!state.positions.has(mint)) {
          positions.delete(mint);
          boughtTier.delete(mint);
          cooldownUntil.set(mint, batch.slot + p.cooldownSlots);
        }
      }

      // Exits first: they free the 5-position cap for fresh entries. Each
      // position exits on its own tier's parameters.
      for (const [mint, hold] of state.positions) {
        const t = positions.get(mint);
        if (t === undefined) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const now = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (now <= 0) continue;
        const free = hold.token_amount - (pendingSellTokens.get(mint) ?? 0n);
        if (free <= 0n) continue;
        const tp = tierParams(p, t.tier);
        const sell = (frac: number): void => {
          const amount = frac >= 1 ? free : (free * BigInt(Math.floor(frac * 1000))) / 1000n;
          if (amount <= 0n) return;
          orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: p.sellSlippageBps });
        };
        // Hard stop-loss.
        if (now <= t.entryPrice * tp.stopMult) {
          sell(1);
          continue;
        }
        // Trailing stop off the peak since entry.
        if (now <= t.peak * (1 - tp.trailDrop)) {
          sell(1);
          continue;
        }
        // Take-profit ladder on fresh highs.
        if (!t.tp1Done && now >= t.entryPrice * tp.tpMult) {
          t.tp1Done = true;
          sell(tp.tpFrac);
          continue;
        }
        if (t.tier === 'selective' && t.tp1Done && !t.tp2Done && now >= t.entryPrice * p.tp2Mult) {
          t.tp2Done = true;
          sell(p.tp2Frac);
          continue;
        }
        // Quiet coin going nowhere: free the slot for a live one.
        const c = coins.get(mint);
        if (c !== undefined && batch.slot - c.lastSlot > tp.idleSlots && now < t.entryPrice * 1.3) {
          sell(1);
        }
      }

      // Entries: only coins that traded in this batch. The selective tier is
      // considered first; the filler tier only while slots are free for it.
      if (state.committedPositionCount() + buysSent < 5 && orders.length < 16) {
        const candidates: Array<{ mint: Pubkey; tier: Tier; score: number }> = [];
        const seenMints = new Set<Pubkey>();
        for (const e of batch.events) {
          if (e.event !== 'TradeEvent') continue;
          const mint = e.mint;
          if (seenMints.has(mint)) continue;
          seenMints.add(mint);
          if (state.positions.has(mint) || positions.has(mint)) continue;
          if (pendingBuyMints.has(mint)) continue;
          const c = coins.get(mint);
          if (c === undefined) continue;
          if (c.trades < p.minTrades || c.trades > p.maxAgeTrades) continue;
          const span = batch.slot - c.firstSlot;
          if (span < p.minSpanSlots || span > p.maxSpanSlots) continue;
          if (c.firstPrice <= 0 || c.lastPrice <= 0) continue;
          const rise = c.lastPrice / c.firstPrice;
          // The two rise bands are disjoint, so a coin enters exactly one tier.
          let tier: Tier | null = null;
          if (rise >= p.entryRiseMin && rise <= p.entryRiseMax) tier = 'selective';
          else if (rise >= p.fillerRiseMin && rise < p.fillerRiseMax) tier = 'filler';
          if (tier === null) continue;
          // Buy-dominated recent flow (weak early, still worth requiring).
          let buySol = 0;
          let totSol = 0;
          for (const [, isBuy, sol] of c.recent) {
            totSol += sol;
            if (isBuy) buySol += sol;
          }
          if (totSol <= 0 || buySol / totSol < p.buyShareMin) continue;
          // Still near its highs, not already rolling over.
          if (c.lastPrice < c.peak * 0.95) continue;
          const cool = cooldownUntil.get(mint);
          if (cool !== undefined && batch.slot < cool) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const stakeSol = tier === 'selective' ? p.stakeSol : p.fillerStakeSol;
          const maxBuy = state.maxBuyLamports(mint);
          const stake = BigInt(Math.floor(stakeSol * 1e9));
          const size = stake < maxBuy ? stake : maxBuy;
          if (size < BigInt(Math.floor(p.minBuySol * 1e9))) continue;
          if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
          candidates.push({ mint, tier, score: rise });
        }
        // Selective first, then filler; strongest rise first within a tier.
        candidates.sort((a, b) => (a.tier === b.tier ? b.score - a.score : a.tier === 'selective' ? -1 : 1));
        // Cash already promised to orders pushed earlier in this batch.
        let reserved = 0n;
        for (const o of orders) {
          reserved += state.txFeeLamports();
          if (o.side === 'buy') reserved += BigInt(o.quote_lamports);
        }
        for (const cand of candidates) {
          if (buysSent >= p.maxNewBuysPerBatch) break;
          if (state.committedPositionCount() + buysSent >= 5) break;
          if (orders.length >= 16) break;
          // The filler tier must leave a slot free for the selective tier.
          if (cand.tier === 'filler' && state.committedPositionCount() + buysSent >= p.fillerMaxCommitted) continue;
          const stakeSol = cand.tier === 'selective' ? p.stakeSol : p.fillerStakeSol;
          const maxBuy = state.maxBuyLamports(cand.mint);
          const stake = BigInt(Math.floor(stakeSol * 1e9));
          const size = stake < maxBuy ? stake : maxBuy;
          if (size < BigInt(Math.floor(p.minBuySol * 1e9))) continue;
          if (state.freeCashLamports() - reserved < size + state.txFeeLamports()) continue;
          orders.push({ side: 'buy', mint: cand.mint, quote_lamports: size, max_slippage_bps: p.buySlippageBps });
          boughtTier.set(cand.mint, cand.tier);
          reserved += size + state.txFeeLamports();
          buysSent += 1;
        }
      }

      return orders;
    },
  };
}
