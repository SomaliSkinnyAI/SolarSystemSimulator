# Solar System Simulator

A real-time, interactive 3D solar system simulator built with Three.js and TypeScript. Features N-body gravitational physics, real planet textures, orbital mechanics, and a real-time mode that can initialize bodies from cached NASA/JPL Horizons state vectors.

## Features

- **N-Body Physics** -- Full gravitational simulation with RK4 (Runge-Kutta 4th order) and Velocity Verlet integrators. All 23 bodies interact gravitationally.
- **23 Celestial Bodies** -- Sun, 8 planets, Pluto, Halley's Comet, Earth's Moon, 4 Galilean moons (Io, Europa, Ganymede, Callisto), and 7 Saturn moons (Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus).
- **Real Planet Textures** -- High-resolution texture maps for all planets and major moons sourced from NASA, USGS, and Solar System Scope.
- **Horizons Real-Time Mode** -- Positions planets, major moons, Pluto, and Halley's Comet from a browser-loaded NASA/JPL Horizons vector cache for 2024-2028, with Hermite interpolation between samples. Dates outside the cache fall back to JPL approximate Keplerian elements.
- **Ephemeris Cache Tooling** -- `npm run generate-ephemeris` regenerates the Horizons vector cache from the public JPL API.
- **Earth Day/Night Cycle** -- Custom GLSL shader blends day and night textures based on Sun direction, with city lights visible on the dark side.
- **Realistic Rotation** -- All bodies rotate at their real sidereal periods. Axial tilts are applied (Earth at 23.44 degrees, Saturn at 26.73 degrees, Uranus at 97.77 degrees, etc.).
- **Saturn's Rings** -- Textured ring system with correct UV mapping, tilted with the planet.
- **Planetary Atmospheres** -- Subtle atmospheric glow on Earth, Venus, Mars, Jupiter, Saturn, Uranus, Neptune, and Titan.
- **Orbit Visualization** -- Predicted orbital paths drawn as rings, with moon orbits attached to parent planets.
- **Interactive UI** -- Tweakpane-based control panel with tabs for simulation, camera, body selection, visuals, and info.
- **God Mode** -- Click to spawn new bodies with custom mass, radius, and velocity. Drag to set initial velocity direction.
- **Body Selection** -- Click any planet to select it and view its data card (mass, radius, velocity, distance from Sun, orbital period, escape velocity).
- **Focus Camera** -- Double-click a planet label to lock the camera onto it.
- **Log Scale View** -- Toggle between linear and logarithmic scale to see the entire solar system or zoom into inner planets.
- **Bloom Post-Processing** -- UnrealBloomPass makes the Sun glow realistically.
- **Asteroid Belt** -- Instanced mesh rendering of a denser, inclined, color-varied asteroid belt between Mars and Jupiter.
- **Live Event Scan** -- Overlay with closest major-body pair, tightest sun-centric alignment, fastest major orbit, and most eccentric bound orbit.
- **Transfer Planning Estimates** -- Selected planet data cards include rough Earth-to-target Hohmann transfer delta-v, flight time, and phase-angle information.
- **Collision Detection** -- Bodies merge on collision, conserving momentum.
- **Trail Rendering** -- Distance-based trail sampling that works correctly at any time scale.

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Installation

```bash
# Clone the repository
git clone https://github.com/SomaliSkinnyAI/SolarSystemSimulator.git
cd SolarSystemSimulator

# Install dependencies
npm install

# Download planet textures (NASA/USGS/Solar System Scope -- public domain)
npm run download-textures

# Optional: refresh the 2024-2028 NASA/JPL Horizons vector cache
npm run generate-ephemeris

# Start the dev server
npm run dev
```

Open `http://localhost:5173` in your browser.

### Build for Production

```bash
npm run build
npm run preview
```

## Controls

| Input | Action |
|-------|--------|
| Left-click drag | Rotate camera |
| Scroll wheel | Zoom in/out |
| Right-click drag | Pan camera |
| Click planet label | Select body, show data card |
| Double-click label | Lock camera to body |
| G | Toggle God Mode |
| God Mode click | Spawn new body |
| God Mode drag | Set spawn velocity |

## UI Panel

- **Sim** -- Pause/resume, time scale (1x to 1,000,000x), gravity mode, integrator selection, reset, real-time toggle, God Mode
- **Camera** -- Focus mode, reset camera
- **Body** -- Select body from dropdown, delete bodies
- **Visual** -- Trails, bloom, asteroid belt, solar wind, Lagrange points, gravity field, atmospheres, log scale
- **Info** -- FPS, body count, simulation time, simulation date (in real-time mode)

## Architecture

```
src/
  main.ts                  # Animation loop, event wiring
  types.ts                 # Shared TypeScript interfaces
  data/
    solarSystemData.ts     # Initial body states (positions, velocities, masses)
    realTimeOrbits.ts      # JPL Keplerian fallback elements, Kepler equation solver
    horizonsEphemeris.ts   # Cached Horizons vector interpolation
  physics/
    CelestialBody.ts       # Body class (mesh + physics state + rotation)
    PhysicsEngine.ts       # N-body integrator (RK4/Euler), collision detection
  rendering/
    SceneManager.ts        # Three.js scene, camera, postprocessing, orbit rings, labels
    TrailRenderer.ts       # GPU-efficient trail lines
    StarField.ts           # Background star particles
  ui/
    BodySelector.ts        # Raycasting, selection ring, God Mode spawning
    UIManager.ts           # Tweakpane control panel
  utils/
    CoordinateSystem.ts    # Physics-to-scene coordinate mapping, log scale
    EventPredictor.ts      # Live orbital event diagnostics
    TransferPlanner.ts     # Hohmann transfer estimates
    MathUtils.ts           # Gravitational constants, formatting
```

## Tech Stack

- **Three.js** r167 -- 3D rendering, post-processing (UnrealBloomPass), CSS2DRenderer for labels
- **TypeScript** -- Strict mode with `noUncheckedIndexedAccess`
- **Vite** -- Dev server and bundler
- **Tweakpane** v4 -- UI controls

## Texture Sources

Planet textures are downloaded via `npm run download-textures` from:

- [Solar System Scope](https://www.solarsystemscope.com/textures/) -- Sun, Mercury, Venus, Earth, Moon, Mars, Jupiter, Saturn, Uranus, Neptune (CC BY 4.0)
- [Planet Pixel Emporium](https://planetpixelemporium.com/) -- Pluto
- [USGS Astrogeology](https://astrogeology.usgs.gov/) -- Io, Ganymede, Callisto, Titan (public domain)
- [Steve Albers](https://stevealbers.net/albers/sos/sos.html) -- Europa 4K (Voyager/Galileo/Juno composite)

## License

MIT
