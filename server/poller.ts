import { classifyHardware, fetchDishStatus, type RawDishStatus } from './dishClient.js';
import { mockDish } from './mock.js';
import type { AppConfig, DishConfig } from './config.js';
import { resolveMode } from './config.js';
import type { ProxyHandle } from './ifaceProxy.js';
import type { DishStore } from './store.js';
import type { DishSlot, RunMode } from './types.js';

const MOCK = process.env.MOCK === '1' || process.env.MOCK === 'true';

function applyRaw(store: DishStore, slot: DishSlot, raw: RawDishStatus) {
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

async function pollTarget(
  store: DishStore,
  cfg: AppConfig,
  grpcTarget: string,
  preferredSlot?: DishSlot,
): Promise<{ ok: true; slot: DishSlot } | { ok: false; error: string }> {
  try {
    const raw = await fetchDishStatus(grpcTarget);
    const slot = resolveSlot(store, cfg, raw, preferredSlot);
    applyRaw(store, slot, raw);
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
  if (MOCK) {
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
) {
  const resolved: RunMode = MOCK ? 'mock' : resolveMode(cfg);
  const pollMs = cfg.pollIntervalMs;
  console.log(
    `[poller] mode=${resolved} MOCK=${MOCK} interval=${pollMs}ms ` +
      `targets=${cfg.dishes.map((d) => `${d.slot}@${proxies.get(d.slot)?.grpcTarget}`).join(', ')}`,
  );

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await pollOnce(store, cfg, resolved === 'mock' ? 'dual' : resolved, proxies);
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
    mock: MOCK,
    mode: resolved,
  };
}
