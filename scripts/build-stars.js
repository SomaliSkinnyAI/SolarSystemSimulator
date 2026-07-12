#!/usr/bin/env node
// Convert the Yale Bright Star Catalog (~9.1k naked-eye stars) into a compact
// sim-frame star table: public/data/stars.json = [[x,y,z,vmag,r,g,b], ...]
// Source: https://github.com/brettonw/YaleBrightStarCatalog (bsc5-short.json)
//   RA "00h 05m 09.9s", Dec "+45° 13′ 45″", V "6.70", K "9750" (color temp)

const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = 'https://raw.githubusercontent.com/brettonw/YaleBrightStarCatalog/master/bsc5-short.json';
const OUT = path.join(__dirname, '..', 'public', 'data', 'stars.json');

const OBLIQUITY = 23.4392911 * Math.PI / 180; // J2000 mean obliquity

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location).then(resolve, reject);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function parseRA(s) {
  const m = s.match(/(\d+)h\s*(\d+)m\s*([\d.]+)s/);
  if (!m) return null;
  return (Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600) * 15 * Math.PI / 180;
}

function parseDec(s) {
  const m = s.match(/([+-])(\d+)[°d]\s*(\d+)[′']\s*([\d.]+)[″"]/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) + Number(m[3]) / 60 + Number(m[4]) / 3600) * Math.PI / 180;
}

// Blackbody temperature (K) -> linear-ish RGB (Tanner Helland approximation)
function kelvinToRGB(k) {
  const t = Math.min(Math.max(k, 1500), 40000) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const clamp = v => Math.min(255, Math.max(0, v)) / 255;
  return [clamp(r), clamp(g), clamp(b)];
}

async function main() {
  console.log('Fetching Yale Bright Star Catalog ...');
  const raw = await fetchJson(SRC);
  const rows = [];
  for (const star of raw) {
    if (!star.RA || !star.Dec || star.V === undefined) continue;
    const ra = parseRA(star.RA);
    const dec = parseDec(star.Dec);
    const v = Number(star.V);
    if (ra === null || dec === null || !Number.isFinite(v)) continue;

    // Equatorial unit vector
    const xEq = Math.cos(dec) * Math.cos(ra);
    const yEq = Math.cos(dec) * Math.sin(ra);
    const zEq = Math.sin(dec);
    // Rotate to ecliptic frame
    const xEc = xEq;
    const yEc = Math.cos(OBLIQUITY) * yEq + Math.sin(OBLIQUITY) * zEq;
    const zEc = -Math.sin(OBLIQUITY) * yEq + Math.cos(OBLIQUITY) * zEq;
    // Sim frame: X = ecl X, Y(up) = ecl Z, Z = -ecl Y
    const x = xEc, y = zEc, z = -yEc;

    const kelvin = Number(star.K) || 5800;
    const [r, g, b] = kelvinToRGB(kelvin);

    rows.push([
      Number(x.toFixed(5)), Number(y.toFixed(5)), Number(z.toFixed(5)),
      Number(v.toFixed(2)),
      Number(r.toFixed(3)), Number(g.toFixed(3)), Number(b.toFixed(3)),
    ]);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rows));
  console.log(`Wrote ${rows.length} stars to ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
