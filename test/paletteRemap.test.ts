import { describe, expect, it } from 'vitest';
import { getPaletteUsage, remapSlpPalette, type PaletteRemapOptions } from '../src/core/paletteRemap';
import { PixelKind, SlpError, type IndexedLayer, type SlpFile, type SlpFrame } from '../src/core/types';

function makeLayer(values: number[], kinds = values.map(() => PixelKind.Palette)): IndexedLayer {
  return {
    width: values.length,
    height: 1,
    hotspotX: -3,
    hotspotY: 7,
    kind: Uint8Array.from(kinds),
    value: Uint16Array.from(values),
    modifier: Uint8Array.from(values.map((_, i) => i + 10)),
    rgba: Uint8ClampedArray.from(values.flatMap((_, i) => [i, 40, 80, 255])),
  };
}

function makeFrame(index: number, main: IndexedLayer): SlpFrame {
  const secondary = { ...makeLayer([1, 1, 243]), frameType: 8 };
  return {
    index,
    info: {
      cmdTableOffset: 128,
      outlineTableOffset: 96,
      paletteOffset: 64,
      properties: 5,
      width: main.width,
      height: main.height,
      hotspotX: main.hotspotX,
      hotspotY: main.hotspotY,
    },
    main,
    secondary,
    secondaryInfo: {
      cmdTableOffset: 256,
      outlineTableOffset: 224,
      nullField: 0,
      properties: 11,
      frameType: secondary.frameType,
      width: secondary.width,
      height: secondary.height,
      hotspotX: secondary.hotspotX,
      hotspotY: secondary.hotspotY,
    },
  };
}

function makeSlp(): SlpFile {
  return {
    containerVersion: '4.2P',
    version: '4.1X',
    compressed: true,
    byteLength: 1024,
    warnings: ['Keep this warning', 'And this one'],
    header: {
      version: '4.1X',
      numFrames: 3,
      comment: 'Keep header fields',
      type: 8,
      numDirections: 1,
      framesPerDirection: 3,
      paletteId: 5,
      offsetMain: 32,
      offsetSecondary: 512,
    },
    frames: [
      makeFrame(20, makeLayer(
        [1, 2, 0, 255, 77, 1, 1, 1, 1, 243, 1],
        [PixelKind.Palette, PixelKind.Palette, PixelKind.Palette, PixelKind.Palette,
          PixelKind.Palette, PixelKind.Transparent, PixelKind.Player, PixelKind.Shadow,
          PixelKind.OutlinePlayer, PixelKind.OutlineSpecial, PixelKind.Direct],
      )),
      makeFrame(0, makeLayer([2, 1, 2])),
      makeFrame(1, makeLayer([77, 0, 255])),
    ],
  };
}

// Include backing buffers so different typed-array views cannot hide shared storage.
function objectReferences(value: unknown, references = new Set<object>()): Set<object> {
  if (value === null || typeof value !== 'object' || references.has(value)) return references;
  references.add(value);
  if (ArrayBuffer.isView(value)) {
    references.add(value.buffer);
  } else {
    for (const child of Object.values(value)) objectReferences(child, references);
  }
  return references;
}

function expectDetached(input: SlpFile, output: SlpFile): void {
  const inputReferences = objectReferences(input);
  for (const reference of objectReferences(output)) {
    expect(inputReferences.has(reference)).toBe(false);
  }
}

describe('remapSlpPalette', () => {
  it('remaps simultaneously, accepts 0 and 255, and preserves all other data', () => {
    const input = makeSlp();
    const mapping = new Map([[1, 2], [2, 3], [0, 255], [255, 0], [243, 0]]);
    const entries = [...mapping];
    const output = remapSlpPalette(input, mapping);
    const expected = makeSlp();
    expected.frames[0].main.value.set([2, 3, 255, 0, 77, 1, 1, 1, 1, 243, 1]);
    expected.frames[1].main.value.set([3, 2, 3]);
    expected.frames[2].main.value.set([77, 255, 0]);

    expect(output).toEqual(expected);
    expect(input).toEqual(makeSlp());
    expect([...mapping]).toEqual(entries);
    expectDetached(input, output);
  });

  it('selects by position, deduplicates, and preserves the supplied selection and frame order', () => {
    const input = makeSlp();
    const frameIndices = Object.freeze([1, 0, 1]);
    const options = Object.freeze({ frameIndices });
    const output = remapSlpPalette(input, new Map([[1, 2], [2, 3]]), options);
    const expected = makeSlp();
    expected.frames[0].main.value.set([2, 3, 0, 255, 77, 1, 1, 1, 1, 243, 1]);
    expected.frames[1].main.value.set([3, 2, 3]);

    expect(output).toEqual(expected);
    expect(frameIndices).toEqual([1, 0, 1]);
    expect(input).toEqual(makeSlp());
  });

  it.each([{ frameIndices: undefined }, { frameIndices: [] }, { frameIndices: [1] }])(
    'detaches every object and buffer for selection %j', ({ frameIndices }) => {
      const input = makeSlp();
      const output = remapSlpPalette(input, new Map(), { frameIndices });
      expect(output).toEqual(input);
      expectDetached(input, output);

      output.header.paletteId = 99;
      output.warnings.push('New warning');
      for (const frame of output.frames) {
        frame.index = -1;
        frame.info.hotspotX = 100;
        frame.secondaryInfo!.properties = 100;
        for (const layer of [frame.main, frame.secondary!]) {
          layer.hotspotY = 100;
          layer.kind.fill(PixelKind.Direct);
          layer.value.fill(200);
          layer.modifier!.fill(200);
          layer.rgba!.fill(200);
        }
      }
      expect(input).toEqual(makeSlp());
    },
  );

  it('an empty selection copies without remapping', () => {
    const input = makeSlp();
    const output = remapSlpPalette(input, new Map([[1, 9], [2, 8]]), { frameIndices: [] });
    expect(output).toEqual(input);
    expectDetached(input, output);
  });

  it('handles absent optional layers and arrays without adding them', () => {
    const input = makeSlp();
    for (const frame of input.frames) {
      delete frame.secondary;
      delete frame.secondaryInfo;
      delete frame.main.modifier;
      delete frame.main.rgba;
    }
    const output = remapSlpPalette(input, new Map());
    expect(output).toStrictEqual(input);
    expectDetached(input, output);
  });

  it('returns an independent copy for an empty file', () => {
    const input = makeSlp();
    input.frames = [];
    input.header.numFrames = 0;
    const output = remapSlpPalette(input, new Map([[0, 255]]));
    expect(output).toEqual(input);
    expectDetached(input, output);
  });
});

describe('getPaletteUsage', () => {
  it('counts only main palette pixels and sorts by count descending then index ascending', () => {
    const input = makeSlp();
    expect(getPaletteUsage(input)).toEqual([
      { index: 2, count: 3 },
      { index: 0, count: 2 },
      { index: 1, count: 2 },
      { index: 77, count: 2 },
      { index: 255, count: 2 },
    ]);
    expect(input).toEqual(makeSlp());
  });

  it('selects by position once per frame without mutating options', () => {
    const input = makeSlp();
    const options = Object.freeze({ frameIndices: Object.freeze([2, 1, 2]) });
    expect(getPaletteUsage(input, options)).toEqual([
      { index: 2, count: 2 },
      { index: 0, count: 1 },
      { index: 1, count: 1 },
      { index: 77, count: 1 },
      { index: 255, count: 1 },
    ]);
    expect(options.frameIndices).toEqual([2, 1, 2]);
    expect(input).toEqual(makeSlp());
  });

  it('returns an empty array for no selected frames, no frames, or no palette pixels', () => {
    const input = makeSlp();
    expect(getPaletteUsage(input, { frameIndices: [] })).toEqual([]);
    input.frames = [];
    input.header.numFrames = 0;
    expect(getPaletteUsage(input)).toEqual([]);
    input.frames = [makeFrame(5, makeLayer([0, 255], [PixelKind.Player, PixelKind.Direct]))];
    input.header.numFrames = 1;
    expect(getPaletteUsage(input)).toEqual([]);
  });
});

describe('palette remap validation', () => {
  const invalidIndices = [-1, 256, 0.5, NaN, Infinity, -Infinity, '1', undefined, null];

  it.each(invalidIndices)('rejects invalid mapping keys and values: %s', (invalid) => {
    for (const mapping of [
      new Map([[invalid as number, 1]]),
      new Map([[1, invalid as number]]),
    ]) {
      const input = makeSlp();
      const entries = [...mapping];
      // Validation is required even for an unused entry or an empty selection/file.
      expect(() => remapSlpPalette(input, mapping)).toThrow(SlpError);
      expect(() => remapSlpPalette(input, mapping, { frameIndices: [] })).toThrow(SlpError);
      input.frames = [];
      input.header.numFrames = 0;
      expect(() => remapSlpPalette(input, mapping)).toThrow(SlpError);
      expect([...mapping]).toEqual(entries);
    }
  });

  it('validates unused entries after valid mapping entries without mutating input', () => {
    const input = makeSlp();
    expect(() => remapSlpPalette(input, new Map([[1, 2], [99, 256]]))).toThrow(SlpError);
    expect(input).toEqual(makeSlp());
  });

  const readers: Array<[string, (slp: SlpFile, options?: PaletteRemapOptions) => unknown]> = [
    ['remapSlpPalette', (slp, options) => remapSlpPalette(slp, new Map([[1, 2]]), options)],
    ['getPaletteUsage', getPaletteUsage],
  ];

  describe.each(readers)('%s selection validation', (_, read) => {
    it.each([-1, 3, 20, 0.5, NaN, Infinity, -Infinity, '1', undefined, null])(
      'rejects invalid positions after valid positions: %s',
      (invalid) => {
        const input = makeSlp();
        const options = Object.freeze({ frameIndices: Object.freeze([1, invalid as number]) });
        expect(() => read(input, options)).toThrow(SlpError);
        expect(input).toEqual(makeSlp());
        expect(options.frameIndices).toEqual([1, invalid]);
      },
    );

    it('rejects position zero on an empty file', () => {
      const input = makeSlp();
      input.frames = [];
      input.header.numFrames = 0;
      expect(() => read(input, { frameIndices: [0] })).toThrow(SlpError);
    });
  });
});
