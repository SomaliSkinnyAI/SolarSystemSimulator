#!/usr/bin/env node
// Downloads planet textures from solarsystemscope.com to public/textures/
// Usage: node scripts/download-textures.js

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TEXTURES_DIR = path.join(__dirname, '..', 'public', 'textures');

const DOWNLOADS = [
  // --- Planets (solarsystemscope.com) ---
  { url: 'https://www.solarsystemscope.com/textures/download/2k_sun.jpg', file: 'sun.jpg' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_mercury.jpg', file: 'mercury.jpg' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_venus_surface.jpg', file: 'venus.jpg' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_earth_daymap.jpg', file: 'earth_day.jpg' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_earth_nightmap.jpg', file: 'earth_night.jpg' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_moon.jpg', file: 'moon.jpg' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_mars.jpg', file: 'mars.jpg' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_jupiter.jpg', file: 'jupiter.jpg' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_saturn.jpg', file: 'saturn.jpg' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_saturn_ring_alpha.png', file: 'saturn_rings.png' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_uranus.jpg', file: 'uranus.jpg' },
  { url: 'https://www.solarsystemscope.com/textures/download/2k_neptune.jpg', file: 'neptune.jpg' },
  // --- Pluto (planetpixelemporium) ---
  { url: 'https://planetpixelemporium.com/download/download.php?plutomap2k.jpg', file: 'pluto.jpg' },
  // --- Jupiter moons (USGS Astrogeology — public domain) ---
  { url: 'https://astrogeology.usgs.gov/ckan/dataset/f6924861-ce9c-490d-8a4b-7812a20f2de5/resource/a9fab679-8081-4144-9f58-45848836c8f5/download/full.jpg', file: 'io.jpg' },
  { url: 'https://stevealbers.net/albers/sos/jupiter/europa/europa_rgb_cyl_juno.png', file: 'europa.png' },
  { url: 'https://astrogeology.usgs.gov/ckan/dataset/e1422336-3291-4b65-b903-c942d53de073/resource/eb32abd7-fee2-47d1-9f96-9d7d8824cc3a/download/ganymede_voyager_galileossi_global_clrmosaic_1024.jpg', file: 'ganymede.jpg' },
  { url: 'https://astrogeology.usgs.gov/ckan/dataset/a80abd68-7ed9-440e-829a-76376779164f/resource/ac628525-cb1c-4742-928b-5a0a60f372cd/download/callisto_voyager_galileossi_global_mosaic_1024.jpg', file: 'callisto.jpg' },
  // --- Titan (Cassini ISS — public domain) ---
  { url: 'https://astrogeology.usgs.gov/ckan/dataset/8ee17e4e-26c6-4e22-9c23-bc9a4c7ed35e/resource/c3f3006c-3174-4716-920f-44f5dc749a4a/download/titan_iss_p19658_mosaic_global_1024.jpg', file: 'titan.jpg' },
];

if (!fs.existsSync(TEXTURES_DIR)) {
  fs.mkdirSync(TEXTURES_DIR, { recursive: true });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      console.log(`  SKIP  ${path.basename(dest)} (already exists)`);
      return resolve();
    }
    console.log(`  GET   ${path.basename(dest)} ...`);
    const file = fs.createWriteStream(dest);
    const request = (reqUrl) => {
      const getter = reqUrl.startsWith('https') ? https : http;
      getter.get(reqUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode} for ${reqUrl}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          const size = fs.statSync(dest).size;
          console.log(`  OK    ${path.basename(dest)} (${(size / 1024).toFixed(0)} KB)`);
          resolve();
        });
      }).on('error', (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
    };
    request(url);
  });
}

async function main() {
  console.log(`\nDownloading ${DOWNLOADS.length} textures to ${TEXTURES_DIR}\n`);
  let ok = 0, fail = 0;
  for (const { url, file } of DOWNLOADS) {
    try {
      await download(url, path.join(TEXTURES_DIR, file));
      ok++;
    } catch (err) {
      console.error(`  FAIL  ${file}: ${err.message}`);
      fail++;
    }
  }
  console.log(`\nDone: ${ok} downloaded, ${fail} failed\n`);
}

main();
