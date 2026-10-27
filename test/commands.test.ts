import { describe, expect, it } from 'vitest';
import { decodeRow } from '../src/core/commands';
import { SlpError } from '../src/core/types';

describe('decodeRow — ví dụ trong spec', () => {
  it('decode đúng chuỗi byte mẫu', () => {
    // prettier-ignore
    const data = Uint8Array.from([
      0x08, 0x55, 0xF4,
      0x19,
      0x28, 0x99, 0x35, 0xF4, 0x6D, 0x67, 0x6E, 0xA5, 0x01, 0x4D, 0x8E,
      0x0F,
    ]);

    const { tokens, end } = decodeRow(data, 0);

    expect(tokens.map((t) => t.type)).toEqual([
      'lesser_draw',
      'lesser_skip',
      'lesser_draw',
      'end_of_row',
    ]);

    // Lệnh 1: lesser draw 2 pixel [0x55, 0xF4]
    expect(tokens[0].count).toBe(2);
    expect(tokens[0].indices).toEqual([0x55, 0xf4]);

    // Lệnh 2: lesser skip 6 pixel
    expect(tokens[1].count).toBe(6);
    expect(tokens[1].indices).toBeUndefined();

    // Lệnh 3: lesser draw 10 pixel
    expect(tokens[2].count).toBe(10);
    expect(tokens[2].indices).toEqual([
      0x99, 0x35, 0xf4, 0x6d, 0x67, 0x6e, 0xa5, 0x01, 0x4d, 0x8e,
    ]);

    // Lệnh 4: end of row, đọc hết buffer
    expect(tokens[3].count).toBe(0);
    expect(end).toBe(data.length);
  });
});

describe('decodeRow — nhận diện lệnh', () => {
  it('greater draw dùng công thức ((cmd & 0xF0) << 4) + next', () => {
    const count = 0x123; // high nibble = 1, next = 0x23
    const bytes = [0x12, 0x23, ...new Array(count).fill(0x7f), 0x0f];
    const { tokens } = decodeRow(Uint8Array.from(bytes), 0);
    expect(tokens[0].type).toBe('greater_draw');
    expect(tokens[0].count).toBe(count);
    expect(tokens[0].indices).toHaveLength(count);
  });

  it('greater skip đọc count 12-bit', () => {
    const { tokens } = decodeRow(Uint8Array.from([0xf3, 0xff, 0x0f]), 0);
    expect(tokens[0].type).toBe('greater_skip');
    expect(tokens[0].count).toBe(0xfff);
  });

  it('0x0F là End of row chứ không phải greater skip', () => {
    const { tokens } = decodeRow(Uint8Array.from([0x0f]), 0);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('end_of_row');
  });

  it('fill lấy count từ nibble cao và chỉ đọc 1 giá trị màu', () => {
    const { tokens } = decodeRow(Uint8Array.from([0x57, 0xab, 0x0f]), 0);
    expect(tokens[0].type).toBe('fill');
    expect(tokens[0].count).toBe(5);
    expect(tokens[0].indices).toEqual([0xab]);
  });

  it('fill với nibble cao = 0 thì đọc count ở byte kế tiếp', () => {
    const { tokens } = decodeRow(Uint8Array.from([0x07, 0x64, 0xab, 0x0f]), 0);
    expect(tokens[0].type).toBe('fill');
    expect(tokens[0].count).toBe(100);
    expect(tokens[0].indices).toEqual([0xab]);
  });

  it('player color draw đọc N giá trị màu', () => {
    const { tokens } = decodeRow(Uint8Array.from([0x36, 0x10, 0x11, 0x12, 0x0f]), 0);
    expect(tokens[0].type).toBe('player_draw');
    expect(tokens[0].count).toBe(3);
    expect(tokens[0].indices).toEqual([0x10, 0x11, 0x12]);
  });

  it('fill player color chỉ đọc 1 index', () => {
    const { tokens } = decodeRow(Uint8Array.from([0x4a, 0x12, 0x0f]), 0);
    expect(tokens[0].type).toBe('fill_player');
    expect(tokens[0].count).toBe(4);
    expect(tokens[0].indices).toEqual([0x12]);
  });

  it('shadow draw đọc N shadow value', () => {
    const { tokens } = decodeRow(Uint8Array.from([0x2b, 0x40, 0x41, 0x0f]), 0);
    expect(tokens[0].type).toBe('shadow_draw');
    expect(tokens[0].count).toBe(2);
    expect(tokens[0].indices).toEqual([0x40, 0x41]);
  });

  it('extended outline commands', () => {
    const { tokens } = decodeRow(Uint8Array.from([0x4e, 0x5e, 0x03, 0x6e, 0x7e, 0x05, 0x0f]), 0);
    expect(tokens.map((t) => [t.type, t.count])).toEqual([
      ['ext_outline1', 1],
      ['ext_outline1_fill', 3],
      ['ext_outline2', 1],
      ['ext_outline2_fill', 5],
      ['end_of_row', 0],
    ]);
  });

  it('premultiplied alpha (0x9E) đảo alpha', () => {
    const { tokens } = decodeRow(Uint8Array.from([0x9e, 0x01, 0x10, 0x20, 0x30, 0x00, 0x0f]), 0);
    expect(tokens[0].type).toBe('ext_premultiplied_alpha');
    // BGRA 0x10,0x20,0x30,0x00 → RGBA (0x30, 0x20, 0x10, 255-0)
    expect(tokens[0].rgba).toEqual([0x30, 0x20, 0x10, 255]);
  });
});

describe('decodeRow — pixel 2 byte của version 4.1X', () => {
  it('modifierFirst = true đọc modifier trước index', () => {
    const { tokens } = decodeRow(Uint8Array.from([0x04, 0xaa, 0xbb, 0x0f]), 0, {
      pixelSize: 2,
      modifierFirst: true,
    });
    expect(tokens[0].indices).toEqual([0xbb]);
    expect(tokens[0].modifiers).toEqual([0xaa]);
  });

  it('modifierFirst = false đảo thứ tự byte', () => {
    const { tokens } = decodeRow(Uint8Array.from([0x04, 0xaa, 0xbb, 0x0f]), 0, {
      pixelSize: 2,
      modifierFirst: false,
    });
    expect(tokens[0].indices).toEqual([0xaa]);
    expect(tokens[0].modifiers).toEqual([0xbb]);
  });
});

describe('decodeRow — xử lý lỗi', () => {
  it('báo lỗi rõ ràng khi dữ liệu bị cắt cụt', () => {
    expect(() => decodeRow(Uint8Array.from([0x08, 0x55]), 0, { context: 'frame 1, dòng 2' })).toThrow(
      SlpError,
    );
    try {
      decodeRow(Uint8Array.from([0x08, 0x55]), 0, { context: 'frame 1, dòng 2' });
    } catch (err) {
      expect((err as SlpError).message).toContain('frame 1, dòng 2');
    }
  });

  it('báo lỗi khi thiếu End of row', () => {
    expect(() => decodeRow(Uint8Array.from([0x05, 0x05, 0x05]), 0)).toThrow(SlpError);
  });
});
