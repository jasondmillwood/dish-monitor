import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DishMetrics, MonitorConfig, MonitorSnapshot } from './types';

function fmtMbps(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return '—';
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

function fmtMs(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${Math.round(n)}`;
}

function fmtPct(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n.toFixed(1)}%`;
}

function fmtDrop(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

function fmtUptime(sec: number | null | undefined) {
  if (sec == null) return '—';
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function fmtTime(iso: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function Sparkline({ dish }: { dish: DishMetrics }) {
  const pts = dish.sparkline ?? [];
  const w = 520;
  const h = 64;
  const pathFor = (key: 'downMbps' | 'upMbps' | 'pingMs', color: string) => {
    if (pts.length < 2) return null;
    const vals = pts.map((p) => p[key]);
    const max = Math.max(...vals, 1);
    const min = Math.min(...vals, 0);
    const span = Math.max(max - min, 1e-6);
    const d = pts
      .map((p, i) => {
        const x = (i / (pts.length - 1)) * (w - 4) + 2;
        const y = h - 4 - ((p[key] - min) / span) * (h - 10);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    return <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />;
  };

  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <line x1="0" y1={h - 1} x2={w} y2={h - 1} stroke="#1e2d48" />
      {pathFor('downMbps', '#34d399')}
      {pathFor('upMbps', '#60a5fa')}
      {pathFor('pingMs', '#fbbf24')}
    </svg>
  );
}

async function runCloudflareSpeedTest(
  onProgress: (msg: string) => void,
): Promise<{ downMbps: number; latencyMs: number }> {
  // Lightweight client-side estimate via Cloudflare speed CDN (not dish API).
  const pingUrl = 'https://speed.cloudflare.com/__down?bytes=0';
  const t0 = performance.now();
  await fetch(pingUrl, { cache: 'no-store', mode: 'cors' });
  const latencyMs = performance.now() - t0;

  const sizes = [1_000_000, 5_000_000, 10_000_000];
  let best = 0;
  for (const bytes of sizes) {
    onProgress(`Downloading ${(bytes / 1e6).toFixed(0)} MB…`);
    const url = `https://speed.cloudflare.com/__down?bytes=${bytes}`;
    const start = performance.now();
    const res = await fetch(url, { cache: 'no-store', mode: 'cors' });
    const buf = await res.arrayBuffer();
    const sec = (performance.now() - start) / 1000;
    const mbps = (buf.byteLength * 8) / sec / 1_000_000;
    best = Math.max(best, mbps);
  }
  return { downMbps: best, latencyMs };
}

function DishCard({ dish }: { dish: DishMetrics }) {
  const [speedMsg, setSpeedMsg] = useState<string | null>(null);
  const [speedBusy, setSpeedBusy] = useState(false);
  const stateClass =
    dish.state === 'CONNECTED' ? 'state-ok' : dish.state === 'UNKNOWN' ? '' : 'state-bad';

  const onSpeed = async () => {
    if (!dish.reachable && dish.freshness !== 'LIVE') {
      setSpeedMsg('Join this dish’s Wi‑Fi first — speedtest uses your current internet path.');
      return;
    }
    setSpeedBusy(true);
    setSpeedMsg('Starting Cloudflare download test…');
    try {
      const r = await runCloudflareSpeedTest(setSpeedMsg);
      setSpeedMsg(`Path speed ≈ ${r.downMbps.toFixed(1)} Mbps down · latency ${r.latencyMs.toFixed(0)} ms`);
    } catch (err) {
      setSpeedMsg(`Speed test failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSpeedBusy(false);
    }
  };

  return (
    <article className={`card ${dish.freshness.toLowerCase()}`}>
      <div className="card-top">
        <div>
          <h2>{dish.label}</h2>
          <div className="slot-tag">
            {dish.slot}
            {dish.interfaceName ? ` · if:${dish.interfaceName}` : ''}
            {dish.ssidHint ? ` · SSID~${dish.ssidHint}` : ''}
            {' · '}
            {dish.hardwareVersion || 'hardware ?'}
          </div>
        </div>
        <span className={`badge ${dish.freshness}`}>{dish.freshness}</span>
      </div>

      <p className="wifi-hint">{dish.wifiHint}</p>
      {dish.error && dish.freshness !== 'LIVE' ? <p className="error-line">{dish.error}</p> : null}

      <div className="metrics">
        <div className="metric">
          <div className="label">Down</div>
          <div className="value down">{fmtMbps(dish.downMbps)} <small>Mbps</small></div>
        </div>
        <div className="metric">
          <div className="label">Up</div>
          <div className="value up">{fmtMbps(dish.upMbps)} <small>Mbps</small></div>
        </div>
        <div className="metric">
          <div className="label">Ping</div>
          <div className="value">{fmtMs(dish.pingMs)} <small>ms</small></div>
        </div>
      </div>

      <Sparkline dish={dish} />

      <dl className="detail-grid">
        <div>
          <dt>State</dt>
          <dd className={stateClass}>{dish.state}</dd>
        </div>
        <div>
          <dt>Drop rate</dt>
          <dd>{fmtDrop(dish.dropRate)}</dd>
        </div>
        <div>
          <dt>SNR above floor</dt>
          <dd>
            {dish.snrAboveNoiseFloor == null ? '—' : dish.snrAboveNoiseFloor ? 'yes' : 'no'}
          </dd>
        </div>
        <div>
          <dt>Obstruction</dt>
          <dd>
            {fmtPct(dish.obstructionPct)}
            {dish.currentlyObstructed ? ' · now' : ''}
          </dd>
        </div>
        <div>
          <dt>Uptime</dt>
          <dd>{fmtUptime(dish.uptimeSeconds)}</dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{fmtTime(dish.lastUpdated)}</dd>
        </div>
        <div>
          <dt>Last LIVE</dt>
          <dd>{fmtTime(dish.lastLiveAt)}</dd>
        </div>
        <div>
          <dt>Device ID</dt>
          <dd title={dish.deviceId || undefined}>{dish.deviceId || '—'}</dd>
        </div>
        <div>
          <dt>Software</dt>
          <dd>{dish.softwareVersion || '—'}</dd>
        </div>
        <div>
          <dt>Hardware</dt>
          <dd>{dish.hardwareVersion || '—'}</dd>
        </div>
      </dl>

      <div className="actions">
        <button
          className="primary"
          disabled={speedBusy}
          onClick={onSpeed}
          title="Client-side Cloudflare speed estimate for the current network path"
        >
          {speedBusy ? 'Testing…' : 'Speed test (current path)'}
        </button>
      </div>
      {speedMsg ? <div className="speed-result">{speedMsg}</div> : null}
    </article>
  );
}

export function orderDishes(cfg: MonitorConfig | null, snap: MonitorSnapshot | null): DishMetrics[] {
  const live = snap?.dishes ?? [];
  if (!cfg) return live;
  return cfg.dishes
    .map((c) => live.find((d) => d.slot === c.slot))
    .filter((d): d is DishMetrics => Boolean(d));
}

export default function App() {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cfg, setCfg] = useState<MonitorConfig | null>(null);

  useEffect(() => {
    fetch('/api/config', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: MonitorConfig | null) => {
        if (!c) return;
        setCfg(c);
        document.title = c.title;
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as MonitorSnapshot;
      setSnap(data);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [load]);

  // Cards come from config order; live data is matched by slot.
  const dishes = useMemo(() => orderDishes(cfg, snap), [cfg, snap]);

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1 className="wm">
            {cfg?.title ?? 'Dish Monitor'}
            <span className="wm-sub">{cfg?.subtitle ?? ''}</span>
          </h1>
        </div>
        <div className="meta">
          {snap?.mock ? <span className="pill">MOCK=1</span> : null}
          <span className="pill">mode {snap?.mode ?? '…'}</span>
          <span className="pill">{snap?.dishAddress ?? '…'}</span>
          <span className="pill">poll {snap?.pollIntervalMs ?? '—'} ms</span>
          <span className="pill live-dot" style={{ color: '#22c55e' }}>
            UI refresh 1.5s
          </span>
        </div>
      </header>

      {err ? (
        <p className="error-line">API error: {err}. Is the dish-monitor service running?</p>
      ) : null}

      <div className={`grid n${dishes.length}`}>
        {dishes.map((d) => (
          <DishCard key={d.slot} dish={d} />
        ))}
        {!dishes.length && !err ? <p className="subtitle">Loading dishes…</p> : null}
      </div>

      <p className="footer-note">
        {snap?.note}
        {snap?.updatedAt ? ` · API ${fmtTime(snap.updatedAt)}` : ''}
        {' · '}Sparklines: green=down, blue=up, amber=ping (from get_history when available).
      </p>
    </div>
  );
}
