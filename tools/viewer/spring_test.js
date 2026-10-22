// Spring-bone motion check for tools/viewer/index.html: 2 s idle, 2 s head shake, 3 s settle,
// stepped at 60 fps (runs in a background tab). Usage in the page console:
//   await eval(await (await fetch('/tools/viewer/spring_test.js')).text())
// Optional: window.__shake = { amp: radians, hz }. Tip nodes are the exporter's *_tip bones.
// Spring test: 2 s idle, 2 s head shake (+-40 deg, 1.25 Hz), 3 s settle. Samples tip nodes each frame.
(async () => {
  const V = vrm.scene.position.constructor;
  const sb = vrm.springBoneManager;
  const tips = []; vrm.scene.traverse(o => { if (/_tip$/.test(o.name)) tips.push(o); });
  const headNode = vrm.humanoid.getNormalizedBoneNode('head');
  const rawHead = vrm.humanoid.getRawBoneNode('head');
  // head collider (sphere) in world space
  const cols = [...sb.colliders];
  const headCol = cols.find(c => c.parent === rawHead || c.parent?.name === rawHead.name);
  const shape = headCol?.shape;
  const rest = tips.map(t => t.getWorldPosition(new V()));
  const restLocal = tips.map(t => rawHead.worldToLocal(t.getWorldPosition(new V())));
  const orig = vrm.update.bind(vrm); const log = [];
  let minClear = Infinity, maxLag = 0, endDrift = 0, idleDrift = 0;
  const step = (t, dt) => {
    headNode.rotation.y = (t > 2 && t < 4) ? SH.amp * Math.sin((t - 2) * 2 * Math.PI * SH.hz) : 0;
    orig(dt); vrm.scene.updateMatrixWorld(true);
    // tip offsets in head space: how far the strand moved relative to the head
    const off = tips.map((tp, i) => rawHead.worldToLocal(tp.getWorldPosition(new V())).distanceTo(restLocal[i]));
    const m = Math.max(...off);
    if (t < 2) idleDrift = Math.max(idleDrift, m);
    else if (t < 4) maxLag = Math.max(maxLag, m);
    else if (t > 6.5) endDrift = Math.max(endDrift, m);
    if (headCol) {
      const c = new V(); headCol.getWorldPosition(c);
      const ctr = shape.offset ? shape.offset.clone().applyMatrix4(headCol.matrixWorld) : c;
      for (const tp of tips) minClear = Math.min(minClear, tp.getWorldPosition(new V()).distanceTo(ctr) - shape.radius);
    }
  };
  const SH = window.__shake || { amp: 0.7, hz: 1.25 };
  for (let i = 0; i < 432; i++) step(i / 60, 1 / 60);
  return JSON.stringify({ tips: tips.length, joints: sb.joints.size, colliders: cols.length, headCollider: !!headCol, headRadius: shape?.radius,
    idleDrift_cm: +(idleDrift * 100).toFixed(2), maxLagDuringShake_cm: +(maxLag * 100).toFixed(2),
    driftAfterSettle_cm: +(endDrift * 100).toFixed(2), minTipClearanceFromHeadCollider_cm: +(minClear * 100).toFixed(2) });
})()
