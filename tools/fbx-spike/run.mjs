// Run the parser spike in headless Chromium on one FBX:
//   node tools/fbx-spike/run.mjs <fbx> <name> [ufbx,fbxloader] [parse-only]
// Writes out/spike/<name>.<parser>.{json,bin}; prints timings and memory as JSON.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'out/spike');
const [fbx, name, parsers = 'ufbx,fbxloader', mode] = process.argv.slice(2); // mode: parse-only
await mkdir(OUT, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/save' && req.method === 'POST') {
      const file = path.join(OUT, path.basename(url.searchParams.get('file')));
      const parts = [];
      for await (const c of req) parts.push(c);
      await writeFile(file, Buffer.concat(parts));
      return res.writeHead(200).end();
    }
    // the FBX itself, from anywhere on disk (local tool only, bound to 127.0.0.1)
    const p = url.pathname === '/file' ? url.searchParams.get('path') : path.join(ROOT, decodeURIComponent(url.pathname));
    const st = await stat(p);
    res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream', 'content-length': st.size });
    createReadStream(p).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--max-old-space-size=8192'] });
// One tab per parser. A dying tab is NOT reliably reported: FBXLoader grew the renderer past
// 5 GB on a 142 MB Daz export, the renderer died, and Playwright's 'crash' event and
// waitForFunction timeout both stayed silent -- the run hung for hours, twice. Callers must
// wrap each run in a hard limit (run_all.sh: `timeout`); results print as each parser ends.
const LIMIT_MS = 10 * 60_000;
const summary = { fbx: path.resolve(fbx), results: {} };
for (const parser of parsers.split(',')) {
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'error' && console.error(`${parser}:`, m.text()));
  const crashed = new Promise((_, reject) => page.once('crash', () => reject(new Error('tab crashed (out of memory?)'))));
  const q = new URLSearchParams({ fbx: path.resolve(fbx), name, parsers: parser, ...(mode === 'parse-only' ? { parse_only: '1' } : {}) });
  try {
    await Promise.race([
      (async () => {
        await page.goto(`http://127.0.0.1:${server.address().port}/tools/fbx-spike/spike.html?${q}`);
        await page.waitForFunction(() => window.__spike?.done, null, { timeout: LIMIT_MS, polling: 500 });
        const r = await page.evaluate(() => window.__spike);
        summary.fbx_mb = r.fbx_mb;
        summary.results[parser] = r.error ? { error: r.error } : r.results[parser];
      })(),
      crashed,
    ]);
  } catch (e) {
    summary.results[parser] = { error: String(e.message ?? e).split('\n')[0] };
  }
  // printed per parser: a later tab that dies must not take this result with it
  console.log(JSON.stringify({ parser, fbx_mb: summary.fbx_mb, ...summary.results[parser] }));
  await page.close().catch(() => {});
}
await browser.close();
server.close();
