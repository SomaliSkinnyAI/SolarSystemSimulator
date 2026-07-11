#!/usr/bin/env node
// Generate a browser-loadable JPL Horizons state-vector cache.
// Data source: https://ssd.jpl.nasa.gov/api/horizons.api

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, '..', 'public', 'ephemeris');
const OUT_FILE = path.join(OUT_DIR, 'horizons-2024-2028.json');

const START_TIME = '2024-Jan-01';
const STOP_TIME = '2028-Dec-31';
const STEP_SIZE = '2d';

const TARGETS = [
  ['sun', '10'],
  ['mercury', '199'],
  ['venus', '299'],
  ['earth', '399'],
  ['moon', '301'],
  ['mars', '499'],
  ['jupiter', '599'],
  ['io', '501'],
  ['europa', '502'],
  ['ganymede', '503'],
  ['callisto', '504'],
  ['saturn', '699'],
  ['mimas', '601'],
  ['enceladus', '602'],
  ['tethys', '603'],
  ['dione', '604'],
  ['rhea', '605'],
  ['titan', '606'],
  ['iapetus', '608'],
  ['uranus', '799'],
  ['neptune', '899'],
  ['pluto', '999'],
  ['halley', '90000030'],
];

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        requestJson(res.headers.location).then(resolve, reject);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Failed to parse JSON: ${err.message}`));
        }
      });
    }).on('error', reject);
  });
}

function horizonsUrl(command) {
  const params = new URLSearchParams({
    format: 'json',
    COMMAND: command,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: '@0',
    START_TIME,
    STOP_TIME,
    STEP_SIZE,
    VEC_TABLE: '2',
    CSV_FORMAT: 'YES',
    OUT_UNITS: 'KM-S',
    REF_PLANE: 'ECLIPTIC',
    REF_SYSTEM: 'ICRF',
  });
  return `https://ssd.jpl.nasa.gov/api/horizons.api?${params.toString()}`;
}

function parseSamples(resultText) {
  const start = resultText.indexOf('$$SOE');
  const end = resultText.indexOf('$$EOE');
  if (start === -1 || end === -1) {
    throw new Error('Horizons response did not contain $$SOE/$$EOE markers');
  }

  const rows = resultText.slice(start + '$$SOE'.length, end).trim().split(/\r?\n/);
  return rows
    .map(row => row.split(',').map(part => part.trim()))
    .filter(parts => parts.length >= 8)
    .map(parts => [
      Number(parts[0]),
      Number(parts[2]),
      Number(parts[3]),
      Number(parts[4]),
      Number(parts[5]),
      Number(parts[6]),
      Number(parts[7]),
    ])
    .filter(sample => sample.every(Number.isFinite));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const bodies = {};
  for (const [id, command] of TARGETS) {
    process.stdout.write(`Fetching ${id.padEnd(10)} ${command} ... `);
    const json = await requestJson(horizonsUrl(command));
    if (json.error) throw new Error(`${id}: ${json.error}`);
    const samples = parseSamples(json.result);
    bodies[id] = samples;
    console.log(`${samples.length} samples`);
  }

  const cache = {
    source: 'NASA/JPL Horizons API',
    generatedAt: new Date().toISOString(),
    center: 'Solar System barycenter (@0)',
    frame: 'ICRF, ecliptic plane, geometric vectors',
    units: 'km and km/s',
    startTime: START_TIME,
    stopTime: STOP_TIME,
    stepSize: STEP_SIZE,
    fields: ['jd_tdb', 'x_km', 'y_km', 'z_km', 'vx_km_s', 'vy_km_s', 'vz_km_s'],
    targets: Object.fromEntries(TARGETS.map(([id, command]) => [id, command])),
    bodies,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(cache));
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
