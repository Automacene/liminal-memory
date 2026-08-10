/**
 * Pack the package, install the tarball into a throwaway project, and use it every way a
 * consumer can. Run this before publishing.
 *
 *   npm run verify:pack
 *
 * The point is to catch the mistakes that only show up after install and cannot be seen from
 * inside the repo: a missing file in the `files` allowlist, an `exports` map that sends Node
 * somewhere that does not exist, declarations that do not resolve from the package name. Tests
 * passing in the repo says nothing about any of that, because in the repo everything is a
 * relative path.
 *
 * This installs the exact tarball `npm publish` would upload, so a pass here means the published
 * version will import.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "liminal-verify-"));
const results = [];

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`  ok    ${name}`);
    if (detail) console.log(`          ${detail}`);
  } catch (error) {
    const message = (error.stdout || "") + (error.stderr || "") || error.message;
    results.push({ name, ok: false, detail: message.trim() });
    console.log(`  FAIL  ${name}`);
    console.log(message.trim().split("\n").map(l => `          ${l}`).join("\n"));
  }
}

console.log(`\nverifying the packed package\n${"-".repeat(60)}`);

// Build first, because dist is not committed and the tarball is nothing without it.
console.log("  building...");
run("npm", ["run", "build"], repo);

console.log("  packing...");
run("npm", ["pack", "--pack-destination", scratch], repo);
const tarball = readdirSync(scratch).find(f => f.endsWith(".tgz"));
console.log(`  packed  ${tarball}`);

const project = join(scratch, "consumer");
run("mkdir", ["-p", project]);
writeFileSync(join(project, "package.json"), JSON.stringify({
  name: "consumer", version: "1.0.0", type: "module", private: true
}, null, 2));

console.log("  installing the tarball into a throwaway project...\n");
run("npm", ["install", join(scratch, tarball), "--silent", "--no-audit", "--no-fund"], project);

const write = (name, body) => writeFileSync(join(project, name), body);

write("esm.mjs", `
import { LiminalMemory, BM25, keywordTagger, decayGraph, defaults } from "@automacene/liminal-memory";
const mem = new LiminalMemory();
await mem.create({ id: "a", content: "the quarterly revenue report" });
await mem.create({ id: "b", content: "lunch with sam" });
const hits = await mem.rank("quarterly report", { minScore: 0.3 });
if (hits.length !== 1 || hits[0].node.id !== "a") throw new Error("wrong hits: " + JSON.stringify(hits.map(h => h.node.id)));
if (!(hits[0].score > 0 && hits[0].score < 1)) throw new Error("score out of range: " + hits[0].score);
if (typeof hits[0].raw !== "number") throw new Error("raw missing");
if (typeof defaults.bm25.inflection !== "number") throw new Error("defaults missing");
process.stdout.write(\`\${hits[0].node.id} scored \${hits[0].score.toFixed(2)}, raw \${hits[0].raw.toFixed(2)}\`);
`);

write("cjs.cjs", `
const { LiminalMemory, BM25 } = require("@automacene/liminal-memory");
(async () => {
  const mem = new LiminalMemory({ engine: () => new BM25({ calibrated: false }) });
  await mem.create({ id: "a", content: "the quarterly revenue report" });
  const [hit] = await mem.rank("quarterly report");
  if (hit.score !== hit.raw) throw new Error("calibrated:false should make score equal raw");
  process.stdout.write(\`require() works, uncalibrated score \${hit.score.toFixed(3)}\`);
})().catch(e => { console.error(e.message); process.exit(1); });
`);

write("iife.cjs", `
const fs = require("fs");
const src = fs.readFileSync("node_modules/@automacene/liminal-memory/dist/liminal-memory.min.js", "utf8");
const window = {};
const Liminal = new Function("window", src + "; return Liminal;")(window);
if (Object.keys(window).length !== 0) throw new Error("the bundle wrote to window: " + Object.keys(window));
(async () => {
  const mem = new Liminal.LiminalMemory();
  await mem.create({ id: "a", content: "the quarterly revenue report" });
  const [hit] = await mem.rank("quarterly report");
  if (hit.node.id !== "a") throw new Error("script tag build did not rank correctly");
  process.stdout.write(\`global works, no window writes, scored \${hit.score.toFixed(2)}\`);
})().catch(e => { console.error(e.message); process.exit(1); });
`);

write("types.ts", `
import { LiminalMemory, Pool, BM25, keywordTagger, decayGraph, defaults } from "@automacene/liminal-memory";

const mem = new LiminalMemory({
  defaultPool: "chat",
  now: () => 1,
  onEvict: async nodes => nodes.length,
  tagger: keywordTagger(),
  engine: () => new BM25({ calibrated: false, inflection: 0.6, slope: 8 }),
  graph: decayGraph({ decayMs: 1000 })
});

export async function use() {
  const node = await mem.create({ content: "x", metadata: { source: "test" } });
  const id: string = node.id;
  const createdAt: number = node.metadata.createdAt;
  const hits = await mem.rank("x", { from: id, limit: 3, minScore: 0.5, link: false });
  const score: number = hits[0].score;
  const raw: number = hits[0].raw;
  const edges = mem.neighbors(id);
  const observedAt: number | undefined = edges[0]?.observedAt;
  const pool: Pool = mem.pool("docs");
  const k1: number = defaults.bm25.k1;
  return [id, createdAt, score, raw, observedAt, pool.size, k1];
}
`);

write("tsconfig.json", JSON.stringify({
  compilerOptions: {
    strict: true, noEmit: true, module: "esnext",
    moduleResolution: "bundler", target: "es2022", skipLibCheck: true, types: []
  },
  include: ["types.ts"]
}, null, 2));

check("import from an ESM project", () => run("node", ["esm.mjs"], project).trim());
check("require() from CommonJS", () => run("node", ["cjs.cjs"], project).trim());
check("script tag bundle exposes the global", () => run("node", ["iife.cjs"], project).trim());
check("published types resolve from the package name", () => {
  run(join(repo, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], project);
  return "a strict consumer compiles";
});
check("the tarball carries dist and src, and nothing else", () => {
  const listing = run("tar", ["-tzf", join(scratch, tarball)], scratch).trim().split("\n");
  const stray = listing.filter(f => /package\/(tests|examples|scripts)\//.test(f));
  if (stray.length > 0) throw new Error(`should not ship: ${stray.join(", ")}`);

  const required = ["package/src/index.js", "package/dist/liminal-memory.min.js",
    "package/dist/liminal-memory.cjs", "package/dist/types/index.d.ts"];
  const missing = required.filter(f => !listing.includes(f));
  if (missing.length > 0) throw new Error(`missing from tarball: ${missing.join(", ")}`);

  return `${listing.length} files, none of them tests or examples`;
});
check("every exports target actually exists in the tarball", () => {
  const pkg = JSON.parse(readFileSync(join(project, "node_modules/@automacene/liminal-memory/package.json"), "utf8"));
  const installed = join(project, "node_modules/@automacene/liminal-memory");
  const targets = [
    ...Object.values(pkg.exports["."]).filter(v => typeof v === "string"),
    pkg.main, pkg.module, pkg.browser, pkg.unpkg, pkg.jsdelivr, pkg.types
  ].filter(Boolean);

  for (const target of new Set(targets)) {
    readFileSync(join(installed, target)); // throws if the exports map points at nothing
  }
  return `${new Set(targets).size} entry points, all present`;
});

rmSync(scratch, { recursive: true, force: true });

const failed = results.filter(r => !r.ok).length;
console.log(`\n${"-".repeat(60)}`);
console.log(failed === 0
  ? `  ${results.length} of ${results.length} passed. Safe to publish.`
  : `  ${failed} of ${results.length} FAILED. Do not publish.`);
console.log();

if (failed > 0) process.exitCode = 1;
