import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { meaning, scoreModel, SCORE_MODEL } from "../js/meaning.js";
import { effectiveMethod, METHODS } from "../js/methods.js";
import { checkModelData } from "../scripts/check-model-data.mjs";

test("displayed probabilities and season come from the map's fitted model", () => {
  const models = { dust: { base: .01, method: { version: "dust-refit-v1", months: Array.from({ length: 12 }, (_, i) => i + 1) } } };
  assert.equal(meaning("dust", 40, 0, 11, models).p, .01);
  assert.equal(meaning("dust", 40, 0, 11, models).offSeason, false);
  assert.equal(meaning("dust", 40, 0, 11).offSeason, true);
  assert.equal(meaning("dust", 100, 10, 11, models).p, .64);
  assert.equal(meaning("dust", 100, 10, 11, { dust: { ...models.dust, base: .03 } }).p, 1);
  assert.equal(SCORE_MODEL.dust.base, .02235);
  assert.throws(() => scoreModel("dust", { dust: { base: -1 } }), /Invalid/);
});

test("methods switch only with a matching model tag and retain legacy text", () => {
  assert.equal(effectiveMethod("fire", "mn", {}), METHODS.fire.mn);
  const manifest = { score_models: { fire: { method: { version: "fire-refit-v1" } }, dust: { method: { version: "dust-refit-v1" } } }, verification: { dust: { auc: .712 } } };
  assert.match(effectiveMethod("fire", "mn", manifest).method[1], /SPI-1/);
  assert.match(effectiveMethod("fire", "en", manifest).limits[5], /25 years/);
  assert.match(effectiveMethod("dust", "en", manifest).limits[0], /0.712/);
  assert.match(METHODS.fire.en.limits[5], /standardised/);
});

test("publication rejects mixed model/data versions and accepts matching fingerprints", () => {
  const root = mkdtempSync(join(tmpdir(), "hazard-model-check-"));
  mkdirSync(join(root, "pipeline"));
  mkdirSync(join(root, "data", "gee"), { recursive: true });
  const model = { fire: { base: .001, method: { version: "fire-refit-v1" } }, dust: { base: .02 } };
  const hash = createHash("sha256");
  for (const name of ["model.json", "model_fire.npz", "model_flood.npz", "static_small.npz"]) {
    const data = name === "model.json" ? JSON.stringify(model) : `test-${name}`;
    writeFileSync(join(root, "pipeline", name), data);
    hash.update(name).update(data);
  }
  const manifestPath = join(root, "data", "gee", "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ model_id: "old" }));
  assert.throws(() => checkModelData(root), /do not match/);
  writeFileSync(manifestPath, JSON.stringify({ model_id: hash.digest("hex"), score_models: { fire: { base: .001 } } }));
  assert.equal(checkModelData(root), true);
});
