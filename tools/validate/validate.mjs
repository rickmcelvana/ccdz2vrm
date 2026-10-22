// Headless VRM gate: Khronos glTF validator + the three-vrm runtime check.
//
//   cd tools/validate && npm install            (once)
//   node validate.mjs ../../out/a.vrm [...]     -> exit 1 if anything fails
//
// 1. gltf-validator (Khronos reference implementation) on the raw bytes.
//    VRMC_* extensions are unknown to it and reported as info, not errors.
// 2. tools/viewer/check.html in headless Chromium (Playwright), served from the
//    repo root by a throwaway static server: loads each file in three-vrm and
//    checks presets move, blink sides, gaze symmetry, 0 console errors.
//    three / three-vrm come from the CDN named in check.html's import map.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import validator from "gltf-validator";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const files = process.argv.slice(2).map(f => path.resolve(f));
if (!files.length) { console.error("usage: node validate.mjs <file.vrm> [...]"); process.exit(2); }

let failed = false;

// --- 1. Khronos validator --------------------------------------------------------
for (const f of files) {
  const bytes = new Uint8Array(await readFile(f));
  const rep = await validator.validateBytes(bytes, { maxIssues: 500, ignoredIssues: ["UNSUPPORTED_EXTENSION"] });
  const { numErrors, numWarnings } = rep.issues;
  const tag = numErrors ? "FAIL" : "ok  ";
  failed ||= numErrors > 0;
  console.log(`${tag} gltf-validator ${path.relative(ROOT, f)}  errors ${numErrors}  warnings ${numWarnings}`);
  for (const m of rep.issues.messages.filter(m => m.severity === 0).slice(0, 12))
    console.log(`       ERROR ${m.code} ${m.pointer ?? ""} ${m.message}`);
  const byCode = {};
  for (const m of rep.issues.messages.filter(m => m.severity === 1)) byCode[m.code] = (byCode[m.code] || 0) + 1;
  for (const [code, n] of Object.entries(byCode)) console.log(`       warn  ${code} x${n}${n >= 50 ? "+" : ""}`);
}

// --- 2. three-vrm runtime check ----------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".vrm": "model/gltf-binary",
               ".json": "application/json", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!p.startsWith(ROOT)) throw new Error("outside root");
    const st = await stat(p);
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream", "content-length": st.size });
    if (req.method === "HEAD") return res.end();
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const urls = files.map(f => "/" + path.relative(ROOT, f).split(path.sep).join("/"));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/tools/viewer/check.html?vrm=${urls.join(",")}`);
  await page.waitForFunction(() => window.__checkDone === true, null, { timeout: 600_000 });
  const results = await page.evaluate(() => window.__check);
  for (const r of results) {
    failed ||= !r.ok;
    console.log(`${r.ok ? "ok  " : "FAIL"} three-vrm      ${r.url.slice(1)}  bones ${r.bones}  expr ${r.expr}  presets ${r.moving}/13  ` +
                `blink-sides ${r.blinkSides}  gaze ${(r.gaze || []).join("/")}°  draws ${r.drawCalls}  load ${r.loadS}s`);
    for (const e of r.errors) console.log(`       ERROR ${e}`);
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
