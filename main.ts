// Two-tier pump.fun bot: a selective tier buys young coins on a proven
// 2.0-2.5x surge (0.08 SOL, exits at +50%, -10% stop, 25% trailing stop)
// while a filler tier buys the 1.3-2.0x band at the 0.01 SOL minimum round
// trip so the entry clears the 20-coin bar. The grader runs
// `node /bot/main.ts` (Node 22.18+ runs TypeScript as-is). The strategy and
// its tuned parameters live in strategy.ts (DEFAULT_PARAMS, the local-sweep
// winners on the kit's full dev window); the SDK shim is the kit's
// sdk/ts/agentfun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
