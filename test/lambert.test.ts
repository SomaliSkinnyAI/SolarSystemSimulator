import { describe, it, expect } from 'vitest';
import { solveLambert } from '../src/utils/Lambert';
import { G_REAL, SOLAR_MASS, AU } from '../src/utils/MathUtils';

const MU_SUN = G_REAL * SOLAR_MASS;

describe('universal-variable Lambert solver', () => {
  it('approaches the Hohmann solution for a near-180° transfer', () => {
    const r1 = AU;
    const r2 = 1.524 * AU; // Mars
    const aT = (r1 + r2) / 2;
    const tofHohmann = Math.PI * Math.sqrt(aT ** 3 / MU_SUN);

    // 175° transfer at the Hohmann TOF: departure Δv should be within a few
    // percent of the ideal Hohmann injection Δv
    const nu = (175 * Math.PI) / 180;
    const sol = solveLambert(
      { x: r1, y: 0, z: 0 },
      { x: r2 * Math.cos(nu), y: r2 * Math.sin(nu), z: 0 },
      tofHohmann, MU_SUN
    );
    expect(sol).not.toBeNull();

    const vCirc = Math.sqrt(MU_SUN / r1);
    const vHohmann = Math.sqrt(MU_SUN * (2 / r1 - 1 / aT));
    const dvHohmann = vHohmann - vCirc;
    const dvDep = Math.hypot(sol!.v1.x - 0, sol!.v1.y - vCirc, sol!.v1.z - 0);
    expect(Math.abs(dvDep - dvHohmann) / dvHohmann).toBeLessThan(0.15);
  });

  it('is time-symmetric: reversing the endpoints negates the velocities', () => {
    const r1 = { x: AU, y: 0, z: 0.02 * AU };
    const r2 = { x: -0.3 * AU, y: 1.3 * AU, z: -0.01 * AU };
    const tof = 200 * 86400;
    // The time-reversed path spans the same |Δν| < 180°, so the back-solve
    // uses the SAME short-way branch — and must return the same conic.
    const fwd = solveLambert(r1, r2, tof, MU_SUN, false);
    const back = solveLambert(r2, r1, tof, MU_SUN, false);
    expect(fwd).not.toBeNull();
    expect(back).not.toBeNull();
    // Flying the path backwards: v1_back = −v2_fwd, v2_back = −v1_fwd
    expect(back!.v1.x).toBeCloseTo(-fwd!.v2.x, 2);
    expect(back!.v1.y).toBeCloseTo(-fwd!.v2.y, 2);
    expect(back!.v2.x).toBeCloseTo(-fwd!.v1.x, 2);
  });

  it('conserves orbital energy along the transfer', () => {
    const r1 = { x: AU, y: 0, z: 0 };
    const r2 = { x: 0, y: 1.6 * AU, z: 0 };
    const tof = 250 * 86400;
    const sol = solveLambert(r1, r2, tof, MU_SUN);
    expect(sol).not.toBeNull();
    const e1 = (sol!.v1.x ** 2 + sol!.v1.y ** 2 + sol!.v1.z ** 2) / 2 - MU_SUN / AU;
    const e2 = (sol!.v2.x ** 2 + sol!.v2.y ** 2 + sol!.v2.z ** 2) / 2 - MU_SUN / (1.6 * AU);
    expect(Math.abs((e1 - e2) / e1)).toBeLessThan(1e-6);
  });
});
