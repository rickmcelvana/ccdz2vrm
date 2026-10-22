// Screenshots of the app page in its states, against `pnpm dev` (port 5174, fake backend):
//   node shots_page.mjs <out-dir>
import { chromium } from "playwright";
const out = process.argv[2] ?? ".";
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await b.newPage({ viewport: { width: 1280, height: 820 } });
const click = (t) => page.getByRole("button", { name: t }).first().click();
async function shot(name) { await page.screenshot({ path: `${out}/${name}.png` }); console.log(name); }

await page.goto("http://localhost:5174/?blender=noaddon&fail=1");
await page.waitForTimeout(1200);
await click(/Drop an .fbx/);
await page.waitForTimeout(300);
await shot("1-noaddon");
await page.goto("http://localhost:5174/?fail=1");
await page.waitForTimeout(1200);
await click(/Drop an .fbx/);
await click(/Convert to VRM/);
await page.waitForTimeout(800);
await shot("2-running");
await page.waitForTimeout(2500);
await click(/Show details/);
await shot("3-failed");
await page.goto("http://localhost:5174/");
await page.waitForTimeout(1200);
await click(/Drop an .fbx/);
await click(/Convert to VRM/);
await page.waitForTimeout(9000);
await page.waitForFunction(() => window.__ccdzViewer);
await page.waitForTimeout(1500);
await shot("4-done-face");
await click("Talk");
await page.waitForTimeout(400);
await click("Full body");
await page.waitForTimeout(1500);
await shot("5-body");
await b.close();
