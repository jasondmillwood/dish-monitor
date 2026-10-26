import { classifyHardware, extractSparkline, fetchDishStatus, type RawDishStatus } from './dishClient.js';
import { HistoryCache } from './historyCache.js';
import { log } from './log.js';
import { mockDish } from './mock.js';
import type { AppConfig, DishConfig } from './config.js';
import { resolveMode } from './config.js';
import type { ProxyHandle } from './ifaceProxy.js';
import type { DishStore } from './store.js';
import type { DishSlot, RunMode } from './types.js';

const MOCK = process.env.MOCK === '1' || process.env.MOCK === 'true';
/** How often the poller refreshes the sparkline from get_history (was: every poll). */
export const HISTORY_POLL_MS = Number(process.env.HISTORY_POLL_MS || 30_000);
const HISTORY_TIMEOUT_MS = 4000;

/**
 * Per-call get_status deadline so one tick fits inside the poll interval (no skipped ticks).
 * `sequential` = targets tried one after another in a tick (single-NIC mode); dual mode polls in parallel.
 */
export function statusTimeoutMs(pollMs: number, sequential = 1): number {
  return Math.max(300, Math.min(2500, Math.floor((pollMs - 250) / Math.max(1, sequential))));
}

export type StatusFetcher = (target: string, timeoutMs: number) => Promise<RawDishStatus>;
interface Ctx { history: HistoryCache; fetchStatus: StatusFetcher; timeoutMs: number; suspectWarned: Set<DishSlot> }
let ctx: Ctx = { history: new HistoryCache(), fetchStatus: fetchDishStatus, timeoutMs: 2500, suspectWarned: new Set() };

function applyRaw(store: DishStore, slot: DishSlot, raw: RawDishStatus) {
  if (raw.schemaSuspect) {
    if (!ctx.suspectWarned.has(slot)) {
      ctx.suspectWarned.add(slot);
      log.warn(`[poller:${slot}] WARNING: dish reports CONNECTED but every metric is 0: firmware/API field drift? (schemaSuspect)`);
    }
  } else if (ctx.suspectWarned.delete(slot)) {
    log.info(`[poller:${slot}] metrics non-zero again (schemaSuspect cleared)`);
  }
  store.markLive(slot, {
    deviceId: raw.deviceId,
    hardwareVersion: raw.hardwareVersion,
    softwareVersion: raw.softwareVersion,
    state: raw.state,
    downMbps: raw.downMbps,
    upMbps: raw.upMbps,
    pingMs: raw.pingMs,
    dropRate: raw.dropRate,
    snrAboveNoiseFloor: raw.snrAboveNoiseFloor,
    obstructionPct: raw.obstructionPct,
    currentlyObstructed: raw.currentlyObstructed,
    uptimeSeconds: raw.uptimeSeconds,
    schemaSuspect: Boolean(raw.schemaSuspect),
    sparkline: raw.sparkline,
  });
}

/** Which configured slot a dish reply belongs to (only ambiguous in single-NIC, 2-dish mode). */
export function resolveSlot(store: DishStore, cfg: AppConfig, raw: RawDishStatus, preferred?: DishSlot): DishSlot {
  if (preferred) return preferred;
  const slots = store.order;
  if (slots.length === 1) return slots[0];
  if (raw.deviceId) {
    const pinned = cfg.dishes.find((d) => d.deviceId && d.deviceId === raw.deviceId);
    if (pinned) return pinned.slot;
    const seen = slots.find((s) => store.dishes[s].deviceId === raw.deviceId);
    if (seen) return seen;
  }
  const hw = classifyHardware(raw.hardwareVersion, raw.deviceId);
  const kindOf = (d: DishConfig) => d.kind || (/mini/i.test(d.label + d.slot) ? 'mini' : 'standard');
  if (hw !== 'unknown') {
    const want = hw === 'mini' ? 'mini' : 'standard';
    const byKind = cfg.dishes.find((d) => kindOf(d) === want);
    if (byKind) return byKind.slot;
  }
  return slots[0];
}

/** Background, cached (HISTORY_POLL_MS) get_history; never blocks the status tick. */
function refreshSparkline(slot: DishSlot, target: string) {
  ctx.history.get(slot, target, HISTORY_POLL_MS, HISTORY_TIMEOUT_MS).catch(() => { /* history is optional */ });
}

async function pollTarget(
  store: DishStore,
  cfg: AppConfig,
  grpcTarget: string,
  preferredSlot?: DishSlot,
): Promise<{ ok: true; slot: DishSlot } | { ok: false; error: string }> {
  try {
    const raw = await ctx.fetchStatus(grpcTarget, ctx.timeoutMs);
    const slot = resolveSlot(store, cfg, raw, preferredSlot);
    refreshSparkline(slot, grpcTarget);
    const h = ctx.history.peek(slot);
    raw.sparkline = h ? extractSparkline(h.history, 60, h.fetchedAt) : store.dishes[slot].sparkline;
    applyRaw(store, slot, raw);
    log.debug(`[poller:${slot}] live down=${raw.downMbps.toFixed(1)} up=${raw.upMbps.toFixed(1)} ping=${raw.pingMs.toFixed(0)}`);
    return { ok: true, slot };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function pollDual(
  store: DishStore,
  cfg: AppConfig,
  dishes: DishConfig[],
  proxies: Map<DishSlot, ProxyHandle>,
) {
  const results = await Promise.all(
    dishes.map(async (d) => {
      const proxy = proxies.get(d.slot)!;
      const result = await pollTarget(store, cfg, proxy.grpcTarget, d.slot);
      return { slot: d.slot, result };
    }),
  );

  for (const { slot, result } of results) {
    if (!result.ok) {
      store.markStale(
        slot,
        `Unreachable via configured NIC (${store.dishes[slot].interfaceName || 'no iface'}): ${result.error}`,
      );
    }
  }
}

async function pollSingle(
  store: DishStore,
  cfg: AppConfig,
  dishes: DishConfig[],
  proxies: Map<DishSlot, ProxyHandle>,
) {
  // Try each configured target; typically only one succeeds on a single radio.
  let liveSlot: DishSlot | null = null;
  let lastErr = 'No dish reachable';

  for (const d of dishes) {
    const proxy = proxies.get(d.slot)!;
    // In single mode without per-iface bind, both configs may share the same direct address —
    // only attempt once against the shared address.
    if (proxy.mode === 'direct' && liveSlot) break;

    const result = await pollTarget(
      store,
      cfg,
      proxy.grpcTarget,
      proxy.mode === 'direct' ? undefined : d.slot,
    );
    if (result.ok) {
      liveSlot = result.slot;
      break;
    }
    lastErr = result.error;
  }

  for (const slot of store.order) {
    if (slot === liveSlot) continue;
    store.markStale(
      slot,
      liveSlot ? `Single-NIC mode: not on this dish's network. ${store.dishes[slot].wifiHint}` : lastErr,
    );
  }
}

async function pollOnce(
  store: DishStore,
  cfg: AppConfig,
  mode: RunMode,
  proxies: Map<DishSlot, ProxyHandle>,
) {
  if (mode === 'mock') {
    // Demo: every configured dish LIVE with independent oscillating metrics.
    cfg.dishes.forEach((d, i) => applyRaw(store, d.slot, mockDish(i, d.kind === 'mini' || /mini/i.test(d.label))));
    return;
  }

  if (mode === 'dual') {
    await pollDual(store, cfg, cfg.dishes, proxies);
  } else {
    await pollSingle(store, cfg, cfg.dishes, proxies);
  }
}

export function startPoller(
  store: DishStore,
  cfg: AppConfig,
  proxies: Map<DishSlot, ProxyHandle>,
  opts: { history?: HistoryCache; fetchStatus?: StatusFetcher; mock?: boolean } = {},
) {
  const mock = opts.mock ?? MOCK;
  const resolved: RunMode = mock ? 'mock' : resolveMode(cfg);
  const pollMs = cfg.pollIntervalMs;
  ctx = {
    history: opts.history ?? new HistoryCache(),
    fetchStatus: opts.fetchStatus ?? fetchDishStatus,
    timeoutMs: statusTimeoutMs(pollMs, resolved === 'single' ? cfg.dishes.length : 1),
    suspectWarned: new Set(),
  };
  log.info(
    `[poller] mode=${resolved} MOCK=${mock} interval=${pollMs}ms statusTimeout=${ctx.timeoutMs}ms history=${HISTORY_POLL_MS}ms ` +
      `targets=${cfg.dishes.map((d) => `${d.slot}@${proxies.get(d.slot)?.grpcTarget}`).join(', ')}`,
  );

  let busy = false;
  let skipped = 0;
  let ticks = 0;
  let lastSummary = Date.now();
  const SUMMARY_MS = Number(process.env.LOG_SUMMARY_MS || 600_000);
  const tick = async () => {
    if (busy) { skipped++; return; }
    busy = true;
    try {
      ticks++;
      await pollOnce(store, cfg, resolved, proxies);
      if (Date.now() - lastSummary >= SUMMARY_MS) {
        lastSummary = Date.now();
        const parts = store.order.map((s) => `${s}=${store.dishes[s].freshness}${store.dishes[s].schemaSuspect ? '(suspect)' : ''}`);
        log.info(`[poller] summary ticks=${ticks} skipped=${skipped} ${parts.join(' ')}`);
        ticks = 0; skipped = 0;
      }
    } catch (err) {
      console.error('[poller] tick failed', err);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, pollMs);
  return {
    timer,
    pollIntervalMs: pollMs,
    dishAddress: cfg.dishes.map((d) => d.address).join(' | '),
    mock,
    mode: resolved,
    history: ctx.history,
    statusTimeoutMs: ctx.timeoutMs,
    tick,
    stop: () => clearInterval(timer),
    stats: () => ({ ticks, skipped }),
  };
}
