import fs from 'node:fs';
import path from 'node:path';
import type { DishConfig } from './config.js';
import type { DishMetrics, DishSlot, MonitorSnapshot, PersistedDish, RunMode, SparklinePoint } from './types.js';

import { ROOT } from './root.js';
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

function emptyDish(cfg: DishConfig): DishMetrics {
  return {
    slot: cfg.slot,
    label: cfg.label,
    wifiHint: cfg.wifiHint || '',
    ssidHint: cfg.ssidHint || null,
    interfaceName: cfg.interface?.trim() || null,
    localAddress: cfg.localAddress?.trim() || null,
    freshness: 'UNKNOWN',
    reachable: false,
    deviceId: null,
    hardwareVersion: null,
    softwareVersion: null,
    state: 'UNKNOWN',
    downMbps: null,
    upMbps: null,
    pingMs: null,
    dropRate: null,
    snrAboveNoiseFloor: null,
    obstructionPct: null,
    currentlyObstructed: null,
    uptimeSeconds: null,
    schemaSuspect: false,
    lastUpdated: null,
    lastLiveAt: null,
    sparkline: [],
    error: null,
  };
}

function fileFor(slot: DishSlot) {
  return path.join(DATA_DIR, `${slot}.json`);
}

function toPersisted(d: DishMetrics): PersistedDish {
  return {
    slot: d.slot,
    deviceId: d.deviceId,
    hardwareVersion: d.hardwareVersion,
    softwareVersion: d.softwareVersion,
    state: d.state,
    downMbps: d.downMbps,
    upMbps: d.upMbps,
    pingMs: d.pingMs,
    dropRate: d.dropRate,
    snrAboveNoiseFloor: d.snrAboveNoiseFloor,
    obstructionPct: d.obstructionPct,
    currentlyObstructed: d.currentlyObstructed,
    uptimeSeconds: d.uptimeSeconds,
    lastUpdated: d.lastUpdated,
    lastLiveAt: d.lastLiveAt,
    sparkline: d.sparkline.slice(-120),
  };
}

function fromPersisted(raw: Partial<PersistedDish>, cfg: DishConfig): DishMetrics {
  const base = emptyDish(cfg);
  return {
    ...base,
    ...raw,
    slot: cfg.slot,
    label: cfg.label,
    wifiHint: cfg.wifiHint || base.wifiHint,
    ssidHint: cfg.ssidHint || null,
    interfaceName: cfg.interface?.trim() || null,
    localAddress: cfg.localAddress?.trim() || null,
    freshness: 'STALE',
    reachable: false,
    sparkline: Array.isArray(raw.sparkline) ? (raw.sparkline as SparklinePoint[]) : [],
    error: null,
  };
}

export class DishStore {
  dishes: Record<DishSlot, DishMetrics> = {};
  readonly order: DishSlot[];
  private cfgs: Record<DishSlot, DishConfig> = {};
  /** Status file writes: immediately when state/device/freshness changes, else at most every persistMs. */
  private lastWrite: Record<DishSlot, { at: number; key: string }> = {};
  writes = 0;
  persistMs = Number(process.env.PERSIST_MS || 60_000);

  constructor(dishConfigs: DishConfig[]) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.order = dishConfigs.map((d) => d.slot);
    for (const d of dishConfigs) {
      this.cfgs[d.slot] = d;
      this.dishes[d.slot] = emptyDish(d);
    }
    this.load();
  }

  has(slot: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.cfgs, slot);
  }

  load() {
    for (const slot of this.order) {
      const fp = fileFor(slot);
      if (!fs.existsSync(fp)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as PersistedDish;
        this.dishes[slot] = fromPersisted(raw, this.cfgs[slot]);
      } catch (err) {
        console.warn(`[store] failed to load ${fp}:`, err);
      }
    }
  }

  private changeKey(slot: DishSlot): string {
    const d = this.dishes[slot];
    return [d.freshness, d.state, d.deviceId, d.hardwareVersion, d.softwareVersion, d.currentlyObstructed, d.schemaSuspect].join('|');
  }

  /** Write only on a meaningful change, or when the last write is older than persistMs (or force). */
  maybePersist(slot: DishSlot, force = false) {
    const key = this.changeKey(slot);
    const last = this.lastWrite[slot];
    const now = Date.now();
    if (!force && last && last.key === key && now - last.at < this.persistMs) return false;
    this.persist(slot);
    this.lastWrite[slot] = { at: now, key };
    return true;
  }

  /** Flush every dish (shutdown). */
  flush() { for (const s of this.order) if (this.dishes[s].lastLiveAt) this.maybePersist(s, true); }

  persist(slot: DishSlot) {
    this.writes++;
    const fp = fileFor(slot);
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(toPersisted(this.dishes[slot]), null, 2));
    fs.renameSync(tmp, fp);
  }

  markLive(slot: DishSlot, patch: Partial<DishMetrics>) {
    const now = new Date().toISOString();
    const cfg = this.cfgs[slot];
    this.dishes[slot] = {
      ...this.dishes[slot],
      ...patch,
      slot,
      label: cfg.label,
      wifiHint: cfg.wifiHint || this.dishes[slot].wifiHint,
      ssidHint: cfg.ssidHint || null,
      interfaceName: cfg.interface?.trim() || null,
      localAddress: cfg.localAddress?.trim() || null,
      freshness: 'LIVE',
      reachable: true,
      lastUpdated: now,
      lastLiveAt: now,
      error: null,
    };
    this.maybePersist(slot);
  }

  markStale(slot: DishSlot, error?: string | null) {
    const d = this.dishes[slot];
    const hasData = Boolean(d.lastLiveAt || d.lastUpdated);
    this.dishes[slot] = {
      ...d,
      freshness: hasData ? 'STALE' : 'UNKNOWN',
      reachable: false,
      error: error ?? d.error,
    };
  }

  snapshot(opts: {
    mock: boolean;
    mode: RunMode;
    pollIntervalMs: number;
    dishAddress: string;
  }): MonitorSnapshot {
    const note = opts.mock
      ? 'MOCK mode: simulated dish data.'
      : opts.mode === 'dual'
        ? 'Dual-NIC mode: both dishes polled in parallel, one network interface each.'
        : this.order.length === 1
          ? 'Single-dish mode.'
          : 'Single-NIC mode: the dish on the current Wi-Fi is LIVE; the other shows last-known STALE data.';

    return {
      mock: opts.mock,
      mode: opts.mode,
      pollIntervalMs: opts.pollIntervalMs,
      dishAddress: opts.dishAddress,
      updatedAt: new Date().toISOString(),
      dishes: this.order.map((s) => this.dishes[s]),
      note,
    };
  }
}
