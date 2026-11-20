// GTA VI trophy rarity forecaster (make.fun gta6-trophy-rarity-forecast-01).
//
// Idea, in one paragraph: an Exophase earn rate is a ratio, earners over
// players-tracked, and Exophase refreshes both counts on its own schedule,
// not continuously. So a rate moves for two separate reasons: players learn
// the game (earners grow along an adoption curve) and the tracked-player
// base jumps at a refresh (dilution: the same earners over more players).
// This program therefore forecasts the numerator and the denominator
// separately and combines them, instead of extrapolating the ratio alone:
//   1. players-tracked P(t): log-log power law in hours since release;
//   2. earners E_i(t) per trophy: log-log power law in hours since release;
//   3. logit(rate_i) trend: least squares on ln(1 + hours since release),
//      with each trophy's slope shrunk toward its tier's median slope;
//   4. a tier prior for the flat-history case (launch night, no refresh seen
//      yet): rare tiers dilute faster than common ones when the base jumps.
// The median is a logit-space ensemble of (2)+(3)+(4); the spread widens
// with horizon, with model disagreement, with fit residuals, and with an
// extra refresh-jump allowance when history has never shown a refresh.
//
// Node 22 standard library only, no network, deterministic (no randomness,
// no clock reads inside the forecast itself).

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const RELEASE_MS = Date.parse("2026-11-19T00:00:00Z");

// How fast a trophy's rate dilutes when the tracked base jumps, by tier:
// platinum holders are the few who finished everything, bronze story
// trophies keep being earned by every fresh cohort. Used as the prior
// component and as the whole forecast when history is flat.
const TIER_DILUTION: Record<string, number> = {
  platinum: 0.9,
  gold: 0.7,
  silver: 0.55,
  bronze: 0.45,
};

// Fallback median rate (percent) when a case carries no usable history.
const TIER_FALLBACK: Record<string, number> = {
  platinum: 0.5,
  gold: 1.0,
  silver: 2.0,
  bronze: 5.0,
};

type TrophyIn = { id: number; name: string; tier: string; points: number; secret: boolean };
type ReadIn = { slot: string; at: string; players_tracked: number; trophies_earned: number; rates: (number | null)[] };
type CaseIn = {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { release_date?: string };
  trophies: TrophyIn[];
  history: ReadIn[];
};

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function logit(pct: number): number {
  const p = clamp(pct, 0.01, 99.99) / 100;
  return Math.log(p / (1 - p));
}

function invLogit(l: number): number {
  const v = 1 / (1 + Math.exp(-clamp(l, -12, 12)));
  return clamp(v * 100, 0.01, 99.99);
}

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function meanOf(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

function sdOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

// Ordinary least squares y ~ a + b*x. Returns null when x has no spread.
function ols(xs: number[], ys: number[]): { a: number; b: number } | null {
  if (xs.length < 2) return null;
  const mx = meanOf(xs);
  const my = meanOf(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx < 1e-12) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

// Hours since the release instant, from an ISO timestamp.
function hoursSinceRelease(iso: string, releaseMs: number): number {
  return Math.max(0, (Date.parse(iso) - releaseMs) / 3600000);
}

// Collapse consecutive identical reads into one refresh state each: between
// refreshes Exophase repeats the same page, so flat reads carry no trend
// information and would overweight the launch-night plateau in a fit.
function distinctStates(history: ReadIn[]): ReadIn[] {
  const out: ReadIn[] = [];
  for (const r of history) {
    const prev = out[out.length - 1];
    if (prev && prev.players_tracked === r.players_tracked) {
      const same = prev.rates.every((v, i) => v === r.rates[i]);
      // Same page repeated: one refresh state, dated at its latest read,
      // so `last` is the freshest read and the horizon is measured right.
      if (same) {
        prev.at = r.at;
        prev.slot = r.slot;
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

// Forecast one case. Returns the rows in trophy-id order.
function forecastCase(c: CaseIn): { id: number; q: number[] }[] {
  const releaseMs = c.game && c.game.release_date
    ? Date.parse(c.game.release_date + "T00:00:00Z")
    : RELEASE_MS;
  const t0 = Number.isFinite(releaseMs) ? releaseMs : RELEASE_MS;
  const horizonDays = Math.max(0, (c.horizon_minutes || 0) / 1440);
  const states = distinctStates(c.history || []);
  const last = states.length ? states[states.length - 1] : (c.history || [])[(c.history || []).length - 1];
  const xOf = (iso: string): number => Math.log(1 + hoursSinceRelease(iso, t0));
  const xTarget = xOf(c.target);
  const n = states.length;

  // --- players-tracked model: ln P ~ a + b * ln(1 + hours since release).
  // With < 2 distinct states there is nothing to fit, so fall back to a
  // launch-phase power law (gamma 1.1): the tracked base grows fast early.
  let playersTarget = last ? last.players_tracked : 1000;
  if (last) {
    const xs = states.map((s) => xOf(s.at));
    const fitP = ols(xs, states.map((s) => Math.log(Math.max(1, s.players_tracked))));
    if (fitP) {
      const slope = clamp(fitP.b, 0, 2.5);
      playersTarget = Math.exp(fitP.a + slope * xTarget);
    } else {
      // No refresh ever seen: the tracked base is stale. Launch night's
      // only observed refresh took tracked players 638 -> 3868 over
      // ~4.7 h, about +1.08x per hour while unrefreshed; assume the base
      // catches up at that pace over the horizon, capped at one such jump.
      const horizonHours = Math.max(0, (c.horizon_minutes || 0) / 60);
      playersTarget = last.players_tracked * Math.min(6.06, 1 + 1.08 * horizonHours);
    }
    playersTarget = clamp(playersTarget, last.players_tracked, last.players_tracked * 10);
  }

  // --- per-trophy logit trends, for tier shrinkage of slopes.
  const trendFits: { b: number; residSd: number }[] = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const pts: { x: number; y: number }[] = [];
    for (const s of states) {
      const r = s.rates[i];
      if (r !== null && r !== undefined) pts.push({ x: xOf(s.at), y: logit(r) });
    }
    let fit: { b: number; residSd: number } | null = null;
    if (pts.length >= 3) {
      const f = ols(pts.map((p) => p.x), pts.map((p) => p.y));
      if (f) {
        const resid = pts.map((p) => p.y - (f.a + f.b * p.x));
        fit = { b: clamp(f.b, -3, 3), residSd: sdOf(resid) };
      }
    }
    trendFits.push(fit || { b: 0, residSd: 0 });
  }
  const tierSlope = (tier: string): number => {
    const bs: number[] = [];
    c.trophies.forEach((t, i) => {
      if (t.tier === tier && trendFits[i].b !== 0) bs.push(trendFits[i].b);
    });
    return bs.length ? medianOf(bs) : 0;
  };

  const rows: { id: number; q: number[] }[] = [];
  for (let i = 0; i < c.trophies.length; i++) {
    const tr = c.trophies[i];
    const lastRate = last && last.rates[i] != null ? (last.rates[i] as number) : null;

    // A trophy every tracked player holds: it survived a 6x base jump at
    // 100% on launch night, so keep the forecast pinned near 100 with a
    // modest logit spread instead of extrapolating it down.
    if (lastRate !== null && lastRate >= 99.99) {
      const q = Z.map((z) => Math.round(invLogit(8.5 + z * 1.1) * 10000) / 10000);
      rows.push({ id: tr.id, q });
      continue;
    }

    const delta = TIER_DILUTION[tr.tier] ?? 0.5;
    const growth = (1 + hoursSinceRelease(c.target, t0)) / Math.max(1, 1 + (last ? hoursSinceRelease(last.at, t0) : 0));
    // Component 1: tier prior — rate diluted by the growing base.
    const priorRate = lastRate !== null
      ? lastRate * Math.pow(growth, -delta)
      : TIER_FALLBACK[tr.tier] ?? 2.0;

    // Component 2: logit trend, slope shrunk toward the tier median.
    let trendRate = priorRate;
    let residSd = 0.25;
    if (n >= 3 && lastRate !== null) {
      const pts: { x: number; y: number }[] = [];
      for (const s of states) {
        const r = s.rates[i];
        if (r !== null && r !== undefined) pts.push({ x: xOf(s.at), y: logit(r) });
      }
      const f = ols(pts.map((p) => p.x), pts.map((p) => p.y));
      if (f) {
        const shrunk = (pts.length * clamp(f.b, -3, 3) + 4 * tierSlope(tr.tier)) / (pts.length + 4);
        const a = meanOf(pts.map((p) => p.y)) - shrunk * meanOf(pts.map((p) => p.x));
        trendRate = invLogit(a + shrunk * xTarget);
        residSd = Math.min(0.5, trendFits[i].residSd);
      }
    }

    // Component 3: earners-over-players — power-law earners over the
    // modelled tracked base. With flat history earners are frozen and the
    // whole move is the refresh dilution of the growing denominator.
    let earnRate = priorRate;
    if (last && lastRate !== null) {
      const ePts: { x: number; y: number }[] = [];
      for (const s of states) {
        const r = s.rates[i];
        if (r !== null && r !== undefined) {
          ePts.push({ x: xOf(s.at), y: Math.log((r / 100) * Math.max(1, s.players_tracked) + 0.5) });
        }
      }
      const fE = ePts.length >= 3 ? ols(ePts.map((p) => p.x), ePts.map((p) => p.y)) : null;
      if (fE) {
        const eTarget = Math.exp(fE.a + clamp(fE.b, -1, 4) * xTarget);
        earnRate = clamp((100 * eTarget) / playersTarget, 0.01, 99.99);
      } else {
        const eLast = (lastRate / 100) * Math.max(1, last.players_tracked);
        earnRate = clamp((100 * eLast) / playersTarget, 0.01, 99.99);
      }
    }

    // Ensemble in logit space: trend + earners + prior.
    const w = n >= 3 ? [0.4, 0.4, 0.2] : [0.1, 0.7, 0.2];
    const logits = [logit(trendRate), logit(earnRate), logit(priorRate)];
    const medLogit = w[0] * logits[0] + w[1] * logits[1] + w[2] * logits[2];

    // Spread: random-walk growth with horizon + model disagreement +
    // fit residual + a refresh-jump allowance while no refresh was seen.
    const disagree = (Math.max(...logits) - Math.min(...logits)) * 0.5;
    let spread = 0.3 + 0.45 * Math.sqrt(horizonDays) + disagree + residSd;
    if (n < 3) spread += 0.45;
    // Practice-proxy check: the raw sum is wider than the pinball loss
    // rewards — a 0.75x scale scored best on both refresh scenarios
    // (frozen earners and average dilution) while keeping ~98% coverage.
    spread = clamp(spread * 0.75, 0.35, 1.6);

    const q = Z.map((z) => Math.round(invLogit(medLogit + z * spread) * 10000) / 10000);
    // Enforce non-decreasing after rounding.
    for (let k = 1; k < q.length; k++) q[k] = Math.max(q[k], q[k - 1]);
    rows.push({ id: tr.id, q });
  }
  return rows;
}

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  mkdirSync(outDir, { recursive: true });
  // Clear only stale forecast files inside the output dir, never the dir.
  for (const f of readdirSync(outDir)) {
    if (f.endsWith(".out")) rmSync(join(outDir, f));
  }
  const files = readdirSync(inDir).filter((f) => f.endsWith(".in")).sort();
  for (const f of files) {
    const c = JSON.parse(readFileSync(join(inDir, f), "utf8")) as CaseIn;
    const rows = forecastCase(c);
    const out = { trophies: rows };
    writeFileSync(join(outDir, c.id + ".out"), JSON.stringify(out), "utf8");
  }
}

main();
