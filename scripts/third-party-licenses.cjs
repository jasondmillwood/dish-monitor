#!/usr/bin/env node
// Regenerate THIRD_PARTY_LICENSES from node_modules (run after `npm ci`). Exits 1 on a non-permissive runtime license.
const fs = require('fs'), path = require('path');
const lock = require('../package-lock.json').packages;
const ROOT = path.resolve(__dirname, '..');
const rows = [];
for (const [k, v] of Object.entries(lock)) {
  const dir = path.join(ROOT, k);
  if (!k || !fs.existsSync(path.join(dir, 'package.json'))) continue;
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let lic = p.license || 'UNKNOWN'; if (typeof lic === 'object') lic = lic.type;
  const lf = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  rows.push({ name: p.name, ver: p.version, lic, dev: !!v.dev, text: lf ? fs.readFileSync(path.join(dir, lf), 'utf8').trim() : null });
}
rows.sort((a, b) => a.name.localeCompare(b.name) || a.ver.localeCompare(b.ver));
const OK = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|BlueOak-1\.0\.0)$/;
const DEV_OK = /^CC-BY-4\.0$/; // data-only, attribution
const cnt = (d) => { const c = {}; rows.filter((r) => r.dev === d).forEach((r) => (c[r.lic] = (c[r.lic] || 0) + 1)); return Object.entries(c).map(([l, n]) => `${l}: ${n}`).join(', '); };
let o = `THIRD-PARTY LICENSES
====================

Dish Monitor itself is MIT (see LICENSE). This file lists the npm packages installed by
\`npm ci\` (package-lock.json) and their declared licenses. Regenerate: node scripts/third-party-licenses.cjs

Runtime packages (installed by install.sh): ${cnt(false)}
Development-only packages (build/test): ${cnt(true)}

Notes
- All runtime packages are permissive (MIT, ISC, Apache-2.0, BSD, BlueOak-1.0.0).
- caniuse-lite (dev only, via the Vite/Babel toolchain) is CC-BY-4.0: browser-support data, attribution
  required, not copyleft. It is not part of the running server.
- Platform-specific optional binaries (@esbuild/*, @rollup/*) carry their parent's license (MIT);
  only the one for your platform is installed.
- External programs are not bundled: Python 3 (PSF license), NetworkManager/nmcli (GPL; called as a
  separate program by the optional watchdog only).

Summary
-------
`;
for (const r of rows) o += `${r.name}@${r.ver}  ${r.lic}  ${r.dev ? '(dev)' : '(runtime)'}\n`;
o += '\n\nLicense texts (runtime packages)\n================================\n';
for (const r of rows.filter((r) => !r.dev)) o += `\n----- ${r.name}@${r.ver} (${r.lic}) -----\n${r.text || `(no license file shipped; package.json declares ${r.lic})`}\n`;
if (process.argv.includes('--check')) {
  const bad = rows.filter((r) => !(OK.test(r.lic) || (r.dev && DEV_OK.test(r.lic))));
  if (bad.length) { console.error('non-permissive:', bad.map((r) => `${r.name}@${r.ver} ${r.lic}`)); process.exit(1); }
  console.log(`licenses ok (${rows.length} packages)`);
} else {
  fs.writeFileSync(path.join(ROOT, 'THIRD_PARTY_LICENSES'), o);
  console.log(`wrote THIRD_PARTY_LICENSES (${rows.length} packages)`);
}
