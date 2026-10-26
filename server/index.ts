import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { startDishProxies } from './ifaceProxy.js';
import { DishStore } from './store.js';
import { startPoller } from './poller.js';
import { HistoryCache, RateLimiter } from './historyCache.js';
import { ROOT } from './root.js';
import { mockHistory } from './mock.js';
import { log } from './log.js';

const PORT = Number(process.env.PORT || 8787);
/** Default bind: all interfaces (LAN). Set HOST=127.0.0.1 to keep it local. */
const HOST = process.env.HOST || '0.0.0.0';

/** History route: upstream get_history at most once per HISTORY_MIN_INTERVAL_MS per dish (others get the cached copy),
 * and each client may call it HISTORY_RATE_MAX times per HISTORY_RATE_WINDOW_MS per dish (else 429). */
const HISTORY_MIN_INTERVAL_MS = Number(process.env.HISTORY_MIN_INTERVAL_MS || 10_000);
const HISTORY_RATE_MAX = Number(process.env.HISTORY_RATE_MAX || 30);
const HISTORY_RATE_WINDOW_MS = Number(process.env.HISTORY_RATE_WINDOW_MS || 60_000);

const cfg = loadConfig();
const proxies = startDishProxies(cfg.dishes);
const store = new DishStore(cfg.dishes);
const MOCK_ON = process.env.MOCK === '1' || process.env.MOCK === 'true';
const history = new HistoryCache(MOCK_ON && process.env.MOCK_HISTORY === '1' ? mockHistory : undefined);
const poller = startPoller(store, cfg, proxies, { history });
const limiter = new RateLimiter(HISTORY_RATE_MAX, HISTORY_RATE_WINDOW_MS);

const shutdown = () => {
  poller.stop();
  try { store.flush(); } catch (err) { log.warn('[store] flush failed', err); }
  for (const p of proxies.values()) p.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// No CORS plugin: browsers on other origins can't read the API; same-origin UI and server-side clients (the hub) are unaffected.
// Request logs are info level, so off by default (the hub polls constantly); warnings/errors still log. FASTIFY_LOG=info to turn them on.
const app = Fastify({ logger: { level: process.env.FASTIFY_LOG || 'warn' } });

app.get('/api/health', async () => ({
  ok: true,
  mock: poller.mock,
  mode: poller.mode,
}));

app.get('/api/status', async () =>
  store.snapshot({
    mock: poller.mock,
    mode: poller.mode,
    pollIntervalMs: poller.pollIntervalMs,
    dishAddress: poller.dishAddress,
  }),
);

app.get('/api/config', async () => ({
  title: cfg.title,
  subtitle: cfg.subtitle,
  mode: poller.mode,
  pollIntervalMs: cfg.pollIntervalMs,
  dishes: cfg.dishes.map((d) => ({
    slot: d.slot,
    label: d.label,
    kind: d.kind || null,
    address: d.address,
    interface: d.interface || null,
    localAddress: d.localAddress || null,
    ssidHint: d.ssidHint || null,
    proxy: proxies.get(d.slot)?.mode ?? null,
    grpcTarget: proxies.get(d.slot)?.grpcTarget ?? d.address,
  })),
}));

app.get('/api/dishes/:slot', async (req, reply) => {
  const slot = (req.params as { slot: string }).slot;
  if (!store.has(slot)) {
    return reply.code(404).send({ error: 'Unknown slot' });
  }
  return store.dishes[slot];
});

// Read-only raw dish history (for history loggers such as a home hub). 503 {away:true} when unreachable.
app.get('/api/dish/:dish/history', async (req, reply) => {
  const slot = (req.params as { dish: string }).dish;
  const d = cfg.dishes.find((x) => x.slot === slot);
  if (!d) {
    return reply.code(404).send({ error: 'Unknown dish' });
  }
  const wait = limiter.take(`${req.ip}|${slot}`);
  if (wait > 0) {
    reply.header('Retry-After', String(Math.ceil(wait / 1000)));
    return reply.code(429).send({ error: 'rate limited', retryAfterMs: wait });
  }
  if (poller.mock && process.env.MOCK_HISTORY !== '1') return reply.code(503).send({ away: true, error: 'mock mode' });
  const target = proxies.get(d.slot)?.grpcTarget ?? d.address;
  try {
    const h = await history.get(slot, target, HISTORY_MIN_INTERVAL_MS, 4000);
    const s = store.dishes[slot];
    reply.header('Cache-Control', 'no-store');
    return { dish: slot, fetchedAt: h.fetchedAt, cached: h.cached, deviceId: s.deviceId ?? null, history: h.history };
  } catch (err) {
    return reply.code(503).send({ away: true, error: String((err as Error)?.message || err).slice(0, 200) });
  }
});

const clientDist = path.join(ROOT, 'dist/client');
if (fs.existsSync(clientDist)) {
  await app.register(fastifyStatic, {
    root: clientDist,
    prefix: '/',
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Dish Monitor</title></head>
<body style="font-family:system-ui;background:#0b1220;color:#e8eefc;padding:2rem">
  <h1>Dish Monitor API</h1>
  <p>API is up on port ${PORT} (mode=${poller.mode}). In dev, open the Vite UI at
  <a style="color:#7dd3fc" href="http://localhost:5173">http://localhost:5173</a>.</p>
  <p><a style="color:#7dd3fc" href="/api/status">/api/status</a> ·
     <a style="color:#7dd3fc" href="/api/config">/api/config</a></p>
</body></html>`);
  });
}

await app.listen({ port: PORT, host: HOST });
log.info(`[server] listening on http://${HOST}:${PORT} (mode=${poller.mode} mock=${poller.mock})`);
