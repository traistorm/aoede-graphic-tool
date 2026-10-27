import { describe, expect, it } from 'vitest';
import { parseSlp } from '../src/core/slpReader';
import { encodeRow, validateRoundTrip, writeSlp, type WritableFrame } from '../src/core/slpWriter';
import { decodeRow } from '../src/core/commands';
import { PixelKind, SlpError } from '../src/core/types';

/** Tạo frame test từ hàm sinh pixel. */
function makeFrame(
  width: number,
  height: number,
  gen: (x: number, y: number) => { kind: PixelKind; value: number },
  hotspot?: { x: number; y: number },
): WritableFrame {
  const kind = new Uint8Array(width * height);
  const value = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const px = gen(x, y);
      kind[p] = px.kind;
      value[p] = px.kind === PixelKind.Transparent ? 0 : px.value;
    }
  }
  return {
    width,
    height,
    hotspotX: hotspot?.x ?? Math.floor(width / 2),
    hotspotY: hotspot?.y ?? Math.floor(height / 2),
    kind,
    value,
  };
}

const T = { kind: PixelKind.Transparent, value: 0 };

describe('encodeRow', () => {
  it('dòng trong suốt hoàn toàn không sinh command nào', () => {
    const frame = makeFrame(8, 1, () => T);
    const row = encodeRow(frame, 0);
    expect(row.fullyTransparent).toBe(true);
    expect(row.bytes).toHaveLength(0);
  });

  it('tính left_space / right_space theo vùng trong suốt hai đầu', () => {
    const frame = makeFrame(10, 1, (x) =>
      x >= 3 && x <= 6 ? { kind: PixelKind.Palette, value: 40 + x } : T,
    );
    const row = encodeRow(frame, 0);
    expect(row.fullyTransparent).toBe(false);
    expect(row.leftSpace).toBe(3);
    expect(row.rightSpace).toBe(3);
    expect(row.bytes[row.bytes.length - 1]).toBe(0x0f);
  });

  it('dùng Fill khi >= 3 pixel cùng màu liên tiếp', () => {
    const frame = makeFrame(5, 1, () => ({ kind: PixelKind.Palette, value: 0x2a }));
    const row = encodeRow(frame, 0);
    // 0x57 = count 5 ở nibble cao + lệnh fill (0x07), rồi 1 byte màu, rồi 0x0F
    expect(Array.from(row.bytes)).toEqual([0x57, 0x2a, 0x0f]);
  });

  it('dùng Lesser draw cho block màu không lặp', () => {
    const colors = [10, 20, 30, 40];
    const frame = makeFrame(4, 1, (x) => ({ kind: PixelKind.Palette, value: colors[x] }));
    const row = encodeRow(frame, 0);
    expect(Array.from(row.bytes)).toEqual([(4 << 2) | 0x00, 10, 20, 30, 40, 0x0f]);
  });

  it('dùng Greater draw khi block > 63 pixel', () => {
    const width = 200;
    const frame = makeFrame(width, 1, (x) => ({ kind: PixelKind.Palette, value: (x * 7) % 251 }));
    const row = encodeRow(frame, 0);
    const { tokens } = decodeRow(row.bytes, 0);
    expect(tokens[0].type).toBe('greater_draw');
    expect(tokens[0].count).toBe(width);
  });

  it('dùng skip cho khoảng trong suốt ở giữa dòng', () => {
    const frame = makeFrame(20, 1, (x) =>
      x === 0 || x === 19 ? { kind: PixelKind.Palette, value: 5 } : T,
    );
    const { tokens } = decodeRow(encodeRow(frame, 0).bytes, 0);
    expect(tokens.map((t) => t.type)).toEqual([
      'lesser_draw',
      'lesser_skip',
      'lesser_draw',
      'end_of_row',
    ]);
    expect(tokens[1].count).toBe(18);
  });

  it('encode player color và shadow bằng đúng lệnh chuyên dụng', () => {
    const frame = makeFrame(6, 1, (x) => {
      if (x < 3) return { kind: PixelKind.Player, value: 16 };
      return { kind: PixelKind.Shadow, value: 60 };
    });
    const { tokens } = decodeRow(encodeRow(frame, 0).bytes, 0);
    expect(tokens.map((t) => t.type)).toEqual(['fill_player', 'shadow_draw', 'end_of_row']);
  });

  it('báo lỗi khi palette index vượt 1 byte', () => {
    const frame = makeFrame(2, 1, () => ({ kind: PixelKind.Palette, value: 300 }));
    expect(() => encodeRow(frame, 0, 3, 'frame 0')).toThrow(SlpError);
  });
});

describe('writeSlp + parseSlp round-trip', () => {
  const patterns: Array<{ name: string; frames: WritableFrame[] }> = [
    {
      name: 'gradient đặc',
      frames: [makeFrame(32, 24, (x, y) => ({ kind: PixelKind.Palette, value: (x + y) % 250 + 1 }))],
    },
    {
      name: 'hình tròn có alpha',
      frames: [
        makeFrame(40, 40, (x, y) => {
          const dx = x - 20;
          const dy = y - 20;
          return dx * dx + dy * dy <= 15 * 15 ? { kind: PixelKind.Palette, value: 100 } : T;
        }),
      ],
    },
    {
      name: 'dòng trống xen kẽ',
      frames: [
        makeFrame(16, 8, (_x, y) => (y % 2 === 0 ? { kind: PixelKind.Palette, value: 7 } : T)),
      ],
    },
    {
      name: 'trộn player color / shadow / outline',
      frames: [
        makeFrame(24, 6, (x, y) => {
          if (y === 0) return T;
          if (y === 1) return { kind: PixelKind.Player, value: 16 + (x % 8) };
          if (y === 2) return { kind: PixelKind.Shadow, value: 50 + (x % 4) };
          if (y === 3) return { kind: PixelKind.OutlinePlayer, value: 0 };
          if (y === 4) return { kind: PixelKind.OutlineSpecial, value: 243 };
          return x % 3 === 0 ? T : { kind: PixelKind.Palette, value: 200 };
        }),
      ],
    },
    {
      name: 'frame rộng > 4095 pixel (chunk greater draw)',
      frames: [makeFrame(5000, 2, (x) => ({ kind: PixelKind.Palette, value: (x % 254) + 1 }))],
    },
    {
      name: 'nhiều frame kích thước khác nhau',
      frames: [
        makeFrame(10, 10, () => ({ kind: PixelKind.Palette, value: 3 })),
        makeFrame(5, 20, (x, y) => (x === y % 5 ? { kind: PixelKind.Palette, value: 9 } : T)),
        makeFrame(1, 1, () => ({ kind: PixelKind.Palette, value: 255 })),
      ],
    },
  ];

  for (const version of ['2.0N', '4.0X'] as const) {
    for (const { name, frames } of patterns) {
      it(`${version}: ${name}`, () => {
        const buffer = writeSlp(frames, { version });
        const result = validateRoundTrip(buffer, frames);
        expect(result.issues.slice(0, 3)).toEqual([]);
        expect(result.ok).toBe(true);

        const parsed = parseSlp(buffer);
        expect(parsed.version).toBe(version);
        expect(parsed.header.numFrames).toBe(frames.length);
        expect(parsed.warnings).toEqual([]);
        expect(parsed.frames[0].main.width).toBe(frames[0].width);
        expect(parsed.frames[0].main.hotspotX).toBe(frames[0].hotspotX);
      });
    }
  }

  it('giữ nguyên hotspot tuỳ chỉnh', () => {
    const f = makeFrame(8, 8, () => ({ kind: PixelKind.Palette, value: 1 }), { x: -3, y: 17 });
    const parsed = parseSlp(writeSlp([f]));
    expect(parsed.frames[0].main.hotspotX).toBe(-3);
    expect(parsed.frames[0].main.hotspotY).toBe(17);
  });

  it('ghi comment vào header 2.0N', () => {
    const f = makeFrame(4, 4, () => ({ kind: PixelKind.Palette, value: 1 }));
    const parsed = parseSlp(writeSlp([f], { comment: 'hello slp' }));
    expect(parsed.header.comment).toBe('hello slp');
  });

  it('4.0X ghi và đọc lại được layer phụ (shadow)', () => {
    const main = makeFrame(12, 12, () => ({ kind: PixelKind.Palette, value: 42 }));
    const shadowKind = new Uint8Array(12 * 12).fill(PixelKind.Palette);
    const shadowValue = new Uint16Array(12 * 12).fill(20);
    main.secondary = {
      width: 12,
      height: 12,
      hotspotX: 6,
      hotspotY: 6,
      kind: shadowKind,
      value: shadowValue,
      frameType: 0x02,
    };

    const parsed = parseSlp(writeSlp([main], { version: '4.0X', type: 0x02 }));
    expect(parsed.header.offsetSecondary).toBeGreaterThan(0);
    expect(parsed.frames[0].secondary).toBeDefined();
    expect(parsed.frames[0].secondary!.frameType).toBe(0x02);
    expect(parsed.frames[0].secondary!.value[0]).toBe(20);
  });

  it('validateRoundTrip chỉ ra frame/dòng/cột khi dữ liệu lệch', () => {
    const frames = [makeFrame(4, 4, () => ({ kind: PixelKind.Palette, value: 1 }))];
    const buffer = writeSlp(frames);
    // Cố tình sửa dữ liệu gốc để tạo sai lệch
    const tampered = [
      {
        ...frames[0],
        value: Uint16Array.from(frames[0].value).fill(9, 5, 6),
      },
    ];
    const result = validateRoundTrip(buffer, tampered);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({ frame: 0, row: 1, column: 1 });
  });

  it('báo lỗi khi không có frame nào', () => {
    expect(() => writeSlp([])).toThrow(SlpError);
  });
});

describe('parseSlp — xử lý lỗi', () => {
  it('từ chối version không hỗ trợ với message rõ ràng', () => {
    const buf = new Uint8Array(64);
    buf.set([0x33, 0x2e, 0x37, 0x58]); // "3.7X"
    expect(() => parseSlp(buf)).toThrow(/không được hỗ trợ/);
  });

  it('báo lỗi khi file quá nhỏ', () => {
    expect(() => parseSlp(new Uint8Array(2))).toThrow(SlpError);
  });

  it('báo lỗi khi num_frames vô lý', () => {
    const buf = new Uint8Array(64);
    buf.set([0x32, 0x2e, 0x30, 0x4e]); // "2.0N"
    new DataView(buf.buffer).setInt32(4, 999_999_999, true);
    expect(() => parseSlp(buf)).toThrow(/Số lượng frame/);
    try {
      parseSlp(buf);
    } catch (err) {
      expect((err as SlpError).detail).toContain('num_frames');
    }
  });
});

describe('container 4.2P', () => {
  it('giải nén LZ4 rồi parse ra version bên trong', async () => {
    const frames = [makeFrame(16, 16, (x, y) => ({ kind: PixelKind.Palette, value: (x ^ y) % 200 + 1 }))];
    const inner = writeSlp(frames, { version: '2.0N' });

    // Nén "giả" bằng LZ4 block chỉ gồm literal (hợp lệ theo spec block format).
    const compressed = lz4LiteralOnly(inner);
    const container = new Uint8Array(8 + compressed.length);
    container.set([0x34, 0x2e, 0x32, 0x50]); // "4.2P"
    new DataView(container.buffer).setUint32(4, inner.length, true);
    container.set(compressed, 8);

    const parsed = parseSlp(container);
    expect(parsed.containerVersion).toBe('4.2P');
    expect(parsed.compressed).toBe(true);
    expect(parsed.version).toBe('2.0N');
    expect(parsed.frames[0].main.width).toBe(16);
  });
});

/** Đóng gói dữ liệu thành LZ4 block chỉ gồm literal (không nén thật). */
function lz4LiteralOnly(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const chunk = Math.min(data.length - i, 1 << 16);
    if (chunk < 15) {
      out.push(chunk << 4);
    } else {
      out.push(0xf0);
      let rest = chunk - 15;
      while (rest >= 255) {
        out.push(255);
        rest -= 255;
      }
      out.push(rest);
    }
    for (let k = 0; k < chunk; k++) out.push(data[i + k]);
    i += chunk;
  }
  return Uint8Array.from(out);
}
