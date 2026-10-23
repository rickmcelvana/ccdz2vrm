// Spring-bone motion check, headless: tools/viewer/spring_test.js (2 s idle, 2 s head shake,
// 3 s settle at a fixed 60 fps) on each file.
//   node springs.mjs a.vrm [b.vrm ...]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const server = createServer(async (req, res) => {
  try {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    const st = await stat(p);
    res.writeHead(200, { "content-type": p.endsWith(".html") ? "text/html" : "application/octet-stream", "content-length": st.size });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
for (const f of process.argv.slice(2)) {
  const page = await browser.newPage();
  const rel = path.relative(ROOT, path.resolve(f)).split(path.sep).join("/");
  await page.goto(`http://127.0.0.1:${server.address().port}/tools/viewer/index.html?vrm=/${rel}`);
  await page.waitForFunction(() => window.__viewer?.loaded === true, null, { timeout: 180000 });
  const r = await page.evaluate(async () => eval(await (await fetch("/tools/viewer/spring_test.js")).text()));
  console.log(`${rel} ${r}`);
  await page.close();
}
await browser.close();
server.close();
