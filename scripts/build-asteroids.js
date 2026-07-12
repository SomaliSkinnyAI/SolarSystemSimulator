#!/usr/bin/env node
// Fetch real asteroid orbital elements from the JPL Small-Body Database and
// pack them for GPU Keplerian propagation:
//   public/data/asteroids.bin — Float32 ×8 per body:
//     [a_AU, e, i_rad, om_rad, w_rad, M_at_base_rad, n_rad_per_day, H]
//   public/data/asteroids.json — { count, baseJD }
// The first 60k numbered asteroids cover every dynamical group: main belt
// (with the Kirkwood gaps), Hildas, Jupiter Trojans, and near-Earth objects.

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_BIN = path.join(__dirname, '..', 'public', 'data', 'asteroids.bin');
const OUT_META = path.join(__dirname, '..', 'public', 'data', 'asteroids.json');
const BASE_JD = 2460000.5;
const LIMIT = 60000;
const DEG = Math.PI / 180;
// Gaussian-year mean motion: n = 2π / (365.2568983 · a^1.5) rad/day
const N_COEF = (2 * Math.PI) / 365.2568983;

const URL = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api'
  + '?fields=a,e,i,om,w,ma,epoch,H'
  + '&sb-kind=a'
  + `&limit=${LIMIT}`;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log(`Fetching up to ${LIMIT} asteroids from JPL SBDB ...`);
  const json = await fetchJson(URL);
  if (!json.data) throw new Error(`Unexpected response: ${JSON.stringify(json).slice(0, 200)}`);

  const rows = [];
  for (const r of json.data) {
    const a = Number(r[0]);
    const e = Number(r[1]);
    const inc = Number(r[2]) * DEG;
    const om = Number(r[3]) * DEG;
    const w = Number(r[4]) * DEG;
    const ma = Number(r[5]) * DEG;
    const epoch = Number(r[6]);
    const H = Number(r[7]);
    if (![a, e, inc, om, w, ma, epoch].every(Number.isFinite)) continue;
    if (a <= 0.5 || a > 6.5 || e >= 0.95) continue; // keep the classical groups
    const n = N_COEF / Math.pow(a, 1.5);
    let mBase = (ma + n * (BASE_JD - epoch)) % (2 * Math.PI);
    if (mBase < 0) mBase += 2 * Math.PI;
    rows.push([a, e, inc, om, w, mBase, n, Number.isFinite(H) ? H : 16]);
  }

  const data = new Float32Array(rows.length * 8);
  rows.forEach((r, i) => data.set(r, i * 8));
  fs.mkdirSync(path.dirname(OUT_BIN), { recursive: true });
  fs.writeFileSync(OUT_BIN, Buffer.from(data.buffer));
  fs.writeFileSync(OUT_META, JSON.stringify({
    count: rows.length,
    baseJD: BASE_JD,
    source: 'NASA/JPL Small-Body Database Query API',
    generatedAt: new Date().toISOString(),
  }));
  console.log(`Wrote ${rows.length} asteroids (${(data.byteLength / 1048576).toFixed(1)} MB) to ${OUT_BIN}`);
}

main().catch(err => { console.error(err); process.exit(1); });
