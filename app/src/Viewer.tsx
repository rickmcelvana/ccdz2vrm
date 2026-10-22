// The finished VRM, loaded the way an app would load it: three-vrm 3.5.5, an environment map
// (reflection problems like the "chrome" clothes of ENVIRONMENT.md s27 only show with one),
// eyes that follow the pointer, idle blinks, and buttons to try the face.

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';

type Framing = 'face' | 'body';
type Act = 'none' | 'talk' | 'happy' | 'surprised' | 'angry' | 'sad';

const ACTS: { id: Act; label: string }[] = [
  { id: 'talk', label: 'Talk' },
  { id: 'happy', label: 'Smile' },
  { id: 'surprised', label: 'Surprised' },
  { id: 'sad', label: 'Sad' },
  { id: 'angry', label: 'Angry' },
];

const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

declare global {
  interface Window {
    /** For scripted checks: the loaded VRM and its expression names. */
    __ccdzViewer?: { vrm: VRM; expressions: string[] };
  }
}

export function Viewer({ data }: { data: ArrayBuffer }) {
  const host = useRef<HTMLDivElement>(null);
  const [framing, setFraming] = useState<Framing>('face');
  const [act, setAct] = useState<Act>('none');
  const [error, setError] = useState<string | null>(null);
  const api = useRef<{ frame: (f: Framing) => void; act: (a: Act) => void } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    // dimmer than tools/viewer's lights alone: the environment adds its own fill
    scene.environmentIntensity = 0.35;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 2);
    scene.add(key);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const lookTarget = new THREE.Object3D();
    scene.add(lookTarget);

    let vrm: VRM | null = null;
    let current: Act = 'none';
    let follow = false; // until the pointer is over the canvas: look at the camera

    const resize = () => {
      const r = el.getBoundingClientRect();
      renderer.setSize(r.width, r.height);
      camera.aspect = r.width / Math.max(1, r.height);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const frame = (f: Framing) => {
      if (!vrm) return;
      const head = vrm.humanoid.getNormalizedBoneNode('head')?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(0, 1.5, 0);
      if (f === 'face') {
        controls.target.copy(head).add(new THREE.Vector3(0, 0.02, 0));
        camera.position.copy(controls.target).add(new THREE.Vector3(0, 0, 1.05));
      } else {
        controls.target.set(0, head.y * 0.55, 0);
        camera.position.set(0, head.y * 0.6, 3.6);
      }
      controls.update();
    };

    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    loader.parse(
      data,
      '',
      (gltf) => {
        vrm = gltf.userData.vrm as VRM | undefined ?? null;
        if (!vrm) return setError('This file has no VRM data in it.');
        VRMUtils.rotateVRM0(vrm);
        scene.add(vrm.scene);
        // three-vrm 3.5.5 sets spring rest state before world matrices exist (ENVIRONMENT.md s29)
        vrm.scene.updateMatrixWorld(true);
        vrm.springBoneManager?.reset();
        if (vrm.lookAt) vrm.lookAt.target = lookTarget;
        // relax the T-pose so the preview reads as a person, not a rig
        for (const [bone, side] of [['leftUpperArm', 1], ['rightUpperArm', -1]] as const) {
          const node = vrm.humanoid.getNormalizedBoneNode(bone);
          if (node) node.rotation.z = side * -1.2;
        }
        window.__ccdzViewer = { vrm, expressions: vrm.expressionManager?.expressions.map((e) => e.expressionName) ?? [] };
        frame('face');
      },
      (err) => setError(String(err)),
    );

    const onMove = (e: PointerEvent) => {
      if (!follow) return;
      const r = renderer.domElement.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2 - 1;
      const y = -((e.clientY - r.top) / r.height) * 2 + 1;
      // a point in the camera's own plane, offset toward the pointer: the eyes look at the
      // viewer and turn with the pointer (a target at the face's depth crosses them)
      const reach = camera.position.distanceTo(controls.target) * 0.6;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      lookTarget.position.copy(camera.position).addScaledVector(right, x * reach).addScaledVector(up, y * reach);
    };
    const onLeave = () => {
      follow = false;
      lookTarget.position.copy(camera.position);
    };
    const onEnter = () => {
      follow = true;
    };
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);
    renderer.domElement.addEventListener('pointerenter', onEnter);

    api.current = {
      frame,
      act: (a) => {
        current = a;
      },
    };

    const timer = new THREE.Timer();
    let nextBlink = 1.5;
    renderer.setAnimationLoop(() => {
      timer.update();
      const dt = Math.min(timer.getDelta(), 0.1);
      const t = timer.getElapsed();
      controls.update();
      if (vrm) {
        const em = vrm.expressionManager;
        if (!follow) lookTarget.position.copy(camera.position);
        let blink = 0;
        if (t > nextBlink) {
          const p = t - nextBlink;
          blink = p < 0.15 ? Math.sin((p / 0.15) * Math.PI) : 0;
          if (p >= 0.15) nextBlink = t + 2 + Math.random() * 3;
        }
        em?.setValue('blink', current === 'happy' ? 0 : blink);
        const viseme = Math.floor(t * 6) % VISEMES.length;
        const open = Math.abs(Math.sin(t * 6 * Math.PI));
        VISEMES.forEach((v, i) => em?.setValue(v, current === 'talk' && i === viseme ? open * 0.9 : 0));
        for (const e of ['happy', 'surprised', 'sad', 'angry'] as const) {
          const target = current === e ? 1 : 0;
          const now = em?.getValue(e) ?? 0;
          em?.setValue(e, now + (target - now) * Math.min(1, dt * 8));
        }
        vrm.update(dt);
      }
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      pmrem.dispose();
      if (vrm) VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
      delete window.__ccdzViewer;
    };
  }, [data]);

  const chooseFraming = (f: Framing) => {
    setFraming(f);
    api.current?.frame(f);
  };
  const chooseAct = (a: Act) => {
    const next = act === a ? 'none' : a;
    setAct(next);
    api.current?.act(next);
  };

  return (
    <div className="viewer">
      <div className="viewer-canvas" ref={host} />
      {error && <p className="viewer-error">Could not show it: {error}</p>}
      <div className="viewer-bar">
        <div className="segmented">
          {(['face', 'body'] as const).map((f) => (
            <button key={f} type="button" className={`segmented-item ${framing === f ? 'segmented-on' : ''}`} onClick={() => chooseFraming(f)}>
              {f === 'face' ? 'Face' : 'Full body'}
            </button>
          ))}
        </div>
        <div className="viewer-acts">
          {ACTS.map((a) => (
            <button key={a.id} type="button" className={`chip ${act === a.id ? 'chip-on' : ''}`} onClick={() => chooseAct(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
      <p className="viewer-hint">Drag to turn · scroll to zoom · the eyes follow your pointer</p>
    </div>
  );
}
