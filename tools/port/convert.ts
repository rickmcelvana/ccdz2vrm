// Phase 7: the shipped conversion (app/src/convert/convert.ts, what the worker runs) from the
// FBX file itself -- ufbx WASM included -- in Node, to set beside Blender's:
//   node tools/port/convert.ts <file.fbx> cc|daz <name> web|desktop|max [--no-springs] [--twist-split] [--max-texture N]
// writes out/spike/<name>.e2e[.web|.max].vrm and prints the stages and the summary.
import { readFileSync, writeFileSync } from 'node:fs';
import { convertFbx, STAGES, type Quality } from '../../app/src/convert/convert.ts';
import { ufbxParser } from '../../app/src/convert/ufbx.ts';
import { nodeCodec } from './codec.ts';

const args = process.argv.slice(2);
const [fbx, kind, name, quality] = args;
if (!fbx || (kind !== 'cc' && kind !== 'daz') || !name || !['web', 'desktop', 'max'].includes(quality ?? ''))
  throw new Error('usage: node tools/port/convert.ts <file.fbx> cc|daz <name> web|desktop|max [--no-springs] [--twist-split]');
const parse = ufbxParser(await WebAssembly.compile(readFileSync(new URL('../../app/src/convert/ufbx_contract.wasm', import.meta.url))));
const t = performance.now();
let t0 = t;
const { vrm, summary } = await convertFbx(
  new Uint8Array(readFileSync(fbx)),
  {
    kind, name, quality: quality as Quality, springBones: !args.includes('--no-springs'), twistSplit: args.includes('--twist-split'),
    ...(args.includes('--max-texture') ? { maxTexture: Number(args[args.indexOf('--max-texture') + 1]) } : {}),
  },
  parse, nodeCodec,
  {
    stage: (i, state) => {
      if (state === 'running') t0 = performance.now();
      else console.log(`${STAGES[i]}: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    },
    log: () => {},
  },
);
const suffix = quality === 'desktop' ? '' : `.${quality}`;
writeFileSync(`out/spike/${name}.e2e${suffix}.vrm`, vrm);
console.log(JSON.stringify({ total_s: +((performance.now() - t) / 1000).toFixed(1), ...summary }));
