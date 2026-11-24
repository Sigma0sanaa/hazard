/* Rothermel (1972) surface fire spread with Albini's (1976) changes, as BehavePlus computes it (Andrews 2018,
 * RMRS-GTR-371): the reaction intensity, the propagating flux ratio, the heat sink, the wind and slope factors, and
 * Albini's live moisture of extinction. The 13 fuel models are those of Anderson (1982, INT-GTR-122), loads in lb/ft2,
 * surface-area-to-volume ratios in 1/ft, depth in ft (the values of the pyretechnics table, which follows Albini 1976).
 * The equations work in the US units they were fitted in; rates come out in metres per minute.
 *
 * Wind and slope are combined as vectors on the ground (as BehavePlus and FARSITE do); the shape of the fire is the
 * ellipse of Anderson (1983) with the length-to-breadth ratio used by BehavePlus, capped at 8. The 0.9 IR wind limit is
 * not applied (Andrews et al. 2013 found it too strict). */

const FT_PER_M = 3.28084;

/** Anderson 13 (only those the land cover maps to are used): delta ft, Mx dead fraction, loads lb/ft2 [1h, 10h, 100h,
 * live], SAV 1/ft [1h, 10h, 100h, live]. Heat content 8000 Btu/lb, particle density 32 lb/ft3, total mineral 0.0555,
 * effective mineral 0.010 for all. */
export const FUEL = {
  1: { name: "short grass", delta: 1.0, mx: 0.12, w: [0.034, 0, 0, 0], s: [3500, 109, 30, 1500] },
  2: { name: "timber (grass and understory)", delta: 1.0, mx: 0.15, w: [0.092, 0.046, 0.023, 0.023], s: [3000, 109, 30, 1500] },
  3: { name: "tall grass", delta: 2.5, mx: 0.25, w: [0.138, 0, 0, 0], s: [1500, 109, 30, 1500] },
  5: { name: "brush", delta: 2.0, mx: 0.20, w: [0.046, 0.023, 0, 0.092], s: [2000, 109, 30, 1500] },
  8: { name: "closed timber litter", delta: 0.2, mx: 0.30, w: [0.069, 0.046, 0.115, 0], s: [2000, 109, 30, 1500] },
  9: { name: "hardwood litter", delta: 0.2, mx: 0.25, w: [0.134, 0.019, 0.007, 0], s: [2500, 109, 30, 1500] },
  10: { name: "timber (litter and understory)", delta: 1.0, mx: 0.25, w: [0.138, 0.092, 0.230, 0.092], s: [2000, 109, 30, 1500] },
};
const H = 8000, RHO_P = 32, ST = 0.0555, SE = 0.010;

/** Fuel model from ESA WorldCover 2021 (0 = does not burn). Mongolian forest is mostly open larch with grass under
 * it, which is what model 2 describes; the dry steppe is short grass; shrub is brush; herbaceous wetland is tall
 * grass; cropland stubble is short grass. Bare and sparse ground, moss and lichen, built-up land, snow and water do
 * not burn. These are this page's choices, not a published Mongolian fuel map (none was found). */
export function fuelOf(cover) {
  switch (cover) {
    case 10: return 2;
    case 20: return 5;
    case 30: return 1;
    case 40: return 1;
    case 90: return 3;
    default: return 0;
  }
}

/** Equilibrium moisture content in % (Simard 1968, as used by NFDRS), temperature in deg C, humidity in %. */
export function emc(tempC, rh) {
  const T = tempC * 9 / 5 + 32, H2 = Math.min(100, Math.max(0, rh));
  if (H2 < 10) return 0.03229 + 0.281073 * H2 - 0.000578 * H2 * T;
  if (H2 < 50) return 2.22749 + 0.160107 * H2 - 0.01478 * T;
  return 21.0606 + 0.005565 * H2 * H2 - 0.00035 * H2 * T - 0.483199 * H2;
}

/** Dead fuel moisture (fractions) for 1-h, 10-h and 100-h fuels: 1-h = 1.03 EMC (NFDRS, Bradshaw et al. 1984);
 * the slower fuels are set 1 and 2 points wetter, a simple rule rather than their own time-lag model. Rain in the hour
 * (≥ 0.25 mm) wets the fine fuel to 30 %. */
export function deadMoisture(tempC, rh, rainMm = 0) {
  const m1 = rainMm >= 0.25 ? 0.30 : Math.max(0.02, 1.03 * emc(tempC, rh) / 100);
  return [m1, m1 + 0.01, m1 + 0.02];
}

/** Live fuel moisture (fraction) by month: green in June to August, cured or dormant otherwise (BehavePlus scenario
 * values; no live moisture is measured over Mongolia). */
export const liveMoisture = (month) => (month >= 6 && month <= 8 ? 1.2 : 0.9);

/** Everything that does not change with moisture, wind or slope: weights, packing, reaction velocity. */
export function prepare(n) {
  const f = FUEL[n];
  if (!f) return null;
  const A = f.w.map((w, j) => f.s[j] * w / RHO_P);
  const Ad = A[0] + A[1] + A[2], Al = A[3], AT = Ad + Al;
  const fij = [Ad ? A[0] / Ad : 0, Ad ? A[1] / Ad : 0, Ad ? A[2] / Ad : 0, Al ? 1 : 0];
  const fi = [Ad / AT, Al / AT];
  // g_ij: the weights of the net load summed over the size bins of BehavePlus (1h, 10h and 100h fall in bins 1, 3, 5)
  const sigDead = fij[0] * f.s[0] + fij[1] * f.s[1] + fij[2] * f.s[2], sigLive = Al ? f.s[3] : 0;
  const sigma = fi[0] * sigDead + fi[1] * sigLive;
  const beta = (f.w[0] + f.w[1] + f.w[2] + f.w[3]) / RHO_P / f.delta;
  const betaOp = 3.348 * Math.pow(sigma, -0.8189);
  const Aexp = 133 * Math.pow(sigma, -0.7913), B15 = Math.pow(sigma, 1.5);
  const gammaMax = B15 / (495 + 0.0594 * B15), C = beta / betaOp;
  const gamma = gammaMax * Math.pow(C, Aexp) * Math.exp(Aexp * (1 - C));
  const xi = Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (beta + 0.1)) / (192 + 0.2595 * sigma);
  const rhoB = (f.w[0] + f.w[1] + f.w[2] + f.w[3]) / f.delta;
  const Bw = 0.02526 * Math.pow(sigma, 0.54), Cw = 7.47 * Math.exp(-0.133 * Math.pow(sigma, 0.55)), Ew = 0.715 * Math.exp(-3.59e-4 * sigma);
  const etaS = 0.174 * Math.pow(SE, -0.19);
  const wn = f.w.map((w) => w * (1 - ST));
  const eps = f.s.map((s) => Math.exp(-138 / s));
  const deadLoadFactor = f.w[0] * Math.exp(-138 / f.s[0]) + f.w[1] * Math.exp(-138 / f.s[1]) + f.w[2] * Math.exp(-138 / f.s[2]);
  const liveLoadFactor = f.w[3] * Math.exp(-500 / f.s[3]);
  return { n, f, fij, fi, sigma, beta, betaOp, gamma, xi, rhoB, Bw, Cw, Ew, etaS, wn, eps, deadLoadFactor, liveLoadFactor,
    windK: Cw * Math.pow(beta / betaOp, -Ew), slopeK: 5.275 * Math.pow(beta, -0.3) };
}

const damp = (m, mx) => { if (!(mx > 0) || m >= mx) return 0; const r = Math.min(1, m / mx); return 1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r; };

/** Spread without wind and slope (ft/min) and the reaction intensity (Btu/ft2/min) for dead moisture [1h,10h,100h]
 * and live moisture (fractions). */
export function noWindNoSlope(p, dead, live) {
  const { f, fij, fi, wn, eps } = p;
  const mDead = fij[0] * dead[0] + fij[1] * dead[1] + fij[2] * dead[2];
  let mxLive = f.mx;
  if (p.liveLoadFactor > 0 && p.deadLoadFactor > 0) {
    const mf = (dead[0] * f.w[0] * Math.exp(-138 / f.s[0]) + dead[1] * f.w[1] * Math.exp(-138 / f.s[1]) + dead[2] * f.w[2] * Math.exp(-138 / f.s[2])) / p.deadLoadFactor;
    mxLive = Math.max(f.mx, 2.9 * (p.deadLoadFactor / p.liveLoadFactor) * (1 - mf / f.mx) - 0.226);
  }
  const etaMd = damp(mDead, f.mx), etaMl = f.w[3] ? damp(live, mxLive) : 0;
  // net load per category with the BehavePlus size bins: 1h, 10h and 100h fall in different bins, so g_ij = f_ij
  const WnD = fij[0] * wn[0] + fij[1] * wn[1] + fij[2] * wn[2], WnL = wn[3];
  const IR = p.gamma * (WnD * H * etaMd * p.etaS + WnL * H * etaMl * p.etaS);
  const qig = (m) => 250 + 1116 * m;
  const sinkD = fij[0] * eps[0] * qig(dead[0]) + fij[1] * eps[1] * qig(dead[1]) + fij[2] * eps[2] * qig(dead[2]);
  const sinkL = f.w[3] ? eps[3] * qig(live) : 0;
  const sink = p.rhoB * (fi[0] * sinkD + fi[1] * sinkL);
  const R0 = sink > 0 ? IR * p.xi / sink : 0;
  return { R0: Math.max(0, R0), IR: Math.max(0, IR) };
}

/** Wind factor for a midflame wind in ft/min, slope factor for tan(slope). */
export const phiW = (p, uFtMin) => (uFtMin > 0 ? p.windK * Math.pow(uFtMin, p.Bw) : 0);
export const phiS = (p, tanSlope) => p.slopeK * tanSlope * tanSlope;
/** The wind (ft/min) that alone would give the factor phi: the effective wind speed. */
export const effectiveWind = (p, phi) => (phi > 0 ? Math.pow(phi / p.windK, 1 / p.Bw) : 0);

/** Length-to-breadth ratio of BehavePlus for an effective wind in mi/h, capped at 8. */
export const lengthToBreadth = (mph) => Math.min(8, 0.936 * Math.exp(0.1147 * mph) + 0.461 * Math.exp(-0.0692 * mph) - 0.397);

/** Wind adjustment factor from 20-ft wind to midflame: unsheltered from the fuel depth (Andrews 2012, eq. 6), or
 * sheltered under a canopy of cover cc (0-1) and height hFt (eq. 2). */
export function waf(deltaFt, cc = 0, hFt = 0) {
  const fill = cc / 3;
  if (fill >= 0.05 && hFt >= 6) return 0.555 / (Math.sqrt(fill * hFt) * Math.log((20 + 0.36 * hFt) / (0.13 * hFt)));
  return deltaFt > 0 ? 1.83 / Math.log((20 + 0.36 * deltaFt) / (0.13 * deltaFt)) : 0;
}

/** Head fire of one cell: rate (m/min), direction it runs toward (radians, clockwise from north), eccentricity and
 * reaction intensity. wind10 is the 10 m wind (m/s) and windTo the direction it blows toward (radians from north);
 * tanSlope and upslope (radians from north) describe the ground. The 10 m wind is taken to 20 ft by dividing by 1.15. */
export function headFire(p, dead, live, wind10, windTo, tanSlope, upslope, wafValue) {
  const { R0, IR } = noWindNoSlope(p, dead, live);
  if (!(R0 > 0)) return { ros: 0, dir: 0, ecc: 0, IR: 0 };
  const mid = wind10 / 1.15 * wafValue * FT_PER_M * 60; // ft/min
  const pw = phiW(p, mid), ps = phiS(p, tanSlope);
  const x = pw * Math.sin(windTo) + ps * Math.sin(upslope), y = pw * Math.cos(windTo) + ps * Math.cos(upslope);
  const phi = Math.hypot(x, y);
  const ue = effectiveWind(p, phi) / 88; // ft/min to mi/h
  const lb = lengthToBreadth(ue);
  return { ros: R0 * (1 + phi) / FT_PER_M, dir: phi > 0 ? Math.atan2(x, y) : 0, ecc: lb > 1 ? Math.sqrt(lb * lb - 1) / lb : 0, IR };
}

/** Rate (m/min) toward a direction `theta` (radians from north) on the ellipse of the head fire: R (1-e)/(1-e cos). */
export const rateToward = (hf, theta) => (hf.ros > 0 ? hf.ros * (1 - hf.ecc) / (1 - hf.ecc * Math.cos(theta - hf.dir)) : 0);

/** Byram's fireline intensity (kW/m) and flame length (m) of the head fire: I = IR * R * t_r, t_r = 384/sigma min. */
export function intensity(p, hf) {
  const iB = hf.IR * (hf.ros * FT_PER_M) * (384 / p.sigma) / 60; // Btu/ft/s
  const kw = iB * 3.4613; // Btu/ft/s to kW/m
  return { kw, flame: 0.45 * Math.pow(iB, 0.46) * 0.3048 };
}
