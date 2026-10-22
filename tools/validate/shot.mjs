// Screenshot VRMs in the three-vrm viewer, headless: node shot.mjs out.png a.vrm [...]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [outPrefix, ...files] = process.argv.slice(2);
const server = createServer(async (req, res) => {
  try {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
    const st = await stat(p);
    res.writeHead(200, { "content-type": p.endsWith(".html") ? "text/html" : "application/octet-stream", "content-length": st.size });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
for (const f of files) {
  const url = "/" + path.relative(ROOT, path.resolve(f)).split(path.sep).join("/");
  await page.goto(`http://127.0.0.1:${server.address().port}/tools/viewer/index.html?vrm=${url}`);
  await page.waitForFunction(() => window.__viewer?.loaded === true, null, { timeout: 120000 });
  for (const [view, yaw, dist, dy, name] of [["body", 0, 3.1, 0, "body"], ["face", 20, 0.6, 0, "face"], ["face", 0, 1.2, -0.12, "call"], ...(process.env.SHOT_NECK ? [["face", 15, 0.45, -0.2, "neck"]] : [])]) {
    await page.evaluate(([v, y, d, h]) => { window.frame(v, y, d, h); document.getElementById("look").classList.contains("on") && document.getElementById("look").click(); }, [view, yaw, dist, dy]);
    await page.waitForTimeout(400);
    const out = `${outPrefix}_${path.basename(f, ".vrm")}_${name}.png`;
    await page.locator("#view canvas").screenshot({ path: out });
    console.log(out);
  }
}
await browser.close(); server.close();
