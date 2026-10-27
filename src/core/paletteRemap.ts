import { PixelKind, SlpError, type IndexedLayer, type SlpFile } from './types';

export interface PaletteRemapOptions {
  /** Zero-based positions in slp.frames; omitted selects all, empty selects none. */
  frameIndices?: readonly number[];
}

function selectedFrames(slp: SlpFile, options?: PaletteRemapOptions): Set<number> | undefined {
  if (options?.frameIndices === undefined) return undefined;

  const selected = new Set<number>();
  for (const position of options.frameIndices) {
    if (!Number.isInteger(position) || position < 0 || position >= slp.frames.length) {
      throw new SlpError(
        'Vị trí frame không hợp lệ.',
        `frameIndices phải chứa số nguyên từ 0 đến ${slp.frames.length - 1}; nhận được: ${position}.`,
      );
    }
    selected.add(position);
  }
  return selected;
}

function cloneLayer<T extends IndexedLayer>(layer: T): T {
  const copy = { ...layer, kind: layer.kind.slice(), value: layer.value.slice() };
  if (layer.modifier !== undefined) copy.modifier = layer.modifier.slice();
  if (layer.rgba !== undefined) copy.rgba = layer.rgba.slice();
  return copy;
}

/** Remap main-layer palette pixels simultaneously, returning a fully detached copy. */
export function remapSlpPalette(
  slp: SlpFile,
  mapping: ReadonlyMap<number, number>,
  options?: PaletteRemapOptions,
): SlpFile {
  for (const [from, to] of mapping) {
    if (
      !Number.isInteger(from) || from < 0 || from > 255 ||
      !Number.isInteger(to) || to < 0 || to > 255
    ) {
      throw new SlpError(
        'Chỉ số palette không hợp lệ.',
        `Mapping phải chứa số nguyên từ 0 đến 255; nhận được: ${from} → ${to}.`,
      );
    }
  }
  const selected = selectedFrames(slp, options);

  return {
    ...slp,
    header: { ...slp.header },
    warnings: [...slp.warnings],
    frames: slp.frames.map((frame, position) => {
      const copy = { ...frame, info: { ...frame.info }, main: cloneLayer(frame.main) };
      if (frame.secondaryInfo !== undefined) copy.secondaryInfo = { ...frame.secondaryInfo };
      if (frame.secondary !== undefined) copy.secondary = cloneLayer(frame.secondary);

      if (selected === undefined || selected.has(position)) {
        for (let i = 0; i < frame.main.kind.length; i++) {
          if (frame.main.kind[i] !== PixelKind.Palette) continue;
          const replacement = mapping.get(frame.main.value[i]);
          if (replacement !== undefined) copy.main.value[i] = replacement;
        }
      }
      return copy;
    }),
  };
}

/** Count main-layer palette pixels, ordered by count descending then index ascending. */
export function getPaletteUsage(
  slp: SlpFile,
  options?: PaletteRemapOptions,
): Array<{ index: number; count: number }> {
  const selected = selectedFrames(slp, options);
  const counts = new Map<number, number>();
  for (let position = 0; position < slp.frames.length; position++) {
    if (selected !== undefined && !selected.has(position)) continue;
    const { kind, value } = slp.frames[position].main;
    for (let i = 0; i < kind.length; i++) {
      if (kind[i] !== PixelKind.Palette) continue;
      const index = value[i];
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([index, count]) => ({ index, count }))
    .sort((a, b) => b.count - a.count || a.index - b.index);
}
