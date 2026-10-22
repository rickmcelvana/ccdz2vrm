// A failed step's message (the pipeline's SystemExit text, see pipeline.rs failure_message)
// turned into what the person can do about it.

export type Advice = { title: string; body: string };

const KNOWN: { match: RegExp; advice: Advice }[] = [
  {
    match: /unsupported Daz rig family: genesis1_2/,
    advice: {
      title: 'Genesis 1 and 2 cannot be converted',
      body: 'Those figures carry no blink or expression morphs, so the avatar could never move its face. Use a Genesis 3, 8 or 8.1 figure.',
    },
  },
  {
    match: /unsupported Daz rig family|not a CC3 rig/,
    advice: {
      title: 'This is not a Daz Genesis or Character Creator export',
      body: 'The skeleton inside the file is not one the converter knows. Export the character again from Daz Studio (Genesis 3/8/8.1) or Character Creator 3 and later.',
    },
  },
  {
    match: /missing face bone/,
    advice: {
      title: 'The face rig is missing from the export',
      body: 'Without FACS morphs the face is built from the face bones. Export again with the figure’s full face rig included.',
    },
  },
  {
    match: /FACS export lacks/,
    advice: {
      title: 'Only part of the FACS morphs were exported',
      body: 'Check the morph export rule: one rule matching “facs” set to Export picks up all of them. Or remove the rule to use the face bones instead.',
    },
  },
  {
    match: /VRM add-on not found/,
    advice: {
      title: 'Blender is missing the VRM add-on',
      body: 'Install it from the Blender card on the left, then convert again.',
    },
  },
  {
    match: /Could not start Blender/,
    advice: {
      title: 'Blender did not start',
      body: 'Check the Blender card on the left: the path may have changed after an update.',
    },
  },
];

export function explain(message: string, stage: string | undefined): Advice {
  const hit = KNOWN.find((k) => k.match.test(message));
  if (hit) return hit.advice;
  return {
    title: stage ? `It stopped while ${stage.charAt(0).toLowerCase()}${stage.slice(1)}` : 'The conversion stopped',
    body: 'The lines below are Blender’s own account. If the export settings look right, the work folder keeps the intermediate files for a bug report.',
  };
}
