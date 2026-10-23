// The static site end to end in Chromium: serve dist/ (pnpm build), choose an FBX through the
// page's file chooser, convert at a tier, download the VRM. SITE_URL=http://localhost:5174/ tests
// the dev server instead.
//   node site_e2e.mjs <file.fbx> <out.vrm> [Web|Desktop|Max] [--twist] [--name <name>]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");
const [fbx, out, tier = "Web", ...flags] = process.argv.slice(2);
// WASM_MIME=application/octet-stream: a host that labels .wasm wrongly (the worker must cope)
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": process.env.WASM_MIME ?? "application/wasm", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  try {
    let p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if ((await stat(p)).isDirectory()) p = path.join(p, "index.html");
    const body = await readFile(p);
    res.writeHead(200, { "content-type": TYPES[path.extname(p)] ?? "application/octet-stream", "content-length": body.length });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(process.env.SITE_URL ?? `http://127.0.0.1:${server.address().port}/`);
const chooser = page.waitForEvent("filechooser");
await page.getByRole("button", { name: /Drop an .fbx/ }).click();
await (await chooser).setFiles(fbx);
await page.getByRole("button", { name: new RegExp(`^${tier}`) }).click();
if (flags.includes("--twist")) await page.getByText("Better elbows and shoulders").click();
if (flags.includes("--name")) await page.getByLabel("Name").fill(flags[flags.indexOf("--name") + 1]);
const t0 = Date.now();
await page.getByRole("button", { name: "Convert to VRM" }).click();
const done = page.getByText("Done.", { exact: true });
const failed = page.locator(".note-stop");
await Promise.race([done.waitFor({ timeout: 900_000 }), failed.waitFor({ timeout: 900_000 })]);
const seconds = (Date.now() - t0) / 1000;
if (await failed.count()) {
  console.log(JSON.stringify({ ok: false, seconds, failure: await failed.innerText(), errors }));
  process.exitCode = 1;
} else {
  const stages = await page.locator(".stage").allInnerTexts();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  await (await dl).saveAs(out);
  console.log(JSON.stringify({ ok: true, seconds, stages: stages.map((s) => s.replace(/\s+/g, " ")), errors }));
  // a look at the page, best effort: software WebGL on a big avatar can take minutes
  await page.waitForFunction(() => window.__viewer?.loaded === true, null, { timeout: 120_000 }).catch(() => {});
  await page.screenshot({ path: out.replace(/\.vrm$/, ".png"), timeout: 120_000 }).catch(() => console.log("no screenshot"));
}
await browser.close();
server.close();
