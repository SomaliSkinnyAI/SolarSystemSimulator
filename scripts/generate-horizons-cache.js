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

// Per-body step size. Cubic Hermite interpolation needs ≥ ~8 samples per
// orbit for sub-percent position error; a uniform 2d step catastrophically
// undersampled the fast inner moons (Mimas period = 0.94 d!).
// [id, horizonsCommand, stepSize]
const TARGETS = [
  ['sun', '10', '2d'],
  ['mercury', '199', '2d'],
  ['venus', '299', '2d'],
  ['earth', '399', '2d'],
  ['moon', '301', '12h'],       // P = 27.3 d
  ['mars', '499', '2d'],
  ['jupiter', '599', '2d'],
  ['io', '501', '4h'],          // P = 1.77 d
  ['europa', '502', '4h'],      // P = 3.55 d
  ['ganymede', '503', '6h'],    // P = 7.15 d
  ['callisto', '504', '12h'],   // P = 16.7 d
  ['saturn', '699', '2d'],
  ['mimas', '601', '2h'],       // P = 0.94 d
  ['enceladus', '602', '2h'],   // P = 1.37 d
  ['tethys', '603', '4h'],      // P = 1.89 d
  ['dione', '604', '4h'],       // P = 2.74 d
  ['rhea', '605', '6h'],        // P = 4.52 d
  ['titan', '606', '12h'],      // P = 15.9 d
  ['iapetus', '608', '2d'],     // P = 79.3 d
  ['uranus', '799', '2d'],
  ['neptune', '899', '2d'],
  ['pluto', '999', '2d'],
  ['halley', '90000030', '2d'],
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

function horizonsUrl(command, stepSize) {
  const params = new URLSearchParams({
    format: 'json',
    COMMAND: command,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: '@0',
    START_TIME,
    STOP_TIME,
    STEP_SIZE: stepSize,
    VEC_TABLE: '2',
    CSV_FORMAT: 'YES',
    OUT_UNITS: 'KM-S',
    REF_PLANE: 'ECLIPTIC',
    REF_SYSTEM: 'ICRF',
  });
  return `https://ssd.jpl.nasa.gov/api/horizons.api?${params.toString()}`;
}

// Trim JSON size: metre-level positions (3 decimals in km) and mm/s-level
// velocities (6 decimals in km/s) are far below interpolation error.
function roundSample(sample) {
  return [
    Number(sample[0].toFixed(8)),
    Number(sample[1].toFixed(3)),
    Number(sample[2].toFixed(3)),
    Number(sample[3].toFixed(3)),
    Number(sample[4].toFixed(6)),
    Number(sample[5].toFixed(6)),
    Number(sample[6].toFixed(6)),
  ];
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
  for (const [id, command, stepSize] of TARGETS) {
    process.stdout.write(`Fetching ${id.padEnd(10)} ${command} @ ${stepSize.padEnd(3)} ... `);
    const json = await requestJson(horizonsUrl(command, stepSize));
    if (json.error) throw new Error(`${id}: ${json.error}`);
    const samples = parseSamples(json.result).map(roundSample);
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
    stepSize: 'per-body (2h fast moons … 2d planets)',
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
