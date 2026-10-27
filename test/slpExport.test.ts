import { describe, expect, it } from 'vitest';
import { buildEditedSlp } from '../src/core/slpExport';
import { remapSlpPalette } from '../src/core/paletteRemap';
import { parseSlp } from '../src/core/slpReader';
import { writeSlp, type WritableFrame } from '../src/core/slpWriter';
import { PixelKind as K, SlpError } from '../src/core/types';

function frames(): WritableFrame[] {
  return [0x020000, 0x070000].map(properties => ({
    width: 6, height: 1, hotspotX: -2, hotspotY: 9, properties,
    kind: new Uint8Array([K.Palette, K.Palette, K.Palette, K.Player, K.Shadow, K.Transparent]),
    value: new Uint16Array([1, 2, 1, 3, 0, 0]),
    secondary: {
      width: 3, height: 1, hotspotX: 2, hotspotY: -1, properties: 17, frameType: 2,
      kind: new Uint8Array([K.Palette, K.Palette, K.Transparent]),
      value: new Uint16Array([8, 20, 0]),
    },
  }));
}

describe('edited SLP export', () => {
  it('writes remapped pixels and reads them back with distinct frame palette IDs, header and shadows', () => {
    const input = parseSlp(writeSlp(frames(), {
      version: '4.0X', paletteId: 8, type: 2, numDirections: 2, framesPerDirection: 1,
    }));
    const original = structuredClone(input);
    const edited = remapSlpPalette(input, new Map([[1, 12], [2, 13]]), { frameIndices: [0] });
    const parsed = parseSlp(buildEditedSlp(edited));
    expect(input).toEqual(original);
    expect(parsed.frames.map(f => f.info.properties)).toEqual([0x020000, 0x070000]);
    expect(parsed.header).toMatchObject({ paletteId: 8, type: 2, numDirections: 2, framesPerDirection: 1 });
    expect(Array.from(parsed.frames[0].main.value)).toEqual([12, 13, 12, 3, 0, 0]);
    expect(parsed.frames[1].main.value).toEqual(input.frames[1].main.value);
    for (let i = 0; i < 2; i++) {
      expect(parsed.frames[i].main.kind).toEqual(input.frames[i].main.kind);
      expect(parsed.frames[i].main).toMatchObject({ width: 6, height: 1, hotspotX: -2, hotspotY: 9 });
      expect(parsed.frames[i].secondary).toEqual(input.frames[i].secondary);
      expect(parsed.frames[i].secondaryInfo?.properties).toBe(17);
    }
  });

  it('exports a decompressed 4.2P edit using the supported inner version', () => {
    const input = parseSlp(writeSlp(frames(), { version: '4.0X' }));
    input.containerVersion = '4.2P'; input.compressed = true;
    const output = parseSlp(buildEditedSlp(input));
    expect(output.version).toBe('4.0X');
    expect(output.frames[1].info.properties).toBe(0x070000);
  });

  it('keeps the old writer defaults for import callers that do not supply frame properties', () => {
    const f = frames()[0]; delete f.properties; delete f.secondary;
    expect(parseSlp(writeSlp([f])).frames[0].info.properties).toBe(0);
    expect(parseSlp(writeSlp([f], { version: '4.0X', paletteId: 7 })).frames[0].info.properties).toBe(7);
  });

  it('preserves 2.0N comment and explicit frame properties', () => {
    const f = frames()[0]; delete f.secondary;
    const input = parseSlp(writeSlp([f], { comment: 'original comment' }));
    const out = parseSlp(buildEditedSlp(input));
    expect(out.header.comment).toBe('original comment');
    expect(out.frames[0].info.properties).toBe(f.properties);
  });

  it('rejects unsupported modifiers instead of silently dropping them', () => {
    const input = parseSlp(writeSlp(frames(), { version: '4.0X' }));
    input.version = '4.1X';
    expect(() => buildEditedSlp(input)).toThrow(SlpError);
    input.version = '4.0X'; input.frames[0].main.modifier = new Uint8Array(6);
    expect(() => buildEditedSlp(input)).toThrow(SlpError);
  });

  it('rejects direct RGBA data and invalid empty input without offering a corrupt download', () => {
    const input = parseSlp(writeSlp(frames(), { version: '4.0X' }));
    input.frames[0].main.rgba = new Uint8ClampedArray(24);
    expect(() => buildEditedSlp(input)).toThrow(SlpError);
    delete input.frames[0].main.rgba;
    input.frames = [];
    expect(() => buildEditedSlp(input)).toThrow(SlpError);
  });
});
