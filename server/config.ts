import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DishSlot } from './types.js';

import { ROOT } from './root.js';

export interface DishConfig {
  /** Short unique id, [a-z0-9_-]{1,32}. Used in URLs and ./data/<slot>.json. */
  slot: DishSlot;
  label: string;
  /** Optional: helps single-NIC mode tell dishes apart. "mini" | "standard". */
  kind?: 'mini' | 'standard';
  /** Optional: pin this slot to a dish device id (shown in the UI once seen). */
  deviceId?: string;
  ssidHint?: string;
  /** Dish gRPC target, usually 192.168.100.1:9200 (the same IP behind every dish). */
  address: string;
  /** OS interface name (Linux wlan0). Needed for two dishes on one machine. */
  interface?: string;
  /** IPv4 source bind; only used when no interface is set (Windows/macOS). */
  localAddress?: string;
  wifiHint?: string;
}

export interface AppConfig {
  title: string;
  subtitle: string;
  pollIntervalMs: number;
  /** auto | dual | single. auto = dual when 2 dishes each have interface/localAddress. */
  mode: 'auto' | 'dual' | 'single';
  dishes: DishConfig[];
}

const DEFAULT_ADDR = '192.168.100.1:9200';
const SLOT_RE = /^[a-z0-9_-]{1,32}$/;

export function defaultDish(i: number): DishConfig {
  return {
    slot: `dish${i + 1}`,
    label: `Dish ${i + 1}`,
    address: process.env.DISH_ADDR || DEFAULT_ADDR,
    interface: '',
    localAddress: '',
    wifiHint: 'Connect this machine to the dish Wi-Fi (or set "interface" in config.json).',
  };
}

export class ConfigError extends Error {}

/** Normalise + validate a parsed config object. Throws ConfigError on bad input. */
export function normalizeConfig(fileCfg: Partial<AppConfig>, env = process.env): AppConfig {
  const raw = Array.isArray(fileCfg.dishes) && fileCfg.dishes.length ? fileCfg.dishes : [{}];
  if (raw.length > 2) throw new ConfigError(`dishes: 1 or 2 entries supported, got ${raw.length}`);
  const dishes = raw.map((d, i) => {
    const merged: DishConfig = { ...defaultDish(i), ...(d as Partial<DishConfig>) };
    merged.slot = String(merged.slot).toLowerCase();
    if (!SLOT_RE.test(merged.slot)) throw new ConfigError(`dishes[${i}].slot "${merged.slot}" must match ${SLOT_RE}`);
    const n = i + 1;
    if (env[`DISH${n}_IFACE`]) merged.interface = env[`DISH${n}_IFACE`];
    if (env[`DISH${n}_LOCAL_ADDR`]) merged.localAddress = env[`DISH${n}_LOCAL_ADDR`];
    if (env[`DISH${n}_ADDR`]) merged.address = env[`DISH${n}_ADDR`]!;
    return merged;
  });
  if (new Set(dishes.map((d) => d.slot)).size !== dishes.length) throw new ConfigError('dishes: slots must be unique');
  const mode = (env.MODE as AppConfig['mode']) || fileCfg.mode || 'auto';
  if (!['auto', 'dual', 'single'].includes(mode)) throw new ConfigError(`mode "${mode}" must be auto|dual|single`);
  return {
    title: fileCfg.title || 'Dish Monitor',
    subtitle: fileCfg.subtitle ?? (dishes.length === 2 ? 'Two dishes' : 'One dish'),
    pollIntervalMs: Number(env.POLL_MS || fileCfg.pollIntervalMs || 3000),
    mode,
    dishes,
  };
}

export function loadConfig(): AppConfig {
  const configPath = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
  let fileCfg: Partial<AppConfig> = {};
  if (fs.existsSync(configPath)) {
    fileCfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<AppConfig>;
    console.log(`[config] loaded ${configPath}`);
  } else {
    console.log(`[config] no ${configPath}; using a single default dish (see config.example.json)`);
  }
  return normalizeConfig(fileCfg);
}

export function dishHasBind(d: DishConfig): boolean {
  return Boolean((d.interface && d.interface.trim()) || (d.localAddress && d.localAddress.trim()));
}

export function resolveMode(cfg: AppConfig): 'dual' | 'single' {
  if (cfg.dishes.length === 1) return 'single';
  if (cfg.mode === 'dual') return 'dual';
  if (cfg.mode === 'single') return 'single';
  return cfg.dishes.filter(dishHasBind).length >= 2 ? 'dual' : 'single';
}
