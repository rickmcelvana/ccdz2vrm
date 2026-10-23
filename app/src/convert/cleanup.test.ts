// The skeleton rules on a hand-built raw import. The real exports are judged against Blender
// by tools/port/run_clean.sh; this covers the one rule none of them exercises (a second
// armature: an item with its own rig, ENVIRONMENT.md s24) and pins the others.
import { describe, expect, it } from 'vitest';
import { MAXW, type Contract, type Mesh, type RawNode } from './contract.ts';
import { cleanImport } from './cleanup.ts';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
let nextBone = 0;
const node = (id: number, name: string, parent: number, type: RawNode['type'], bone = false): RawNode =>
  ({ id, name, parent, type, bone: bone ? nextBone++ : -1, matrix: I });

function mesh(name: string, nodeId: number, clusters: number[], weighted: boolean): Mesh {
  const n = 3;
  const joints = new Uint16Array(n * MAXW), weights = new Float32Array(n * MAXW);
  if (weighted) for (let v = 0; v < n; v++) { joints[v * MAXW] = clusters[0]!; weights[v * MAXW] = 1; }
  return {
    name, mesh: name, node: nodeId, vertex_count: n, triangle_count: 1, position: new Float32Array(n * 3), uv: new Float32Array(n * 2),
    joints, weights, indices: new Uint32Array([0, 1, 2]), triangle_material: new Uint16Array(1), materials: [], morphs: [], clusters,
  };
}

async function build() {
  nextBone = 0;
  const nodes = [
    node(0, 'Figure', -1, 'root'), //            the figure: Root -> armature
    node(1, 'hip', 0, 'limb', true), //           raw bone 0
    node(2, 'head', 1, 'limb', true), //          raw bone 1
    node(3, 'Lashes', 0, 'root'), //              item root inside the armature -> a bone
    node(4, 'hip', 3, 'limb', true), //           copy -> hip.001, raw bone 2
    node(5, 'head', 4, 'limb', true), //          copy -> head.001, raw bone 3
    node(6, 'Fringe', 5, 'limb', true), //        item bone under a copy -> re-parented to head, raw bone 4
    node(7, 'HairRig', -1, 'null'), //            a second armature (an item with its own rig)
    node(8, 'head', 7, 'limb', true), //          raw bone 5
    node(9, 'Chain', 2, 'mesh'), //               a bone-less prop under head
    node(10, 'LashMesh', 3, 'mesh'),
    node(11, 'HairMesh', 7, 'mesh'),
  ];
  const raw: Contract = {
    source: 'test', nodes, bones: nodes.filter((n) => n.bone >= 0).map((n) => ({ name: n.name, parent: null, matrix: I })),
    meshes: [mesh('LashMesh', 10, [3], true), mesh('HairMesh', 11, [5], true), mesh('Chain', 9, [], false)],
    materials: [], images: [],
  };
  return cleanImport(raw, { decode: () => Promise.reject(new Error('no images')) });
}

describe('cleanImport skeleton', () => {
  it('names, re-parents, re-points and binds as import_fbx_clean does', async () => {
    const { contract, report } = await build();
    const bones = Object.fromEntries(contract.bones.map((b) => [b.name, b.parent]));
    // Figure is the armature (not a bone); Lashes a parentless fake bone; copies numbered
    expect(bones).toEqual({ hip: null, head: 'hip', Lashes: null, 'hip.001': 'Lashes', 'head.001': 'hip.001', Fringe: 'head' });
    expect(report.armatures).toEqual({ Figure: 6, HairRig: 1 });
    expect(report.armatures_dropped).toEqual(['HairRig']);
    expect(report.reparented_off_twins).toBe(1);

    const idx = (n: string) => contract.bones.findIndex((b) => b.name === n);
    const [lash, hair, chain] = contract.meshes;
    // `head.001` folds onto `head` (the mesh has no `head` group)
    expect(lash!.joints[0]).toBe(idx('head'));
    expect(report.groups_folded).toBe(1);
    // the second armature's `head` resolves to the figure's by name
    expect(hair!.joints[0]).toBe(idx('head'));
    expect(hair!.weights[0]).toBe(1);
    // the prop rides the bone it hangs from
    expect(report.rigid).toEqual({ Chain: 'head' });
    expect(chain!.joints[0]).toBe(idx('head'));
    expect(chain!.weights[0]).toBe(1);
  });
});
