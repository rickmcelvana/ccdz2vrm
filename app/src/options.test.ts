import { describe, expect, it } from 'vitest';
import { cleanName, defaultChoices, formatBytes, formatSeconds, outputFile, request } from './options';
import type { FbxInfo } from './types';

const daz: FbxInfo = {
  path: 'C:\\x\\alice.fbx',
  fileName: 'alice.fbx',
  sizeBytes: 1,
  kind: 'daz',
  family: 'Genesis 8.1',
  face: '',
  supported: true,
  notes: [],
  suggestedName: 'alice',
};

describe('options', () => {
  it('defaults to the web tier with swinging hair', () => {
    expect(defaultChoices(daz)).toEqual({ quality: 'web', name: 'alice', springBones: true, twistSplit: false });
  });

  it('names files the way the CLI does', () => {
    const c = defaultChoices(daz);
    expect(outputFile(c)).toBe('alice.web.vrm');
    expect(outputFile({ ...c, quality: 'desktop' })).toBe('alice.vrm');
    expect(outputFile({ ...c, quality: 'max' })).toBe('alice.max.vrm');
  });

  it('never asks for a twist split on a CC character', () => {
    const c = { ...defaultChoices(daz), twistSplit: true };
    expect(request(daz, c, 'D:\\out').twistSplit).toBe(true);
    expect(request({ ...daz, kind: 'cc' }, c, 'D:\\out').twistSplit).toBe(false);
    expect(request(daz, { ...c, name: '' }, 'D:\\out').name).toBe('avatar');
  });

  it('keeps names file-safe', () => {
    expect(cleanName('My Girl (v2).final')).toBe('My_Girl__v2__final');
  });

  it('formats sizes and times', () => {
    expect(formatBytes(6_353_228)).toBe('6.4 MB');
    expect(formatBytes(156_000_000)).toBe('156 MB');
    expect(formatBytes(2_048)).toBe('2 KB');
    expect(formatSeconds(83.8)).toBe('1 min 24 s');
    expect(formatSeconds(9.9)).toBe('10 s');
  });
});
