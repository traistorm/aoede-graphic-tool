import { describe, expect, it } from 'vitest';
import { lz4DecompressBlock } from '../src/core/lz4';
import {
  createFallbackPalette,
  parseJascPal,
  parsePaletteAuto,
  PaletteMatcher,
  serializeJascPal,
} from '../src/core/palette';
import { SlpError } from '../src/core/types';

describe('palette JASC-PAL', () => {
  const sample = ['JASC-PAL', '0100', '4', '0 0 0', '255 0 0', '0 255 0', '0 0 255'].join('\r\n');

  it('parse đúng index → màu', () => {
    const pal = parseJascPal(sample, 'test.pal');
    expect(pal.size).toBe(4);
    expect([pal.data[3], pal.data[4], pal.data[5]]).toEqual([255, 0, 0]);
    expect([pal.data[9], pal.data[10], pal.data[11]]).toEqual([0, 0, 255]);
  });

  it('serialize rồi parse lại cho kết quả giống nhau', () => {
    const pal = parseJascPal(sample);
    const round = parseJascPal(serializeJascPal(pal));
    expect(Array.from(round.data)).toEqual(Array.from(pal.data));
  });

  it('báo lỗi khi không phải JASC-PAL', () => {
    expect(() => parseJascPal('hello world')).toThrow(SlpError);
  });

  it('tự nhận diện palette nhị phân 768 byte', () => {
    const bin = new Uint8Array(768);
    bin[3] = 12;
    bin[4] = 34;
    bin[5] = 56;
    const pal = parsePaletteAuto(bin, 'bin');
    expect(pal.source).toBe('binary');
    expect([pal.data[3], pal.data[4], pal.data[5]]).toEqual([12, 34, 56]);
  });
});

describe('Fallback palette', () => {
  /** Lấy RGB ở shade `s` (0..15) của player `p` (1..8). */
  function sample(pal: ReturnType<typeof createFallbackPalette>, p: number, s: number): [number, number, number] {
    const i = 16 + (p - 1) * 16 + s;
    return [pal.data[i * 3], pal.data[i * 3 + 1], pal.data[i * 3 + 2]];
  }

  it('Player 1 (blue) thiên về xanh dương', () => {
    const pal = createFallbackPalette();
    const [r, g, b] = sample(pal, 1, 12);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it('Player 2 (red) thiên về đỏ', () => {
    const pal = createFallbackPalette();
    const [r, g, b] = sample(pal, 2, 12);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it('Player 3 (yellow) R cao, G cao, B thấp', () => {
    const pal = createFallbackPalette();
    const [r, g, b] = sample(pal, 3, 12);
    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b);
  });

  it('Player 4 (brown) R và G cao hơn B', () => {
    const pal = createFallbackPalette();
    const [r, g, b] = sample(pal, 4, 12);
    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b);
  });

  it('Player 6 (green) G cao nhất', () => {
    const pal = createFallbackPalette();
    const [r, g, b] = sample(pal, 6, 12);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('Player 7 (purple) R và B cao, G thấp', () => {
    const pal = createFallbackPalette();
    const [r, g, b] = sample(pal, 7, 12);
    expect(r).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(g);
  });

  it('Player 8 (teal) B và G cao, R thấp', () => {
    const pal = createFallbackPalette();
    const [r, g, b] = sample(pal, 8, 12);
    expect(b).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(r);
  });

  it('Mỗi dải player có gradient từ tối → sáng', () => {
    const pal = createFallbackPalette();
    for (let p = 1; p <= 8; p++) {
      const dark = sample(pal, p, 0);
      const light = sample(pal, p, 15);
      const sumDark = dark[0] + dark[1] + dark[2];
      const sumLight = light[0] + light[1] + light[2];
      expect(sumLight).toBeGreaterThan(sumDark);
    }
  });

  it('Index 0 = đen (trong suốt)', () => {
    const pal = createFallbackPalette();
    expect(pal.data[0]).toBe(0);
    expect(pal.data[1]).toBe(0);
    expect(pal.data[2]).toBe(0);
  });
});

describe('PaletteMatcher', () => {
  it('tìm màu gần nhất theo khoảng cách Euclid', () => {
    const pal = parseJascPal(
      ['JASC-PAL', '0100', '3', '0 0 0', '255 255 255', '255 0 0'].join('\n'),
    );
    const m = new PaletteMatcher(pal, { limit: 3 });
    expect(m.find(250, 10, 10)).toBe(2);
    expect(m.find(240, 240, 240)).toBe(1);
    expect(m.find(5, 5, 5)).toBe(0);
  });

  it('loại trừ được dải player color', () => {
    const pal = createFallbackPalette();
    const m = new PaletteMatcher(pal, { excludeRanges: [[16, 31]] });
    for (let i = 0; i < 256; i++) {
      const idx = m.find(pal.data[i * 3], pal.data[i * 3 + 1], pal.data[i * 3 + 2]);
      expect(idx < 16 || idx > 31).toBe(true);
    }
  });
});

describe('LZ4 block decompression (container 4.2P)', () => {
  it('giải nén literal + match có chồng lấn', () => {
    // token 0x35: 3 literal, match length 5+4 = 9; literals "abc"; offset = 3
    const block = Uint8Array.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00]);
    const out = lz4DecompressBlock(block, 12);
    expect(new TextDecoder().decode(out)).toBe('abcabcabcabc');
  });

  it('giải nén block chỉ có literal', () => {
    const block = Uint8Array.from([0x50, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(new TextDecoder().decode(lz4DecompressBlock(block, 5))).toBe('hello');
  });

  it('literal length mở rộng bằng byte 255', () => {
    const n = 300;
    const literals = new Uint8Array(n).fill(0x41);
    // litLen 15 → thêm 255 + 30 = 300
    const block = Uint8Array.from([0xf0, 0xff, 30, ...literals]);
    const out = lz4DecompressBlock(block, n);
    expect(out.length).toBe(n);
    expect(out.every((b) => b === 0x41)).toBe(true);
  });

  it('báo lỗi khi kích thước giải nén không khớp header', () => {
    const block = Uint8Array.from([0x50, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(() => lz4DecompressBlock(block, 99)).toThrow(SlpError);
  });

  it('báo lỗi khi match offset vượt quá dữ liệu đã giải nén', () => {
    const block = Uint8Array.from([0x15, 0x61, 0xff, 0x00]);
    expect(() => lz4DecompressBlock(block, 20)).toThrow(SlpError);
  });
});
