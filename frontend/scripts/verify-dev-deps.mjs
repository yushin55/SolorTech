// Check the exact dependency URLs returned to a browser, including lazy Leaflet.
// Usage: node scripts/verify-dev-deps.mjs [http://127.0.0.1:5174] [--with-tests]
// --with-tests also proves Vitest leaves those active dev-server URLs intact.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const base = new URL(process.argv.find((arg) => /^https?:/.test(arg)) || "http://127.0.0.1:5174");
const frontend = fileURLToPath(new URL("../", import.meta.url));

async function read(url, javascript = true) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: "no-store" });
  assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
  if (javascript) {
    assert.match(response.headers.get("content-type") || "", /(?:java|ecma)script/i, `${url}: expected JavaScript`);
  }
  return response.text();
}

function optimizedImports(source, importer) {
  const matches = source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(["'])([^"']+)\1/g);
  return [...matches].map((match) => new URL(match[2], importer))
    .filter((url) => url.origin === base.origin && url.pathname.includes("/node_modules/") && url.pathname.endsWith(".js"))
    .map(String);
}

await read(new URL("/", base), false);
const urls = new Set();
for (const path of ["/src/main.tsx", "/src/App.tsx", "/src/MapView.tsx"]) {
  const url = new URL(path, base);
  const source = await read(url);
  const dependencies = optimizedImports(source, url);
  if (path.endsWith("MapView.tsx")) {
    assert(dependencies.some((dependency) => new URL(dependency).pathname.endsWith("/leaflet.js")), "MapView must load optimized Leaflet");
  }
  for (const dependency of dependencies) urls.add(dependency);
}

const hashes = new Map();
// Set iteration includes chunks discovered while traversing earlier imports.
for (const url of urls) {
  const source = await read(url);
  hashes.set(url, createHash("sha256").update(source).digest("hex"));
  for (const dependency of optimizedImports(source, url)) urls.add(dependency);
}

if (process.argv.includes("--with-tests")) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url)), "run"], {
      cwd: frontend,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Vitest exited with ${code}`)));
  });
  for (const [url, hash] of hashes) {
    const source = await read(url);
    assert.equal(createHash("sha256").update(source).digest("hex"), hash, `${url}: active dependency changed during tests`);
  }
}

console.log(`PASS: homepage, lazy MapView and ${hashes.size} optimized dependency URLs${process.argv.includes("--with-tests") ? " remain available after Vitest" : " return HTTP 200"}.`);
