import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Recognizable low-poly spacecraft models built from primitives — each
// craft's iconic silhouette: Voyager's 3.7 m dish + RTG boom, Parker's
// heat shield, New Horizons' triangular bus, JWST's 18-hex gold mirror
// over the kite-shaped sunshield. No external assets or licenses.
// Models are sized relative to `r` (the body's visualRadius).
// ---------------------------------------------------------------------------

function goldFoil(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xC9A050, metalness: 0.45, roughness: 0.5,
    emissive: new THREE.Color(0x8a6a24),
  });
}

function whiteThermal(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xE8E8E4, metalness: 0.05, roughness: 0.6,
    emissive: new THREE.Color(0x5a5a56),
  });
}

function darkMetal(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x3A3A40, metalness: 0.4, roughness: 0.55,
    emissive: new THREE.Color(0x26282e),
  });
}

function silverFoil(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xC8CCD8, metalness: 0.5, roughness: 0.35,
    emissive: new THREE.Color(0x565a68),
    side: THREE.DoubleSide,
  });
}

function goldMirror(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xFFD34D, metalness: 0.55, roughness: 0.2,
    emissive: new THREE.Color(0xa87c24),
  });
}

/** Shallow parabolic dish opening toward +Z. */
function dish(radius: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const bowl = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 10, 0, Math.PI * 2, 0, Math.PI * 0.32),
    mat
  );
  bowl.rotation.x = -Math.PI / 2; // opening toward +Z
  bowl.scale.z = 0.55;
  g.add(bowl);
  const feed = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.07, radius * 0.5, 8), darkMetal());
  feed.rotation.x = Math.PI / 2;
  feed.position.z = radius * 0.35;
  g.add(feed);
  return g;
}

function strut(from: THREE.Vector3, to: THREE.Vector3, thickness: number, mat: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(thickness, thickness, len, 6), mat);
  m.position.copy(from).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

function buildVoyager(r: number): THREE.Group {
  const g = new THREE.Group();
  // High-gain dish (the identity of the craft)
  g.add(dish(r * 1.35, whiteThermal()));
  // Decahedral bus behind the dish
  const bus = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.5, r * 0.5, r * 0.35, 10), goldFoil());
  bus.rotation.x = Math.PI / 2;
  bus.position.z = -r * 0.35;
  g.add(bus);
  // RTG boom with three stacked units
  const rtgEnd = new THREE.Vector3(r * 1.5, -r * 0.25, -r * 0.4);
  g.add(strut(new THREE.Vector3(r * 0.3, 0, -r * 0.35), rtgEnd, r * 0.03, darkMetal()));
  for (let i = 0; i < 3; i++) {
    const rtg = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.09, r * 0.09, r * 0.22, 8), darkMetal());
    rtg.position.copy(rtgEnd).add(new THREE.Vector3(-i * r * 0.24, 0, 0));
    rtg.rotation.z = Math.PI / 2;
    g.add(rtg);
  }
  // Long magnetometer boom the other way
  g.add(strut(new THREE.Vector3(-r * 0.3, 0, -r * 0.35), new THREE.Vector3(-r * 2.4, r * 0.15, -r * 0.5), r * 0.018, darkMetal()));
  // Science boom instrument cluster
  const sci = new THREE.Mesh(new THREE.BoxGeometry(r * 0.16, r * 0.16, r * 0.16), goldFoil());
  sci.position.set(-r * 2.4, r * 0.15, -r * 0.5);
  g.add(sci);
  return g;
}

function buildNewHorizons(r: number): THREE.Group {
  const g = new THREE.Group();
  // Triangular gold-wrapped bus
  const bus = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.75, r * 0.75, r * 0.4, 3), goldFoil());
  bus.rotation.x = Math.PI / 2;
  g.add(bus);
  // 2.1 m dish on top
  const d = dish(r * 0.95, whiteThermal());
  d.position.z = r * 0.35;
  g.add(d);
  // RTG stick
  const rtg = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.1, r * 0.1, r * 0.9, 8), darkMetal());
  rtg.position.set(r * 1.0, 0, -r * 0.1);
  rtg.rotation.z = Math.PI / 2;
  g.add(rtg);
  return g;
}

function buildParker(r: number): THREE.Group {
  const g = new THREE.Group();
  // The famous carbon heat shield (TPS) — always between craft and Sun
  const shield = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.1, r * 1.0, r * 0.16, 28), whiteThermal());
  shield.rotation.x = Math.PI / 2;
  shield.position.z = r * 0.55;
  g.add(shield);
  const shieldBack = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r * 0.85, r * 0.05, 28), darkMetal());
  shieldBack.rotation.x = Math.PI / 2;
  shieldBack.position.z = r * 0.44;
  g.add(shieldBack);
  // Hexagonal bus hiding in the umbra
  const bus = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.38, r * 0.38, r * 0.75, 6), goldFoil());
  bus.rotation.x = Math.PI / 2;
  bus.position.z = -r * 0.05;
  g.add(bus);
  // Retractable solar wings
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(r * 0.55, r * 0.02, r * 0.28),
      new THREE.MeshStandardMaterial({ color: 0x2A3B6E, metalness: 0.3, roughness: 0.45, emissive: new THREE.Color(0x182242) }));
    wing.position.set(side * r * 0.62, 0, -r * 0.15);
    wing.rotation.z = side * 0.25;
    g.add(wing);
  }
  return g;
}

function buildJWST(r: number): THREE.Group {
  const g = new THREE.Group();

  // Kite-shaped 5-layer sunshield
  const kite = new THREE.Shape();
  kite.moveTo(0, r * 1.55);
  kite.quadraticCurveTo(r * 0.95, r * 0.35, r * 1.05, 0);
  kite.quadraticCurveTo(r * 0.95, -r * 0.35, 0, -r * 1.55);
  kite.quadraticCurveTo(-r * 0.95, -r * 0.35, -r * 1.05, 0);
  kite.quadraticCurveTo(-r * 0.95, r * 0.35, 0, r * 1.55);
  const kiteGeo = new THREE.ShapeGeometry(kite);
  for (let i = 0; i < 5; i++) {
    const layer = new THREE.Mesh(kiteGeo, silverFoil());
    layer.rotation.x = -Math.PI / 2;
    layer.position.y = -r * 0.30 - i * r * 0.045;
    layer.scale.setScalar(1 - i * 0.03);
    g.add(layer);
  }

  // 18 gold hexagonal mirror segments: two rings around an open centre
  const mirror = new THREE.Group();
  const hexR = r * 0.17;
  const hexGeo = new THREE.CylinderGeometry(hexR, hexR, r * 0.03, 6);
  const positions: Array<[number, number]> = [];
  const s = hexR * Math.sqrt(3) * 1.02; // flat-to-flat spacing
  // Axial hex-grid rings 1 and 2 (center left open, like the real mirror)
  for (let q = -2; q <= 2; q++) {
    for (let rr = Math.max(-2, -q - 2); rr <= Math.min(2, -q + 2); rr++) {
      if (q === 0 && rr === 0) continue;
      const x = s * (q + rr / 2);
      const y = s * (Math.sqrt(3) / 2) * rr;
      positions.push([x, y]);
    }
  }
  for (const [x, y] of positions) {
    const seg = new THREE.Mesh(hexGeo, goldMirror());
    seg.rotation.x = Math.PI / 2;
    seg.rotation.y = Math.PI / 6;
    seg.position.set(x, y, 0);
    mirror.add(seg);
  }
  // Secondary-mirror tripod
  const tip = new THREE.Vector3(0, r * 0.1, r * 1.15);
  for (const [bx, by] of [[-0.7, -0.35], [0.7, -0.35], [0, 0.75]] as const) {
    mirror.add(strut(new THREE.Vector3(bx * r, by * r, 0), tip, r * 0.02, darkMetal()));
  }
  const secondary = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.09, r * 0.09, r * 0.05, 12), darkMetal());
  secondary.position.copy(tip);
  secondary.rotation.x = Math.PI / 2;
  mirror.add(secondary);

  mirror.position.y = r * 0.25;
  mirror.rotation.x = -0.35; // tilted up off the shield
  g.add(mirror);
  return g;
}

/**
 * Build the model for a spacecraft id. `r` is the body's visualRadius;
 * models span roughly 2–4 r so they read clearly at the marker scale.
 */
export function buildSpacecraftModel(id: string, r: number): THREE.Group {
  switch (id) {
    case 'voyager1':
    case 'voyager2':
      return buildVoyager(r);
    case 'newhorizons':
      return buildNewHorizons(r);
    case 'parker':
      return buildParker(r);
    case 'jwst':
      return buildJWST(r);
    default: {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(r, r, r * 1.4), goldFoil());
      g.add(body);
      g.add(dish(r * 0.8, whiteThermal()));
      return g;
    }
  }
}
