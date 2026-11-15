/* Fail publication if new coefficients are paired with history from another fit. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkModelData(root = ".") {
  const read = (p) => readFileSync(resolve(root, p));
  const model = JSON.parse(read("pipeline/model.json"));
  const manifest = JSON.parse(read("data/gee/manifest.json"));
  const hash = createHash("sha256");
  for (const name of ["model.json", "model_fire.npz", "model_flood.npz", "static_small.npz"]) {
    hash.update(name);
    hash.update(read(`pipeline/${name}`));
  }
  const refit = ["fire", "dust"].some((h) => model[h]?.method?.version?.includes("refit"));
  if ((refit || manifest.model_id) && manifest.model_id !== hash.digest("hex")) {
    throw new Error("Model and map history do not match. Publish the complete rebuilt history first.");
  }
  for (const h of ["fire", "dust"]) {
    if (manifest.score_models?.[h] && manifest.score_models[h].base !== model[h].base) {
      throw new Error(`${h}: displayed base rate differs from model coefficients`);
    }
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkModelData(process.argv[2]);
  console.log("Model parameters and map history are consistent.");
}
