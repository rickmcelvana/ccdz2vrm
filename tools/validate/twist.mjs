// Twist check in three-vrm (ENVIRONMENT.md s25/s36): roll each arm segment 90 deg about its own
// axis through the normalised humanoid, let the runtime (node constraints included) pose the
// skin, and report the worst slice's mean limb radius against rest. 1.0 = no collapse; a plain
// Daz export keeps ~0.77 at the elbow, the twist split ~0.92.
//   node twist.mjs a.vrm [b.vrm ...]
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
  const r = await page.evaluate(() => {
    const V = window.vrm.scene.position.constructor;
    const h = window.vrm.humanoid;
    const body = [];
    window.vrm.scene.traverse((o) => { if (o.isSkinnedMesh && /\.body$/.test(o.parent?.name ?? o.name)) body.push(o); });
    if (!body.length) window.vrm.scene.traverse((o) => { if (o.isSkinnedMesh && /body/i.test(o.parent?.name ?? o.name)) body.push(o); });
    const pts = () => {
      window.vrm.scene.updateMatrixWorld(true);
      const out = [];
      for (const m of body) for (let i = 0; i < m.geometry.attributes.position.count; i++) out.push(m.localToWorld(m.getVertexPosition(i, new V())));
      return out;
    };
    const head = (b) => h.getRawBoneNode(b).getWorldPosition(new V());
    window.vrm.update(0);
    const rest = pts();
    const res = {};
    for (const side of ["left", "right"])
      for (const [seg, a, b] of [["upper", "UpperArm", "LowerArm"], ["lower", "LowerArm", "Hand"]]) {
        const A = head(side + a), B = head(side + b), axis = B.clone().sub(A), L = axis.length();
        axis.normalize();
        const n = h.getNormalizedBoneNode(side + a);
        n.quaternion.setFromAxisAngle(new V(Math.sign(axis.x) || 1, 0, 0), Math.PI / 2);
        window.vrm.update(0);
        const posed = pts();
        n.quaternion.identity();
        window.vrm.update(0);
        // slices along the segment (ends trimmed: shoulder and wrist blend into other parts)
        const N = 12, sum = Array.from({ length: N }, () => [0, 0, 0]);
        rest.forEach((p, i) => {
          const d = p.clone().sub(A), t = d.dot(axis) / L;
          if (t < 0.04 || t > 0.95) return;
          const r0 = d.clone().sub(axis.clone().multiplyScalar(d.dot(axis))).length();
          if (r0 > 0.07) return;
          const q = posed[i].clone().sub(A), r1 = q.clone().sub(axis.clone().multiplyScalar(q.dot(axis))).length();
          const k = Math.min(N - 1, Math.floor(((t - 0.04) / 0.91) * N));
          sum[k][0] += r0; sum[k][1] += r1; sum[k][2]++;
        });
        const ratios = sum.filter((s) => s[2] > 5).map((s) => s[1] / s[0]);
        res[`${side}_${seg}`] = +Math.min(...ratios).toFixed(3);
      }
    return res;
  });
  console.log(`${rel} ${JSON.stringify(r)}`);
  await page.close();
}
await browser.close();
server.close();
