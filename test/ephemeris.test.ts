import { describe, it, expect } from 'vitest';
import { dateToJulianTDB } from '../src/data/horizonsEphemeris';
import { heliocentricStateAtJD } from '../src/data/realTimeOrbits';
import { AU } from '../src/utils/MathUtils';

const TDB_OFFSET = 69.184 / 86400;

describe('Julian date conversion', () => {
  it('maps the J2000 epoch correctly (the +12h regression)', () => {
    // 2000-01-01 12:00 UTC = JD 2451545.0 exactly (plus the TDB offset)
    const jd = dateToJulianTDB(new Date(Date.UTC(2000, 0, 1, 12, 0, 0)));
    expect(jd).toBeCloseTo(2451545.0 + TDB_OFFSET, 6);
  });

  it('maps midnight to a half-day JD', () => {
    const jd = dateToJulianTDB(new Date(Date.UTC(2024, 0, 1, 0, 0, 0)));
    expect(jd).toBeCloseTo(2460310.5 + TDB_OFFSET, 6);
  });
});

describe('Keplerian fallback ephemeris', () => {
  it('places Earth near 1 AU with ~29.8 km/s heliocentric speed', () => {
    const s = heliocentricStateAtJD('earth', 2460310.5)!;
    expect(s.position.length() / AU).toBeGreaterThan(0.97);
    expect(s.position.length() / AU).toBeLessThan(1.02);
    expect(s.velocity.length()).toBeGreaterThan(28_000);
    expect(s.velocity.length()).toBeLessThan(31_000);
  });

  it('keeps Earth in the ecliptic plane (sim Y ≈ 0)', () => {
    const s = heliocentricStateAtJD('earth', 2461000)!;
    expect(Math.abs(s.position.y) / AU).toBeLessThan(0.001);
  });

  it('puts Mars ~1.52 AU out on average', () => {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += heliocentricStateAtJD('mars', 2460000 + i * 60)!.position.length();
    }
    expect(sum / 12 / AU).toBeGreaterThan(1.36);
    expect(sum / 12 / AU).toBeLessThan(1.68);
  });
});
