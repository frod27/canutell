import { resolve } from 'node:path';
import { ScaledClock } from './clock';
import { startGameServer } from './server';
import { JsonlStore } from './store';

// Entry point: `pnpm serve`. Configuration via environment variables:
//   PORT           listen port (default 8787)
//   HOST           listen address (default 0.0.0.0)
//   DATA_DIR       where match logs are written (default ./data/matches)
//   CLOCK_SPEED    virtual ms per real ms; >1 only for testing (default 1)
//   FILL_BOTS_MS   dev only: fill waiting queues/parties with bots after this many ms (default off)
//   AGENT_WEIGHTS  relative odds of 0,1,2 agents (default 1,1,1)

const env = process.env;
const speed = Number(env.CLOCK_SPEED ?? 1);
const fill = env.FILL_BOTS_MS ? Number(env.FILL_BOTS_MS) : null;
const weights = (env.AGENT_WEIGHTS ?? '1,1,1').split(',').map(Number);
const dataDir = resolve(env.DATA_DIR ?? 'data/matches');

const server = await startGameServer({
  clock: new ScaledClock(speed),
  store: new JsonlStore(dataDir),
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '0.0.0.0',
  agentWeights: weights,
  fillBotsAfterMs: fill,
  log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
});
console.log(`match logs → ${dataDir}${fill !== null ? `; DEV bot fill after ${fill}ms` : ''}`);

const stop = async () => {
  console.log('shutting down; running matches are marked aborted');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
