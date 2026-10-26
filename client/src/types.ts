export type Freshness = 'LIVE' | 'STALE' | 'UNKNOWN';
export type RunMode = 'dual' | 'single' | 'mock';

export interface SparklinePoint {
  t: number;
  downMbps: number;
  upMbps: number;
  pingMs: number;
}

export interface DishMetrics {
  slot: string;
  label: string;
  wifiHint: string;
  ssidHint: string | null;
  interfaceName: string | null;
  localAddress: string | null;
  freshness: Freshness;
  reachable: boolean;
  deviceId: string | null;
  hardwareVersion: string | null;
  softwareVersion: string | null;
  state: string;
  downMbps: number | null;
  upMbps: number | null;
  pingMs: number | null;
  dropRate: number | null;
  snrAboveNoiseFloor: boolean | null;
  obstructionPct: number | null;
  currentlyObstructed: boolean | null;
  uptimeSeconds: number | null;
  lastUpdated: string | null;
  lastLiveAt: string | null;
  schemaSuspect?: boolean;
  sparkline: SparklinePoint[];
  error: string | null;
}

export interface MonitorSnapshot {
  mock: boolean;
  mode: RunMode;
  pollIntervalMs: number;
  dishAddress: string;
  updatedAt: string;
  dishes: DishMetrics[];
  note: string;
}

export interface DishConfigView {
  slot: string;
  label: string;
  kind: string | null;
  interface: string | null;
  proxy: string | null;
}

export interface MonitorConfig {
  title: string;
  subtitle: string;
  mode: RunMode;
  pollIntervalMs: number;
  dishes: DishConfigView[];
}
