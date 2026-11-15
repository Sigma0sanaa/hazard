/* Scores read back in words (js/meaning.js) against the formulas of pipeline/calibrate.py and pipeline/scores.py.
 * check() is plain JavaScript so it also runs in a browser where Node is not installed. */
import { floodYears, lift, meaning, percent, times } from "../js/meaning.js";

export function check() {
  const out = [];
  const yes = (name, cond) => out.push({ name, got: cond, want: true, ok: cond === true });
  const near = (name, got, want, tol) => out.push({ name, got, want, ok: Math.abs(got - want) <= tol });

  near("40 points is the average chance", lift(40), 1, 1e-12);
  near("every 20 points is 4 times", lift(60) / lift(40), 4, 1e-9);
  near("score 0 is 1/16 of the average", lift(0), 1 / 16, 1e-12);
  const d = meaning("dust", 51, 28, 11);
  near("dust 51 points is about 4.8 %", d.p, 0.0479, 0.0005);
  yes("dust 51 ± 28 spans 0.7 % to 33 %", percent(d.pLo) === "0.7%" && percent(d.pHi) === "33%");
  yes("dust in November is out of season", d.offSeason === true && meaning("dust", 51, 28, 4).offSeason === false);
  yes("fire has no season limit", meaning("fire", 62, 10, 11).offSeason === false);
  near("flood 40 points is once in 2 years", floodYears(40), 2, 1e-9);
  near("flood 80 points is once in 20 years", floodYears(80), 20, 1e-9);
  near("flood 70 points lies between 5 and 20 years", floodYears(70), 10, 1e-9);
  yes("flood beyond twice the 25-year record is not put in years", meaning("flood", 95, 3, 7).beyond === true && meaning("flood", 80, 3, 7).beyond === false);
  yes("a score at 0 only bounds the chance from above", meaning("fire", 0, 10, 1).floor === true && meaning("fire", 12, 10, 1).floor === false && meaning("fire", 5, 10, 1).floorLo === true);
  yes("a score at 100 only bounds the chance from below", meaning("dust", 100, 5, 4).ceiling === true && meaning("dust", 97, 5, 4).ceilingHi === true);
  yes("all hazards has no single meaning", meaning("all", 50, 10, 5).kind === "all");
  yes("ratios read as people say them", times(2.14) === "2.1" && times(15.2) === "15" && times(1) === "1");
  return out;
}

if (typeof process !== "undefined" && process.versions?.node) {
  const { default: test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  test("score meaning", () => assert.deepEqual(check().filter((r) => !r.ok), []));
}
