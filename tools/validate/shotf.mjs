import { createServer } from "node:http"; import { readFile, stat } from "node:fs/promises"; import path from "node:path"; import { chromium } from "playwright";
const ROOT = path.resolve("../.."); const [out, f, yaw, dist] = process.argv.slice(2);
const server = createServer(async (req, res) => { try { const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname)); const st = await stat(p); res.writeHead(200, { "content-type": p.endsWith(".html") ? "text/html" : "application/octet-stream", "content-length": st.size }); res.end(await readFile(p)); } catch { res.writeHead(404); res.end(); } });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); const page = await b.newPage({ viewport: { width: 900, height: 900 } });
await page.goto(`http://127.0.0.1:${server.address().port}/tools/viewer/index.html?vrm=/${path.relative(ROOT, path.resolve(f)).split(path.sep).join("/")}`);
await page.waitForFunction(() => window.__viewer?.loaded === true, null, { timeout: 120000 });
await page.evaluate(([y, d]) => { document.getElementById("look").click(); window.frame("face", +y, +d, -0.02); }, [yaw, dist]); await page.waitForTimeout(400);
await page.locator("#view canvas").screenshot({ path: out }); await b.close(); server.close();
