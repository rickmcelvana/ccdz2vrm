import { describe, expect, it } from 'vitest';
import { explain } from './failures';

describe('explain', () => {
  it('names the Genesis 1/2 refusal before the generic unknown-rig one', () => {
    expect(explain('unsupported Daz rig family: genesis1_2', 'Reading your character').title).toMatch(/Genesis 1 and 2/);
    expect(explain('unsupported Daz rig family: unknown', undefined).title).toMatch(/not a Daz Genesis/);
    expect(explain('not a CC3 rig (no CC_Base_Hip)', undefined).title).toMatch(/not a Daz Genesis/);
  });

  it('falls back to the stage that failed', () => {
    expect(explain('KeyError: foo', 'Building the VRM').title).toBe('It stopped while building the VRM');
  });
});
