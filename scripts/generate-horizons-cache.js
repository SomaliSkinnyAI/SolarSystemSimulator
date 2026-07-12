#!/usr/bin/env node
// Generate the v2 JPL Horizons ephemeris cache: one binary file per body
// (Float32, 6 components per sample, UNIFORM time step — no per-sample JD)
// plus a small index.json with {jd0, stepDays, count} per body.
// Range 2020-2035, tiered step sizes, and real spacecraft trajectories.
// Data source: https://ssd.jpl.nasa.gov/api/horizons.api

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, '..', 'public', 'ephemeris');
const INDEX_FILE = path.join(OUT_DIR, 'index.json');

const DEFAULT_START = '2020-Jan-01';
const DEFAULT_STOP = '2035-Dec-31';

// [id, horizonsCommand, stepSize, options]
// Steps sized for cubic Hermite interpolation (≥ ~8 samples per orbit).
const TARGETS = [
  ['sun', '10', '2d'],
  ['mercury', '199', '2d'],
  ['venus', '299', '2d'],
  ['earth', '399', '2d'],
  ['moon', '301', '12h'],
  ['mars', '499', '2d'],
  ['jupiter', '599', '2d'],
  ['io', '501', '4h'],
  ['europa', '502', '4h'],
  ['ganymede', '503', '6h'],
  ['callisto', '504', '12h'],
  ['saturn', '699', '2d'],
  ['mimas', '601', '2h'],
  ['enceladus', '602', '2h'],
  ['tethys', '603', '4h'],
  ['dione', '604', '4h'],
  ['rhea', '605', '6h'],
  ['titan', '606', '12h'],
  ['iapetus', '608', '2d'],
  ['uranus', '799', '2d'],
  ['neptune', '899', '2d'],
  ['pluto', '999', '2d'],
  ['halley', '90000030', '2d'],
  // Spacecraft (kinematic in-app; skipped gracefully if Horizons has no data)
  ['voyager1', '-31', '5d', { spacecraft: true, name: 'Voyager 1' }],
  ['voyager2', '-32', '5d', { spacecraft: true, name: 'Voyager 2' }],
  ['newhorizons', '-98', '5d', { spacecraft: true, name: 'New Horizons' }],
  ['parker', '-96', '6h', { spacecraft: true, name: 'Parker Solar Probe', stop: '2029-Dec-31' }],
  ['jwst', '-170', '1d', { spacecraft: true, name: 'JWST', start: '2022-Jan-02', stop: '2027-Dec-31' }],
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

function horizonsUrl(command, stepSize, start, stop) {
  const params = new URLSearchParams({
    format: 'json',
    COMMAND: command,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: '@0',
    START_TIME: start,
    STOP_TIME: stop,
    STEP_SIZE: stepSize,
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
      Number(parts[2]), Number(parts[3]), Number(parts[4]),
      Number(parts[5]), Number(parts[6]), Number(parts[7]),
    ])
    .filter(sample => sample.every(Number.isFinite));
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const index = {
    version: 2,
    source: 'NASA/JPL Horizons API',
    generatedAt: new Date().toISOString(),
    center: 'Solar System barycenter (@0)',
    frame: 'ICRF, ecliptic plane, geometric vectors',
    units: 'km and km/s (Float32, 6 per sample: x y z vx vy vz)',
    startTime: DEFAULT_START,
    stopTime: DEFAULT_STOP,
    bodies: {},
    spacecraft: [],
  };

  for (const [id, command, stepSize, opts = {}] of TARGETS) {
    const start = opts.start ?? DEFAULT_START;
    const stop = opts.stop ?? DEFAULT_STOP;
    process.stdout.write(`Fetching ${id.padEnd(12)} ${String(command).padEnd(9)} @ ${stepSize.padEnd(3)} ${start}..${stop} ... `);
    let samples;
    try {
      const json = await requestJson(horizonsUrl(command, stepSize, start, stop));
      if (json.error) throw new Error(json.error);
      samples = parseSamples(json.result);
      if (samples.length < 2) throw new Error('too few samples');
    } catch (err) {
      if (opts.spacecraft) {
        console.log(`SKIPPED (${err.message.slice(0, 80)})`);
        continue;
      }
      throw new Error(`${id}: ${err.message}`);
    }

    // Verify uniform spacing (the loader brackets by index arithmetic)
    const jd0 = samples[0][0];
    const jdN = samples[samples.length - 1][0];
    const stepDays = (jdN - jd0) / (samples.length - 1);
    let maxDev = 0;
    for (let i = 1; i < samples.length; i++) {
      const expected = jd0 + i * stepDays;
      maxDev = Math.max(maxDev, Math.abs(samples[i][0] - expected));
    }
    if (maxDev > 1e-5) {
      throw new Error(`${id}: non-uniform sampling (max deviation ${maxDev} days)`);
    }

    const data = new Float32Array(samples.length * 6);
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      data[i * 6] = s[1]; data[i * 6 + 1] = s[2]; data[i * 6 + 2] = s[3];
      data[i * 6 + 3] = s[4]; data[i * 6 + 4] = s[5]; data[i * 6 + 5] = s[6];
    }
    const file = `${id}.bin`;
    fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(data.buffer));

    index.bodies[id] = {
      jd0,
      stepDays,
      count: samples.length,
      file,
      spk: String(command),
      ...(opts.spacecraft ? { name: opts.name } : {}),
    };
    if (opts.spacecraft) index.spacecraft.push(id);
    console.log(`${samples.length} samples (${(data.byteLength / 1024).toFixed(0)} KB)`);
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index));
  console.log(`Wrote ${INDEX_FILE}`);
  // The v1 monolithic cache is superseded
  const legacy = path.join(OUT_DIR, 'horizons-2024-2028.json');
  if (fs.existsSync(legacy)) {
    fs.unlinkSync(legacy);
    console.log('Removed legacy horizons-2024-2028.json');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
