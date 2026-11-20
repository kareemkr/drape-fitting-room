import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const worker = new URL("public/drape-pose-cache.js", root);
const startup = new URL("lib/fitting/pose-asset-cache.js", root);
const source = await readFile(worker, "utf8");
const boot = await readFile(startup, "utf8");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pattern = /\[\s*"(\/pose-(?:cpu|assets)\/[^"]+)"\s*,\s*"([0-9a-f]{64})"\s*,?\s*\]/g;
const matches = [...source.matchAll(pattern)];
if (!matches.length) throw new Error("Model cache allowlist is empty.");

let next = source;
const manifest = [];
for (const [entry, path, oldDigest] of matches) {
  const bytes = await readFile(new URL("public" + path, root));
  const hash = digest(bytes);
  next = next.replace(entry, entry.replace(oldDigest, hash));
  manifest.push(path + " " + hash);
}
const version = digest(manifest.sort().join("\n")).slice(0, 12);
next = next.replace(/(cacheName = cachePrefix \+ ")[a-f0-9]{12}(")/, (_, prefix, suffix) => prefix + version + suffix);
const nextBoot = boot.replace(/(drape-pose-cache\.js\?version=)[a-f0-9]{12}/, (_, prefix) => prefix + version);
if (process.argv.includes("--write")) {
  await writeFile(worker, next);
  await writeFile(startup, nextBoot);
} else if (next !== source || nextBoot !== boot) {
  throw new Error("Model bytes changed. Run this script with --write to refresh their cache keys.");
}
console.log("Verified " + matches.length + " model assets, version " + version);
