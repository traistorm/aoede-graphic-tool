import { SlpError } from './types';

/**
 * Decoder cho draw command của SLP.
 *
 * Nhận diện lệnh dựa trên bit thấp của `cmd_byte`, THỨ TỰ KIỂM TRA rất quan trọng:
 *   1. nibble thấp == 0x0F  → End of row  (nếu kiểm tra 2 bit thấp trước sẽ bị nhầm thành greater skip)
 *   2. 2 bit thấp == 0b00   → Lesser draw (nibble 0,4,8,C)
 *   3. 2 bit thấp == 0b01   → Lesser skip (nibble 1,5,9,D)
 *   4. còn lại: switch theo nibble thấp (2,3,6,7,A,B,E)
 */
export type CommandType =
  | 'lesser_draw'
  | 'lesser_skip'
  | 'greater_draw'
  | 'greater_skip'
  | 'player_draw'
  | 'fill'
  | 'fill_player'
  | 'shadow_draw'
  | 'ext_forward_draw'
  | 'ext_reverse_draw'
  | 'ext_normal_transform'
  | 'ext_alternate_transform'
  | 'ext_outline1'
  | 'ext_outline1_fill'
  | 'ext_outline2'
  | 'ext_outline2_fill'
  | 'ext_dither'
  | 'ext_premultiplied_alpha'
  | 'ext_original_alpha'
  | 'end_of_row';

export interface CommandToken {
  type: CommandType;
  /** Offset của cmd_byte trong buffer. */
  offset: number;
  /** Giá trị cmd_byte. */
  cmd: number;
  /** Số pixel mà lệnh này chiếm trên dòng. */
  count: number;
  /**
   * Palette index đọc kèm lệnh.
   * - draw: `count` phần tử
   * - fill: đúng 1 phần tử (lặp `count` lần)
   */
  indices?: number[];
  /** Display modifier tương ứng (chỉ version >= 4.1X, pixelSize = 2). */
  modifiers?: number[];
  /** RGBA cho SLP 32-bit (premultiplied alpha), 4 byte/pixel. */
  rgba?: number[];
}

export interface DecodeRowOptions {
  /**
   * Số byte cho một `px_color_value`:
   *  - 1: version <= 4.0X (palette index)
   *  - 2: version >= 4.1X (display modifier + palette index)
   *  - 4: SLP 32-bit (BGRA)
   */
  pixelSize?: 1 | 2 | 4;
  /**
   * Với pixelSize = 2: byte đầu là display modifier (true, theo spec) hay
   * palette index (false). Một số bộ SLP 4.1X dùng thứ tự ngược lại nên cho phép đổi.
   */
  modifierFirst?: boolean;
  /** Ngữ cảnh để ghép vào message lỗi, ví dụ "frame 3, dòng 12". */
  context?: string;
  /** Chặn vòng lặp vô hạn khi dữ liệu hỏng. */
  maxCommands?: number;
}

export interface DecodedRow {
  tokens: CommandToken[];
  /** Offset ngay sau byte End of row. */
  end: number;
}

const DEFAULT_MAX_COMMANDS = 65536;

/**
 * Decode một dòng draw command bắt đầu tại `start`, dừng sau byte End of row (0x0F).
 * Hàm thuần tuý — không cần DOM — nên test được trực tiếp.
 */
export function decodeRow(data: Uint8Array, start: number, options: DecodeRowOptions = {}): DecodedRow {
  const pixelSize = options.pixelSize ?? 1;
  const modifierFirst = options.modifierFirst ?? true;
  const ctx = options.context ? ` (${options.context})` : '';
  const maxCommands = options.maxCommands ?? DEFAULT_MAX_COMMANDS;
  const tokens: CommandToken[] = [];

  let p = start;

  const need = (n: number, what: string): void => {
    if (p + n > data.length) {
      throw new SlpError(
        `Dữ liệu draw command bị cắt cụt${ctx}.`,
        `Cần ${n} byte cho ${what} tại offset 0x${p.toString(16)} nhưng đã hết dữ liệu.`,
      );
    }
  };

  const readByte = (what: string): number => {
    need(1, what);
    return data[p++];
  };

  /** Đọc `n` pixel value, trả về {indices, modifiers, rgba}. */
  const readPixels = (
    n: number,
  ): { indices: number[]; modifiers?: number[]; rgba?: number[] } => {
    need(n * pixelSize, `${n} pixel`);
    const indices: number[] = new Array(n);
    if (pixelSize === 1) {
      for (let i = 0; i < n; i++) indices[i] = data[p++];
      return { indices };
    }
    if (pixelSize === 2) {
      const modifiers: number[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const a = data[p++];
        const b = data[p++];
        if (modifierFirst) {
          modifiers[i] = a;
          indices[i] = b;
        } else {
          indices[i] = a;
          modifiers[i] = b;
        }
      }
      return { indices, modifiers };
    }
    // pixelSize === 4 → BGRA
    const rgba: number[] = new Array(n * 4);
    for (let i = 0; i < n; i++) {
      const b = data[p++];
      const g = data[p++];
      const r = data[p++];
      const a = data[p++];
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = a;
      indices[i] = 0;
    }
    return { indices, rgba };
  };

  /** count = nibble cao của cmd, nếu = 0 thì đọc byte kế tiếp. */
  const nibbleCount = (cmd: number, what: string): number => {
    const high = cmd >>> 4;
    return high !== 0 ? high : readByte(`count của ${what}`);
  };

  for (let guard = 0; ; guard++) {
    if (guard > maxCommands) {
      throw new SlpError(
        `Dòng draw command quá dài, có thể file hỏng${ctx}.`,
        `Vượt quá ${maxCommands} lệnh mà chưa gặp End of row (0x0F).`,
      );
    }

    const offset = p;
    const cmd = readByte('cmd_byte');
    const lowNibble = cmd & 0x0f;
    const lowBits = cmd & 0x03;

    // 1. End of row
    if (lowNibble === 0x0f) {
      tokens.push({ type: 'end_of_row', offset, cmd, count: 0 });
      break;
    }

    // 2. Lesser draw: 0bXXXXXX00
    if (lowBits === 0x00) {
      const count = cmd >>> 2;
      const px = readPixels(count);
      tokens.push({ type: 'lesser_draw', offset, cmd, count, ...px });
      continue;
    }

    // 3. Lesser skip: 0bXXXXXX01
    if (lowBits === 0x01) {
      tokens.push({ type: 'lesser_skip', offset, cmd, count: cmd >>> 2 });
      continue;
    }

    switch (lowNibble) {
      // 4. Greater draw: 0bXXXX0010, count = ((cmd & 0xF0) << 4) + next
      case 0x02: {
        const next = readByte('greater draw count');
        const count = ((cmd & 0xf0) << 4) + next;
        const px = readPixels(count);
        tokens.push({ type: 'greater_draw', offset, cmd, count, ...px });
        break;
      }
      // 5. Greater skip: 0bXXXX0011
      case 0x03: {
        const next = readByte('greater skip count');
        const count = ((cmd & 0xf0) << 4) + next;
        tokens.push({ type: 'greater_skip', offset, cmd, count });
        break;
      }
      // 6. Player color draw
      case 0x06: {
        const count = nibbleCount(cmd, 'player color draw');
        const px = readPixels(count);
        tokens.push({ type: 'player_draw', offset, cmd, count, ...px });
        break;
      }
      // 7. Fill — 1 giá trị màu lặp N lần
      case 0x07: {
        const count = nibbleCount(cmd, 'fill');
        const px = readPixels(1);
        tokens.push({ type: 'fill', offset, cmd, count, ...px });
        break;
      }
      // 8. Fill player color
      case 0x0a: {
        const count = nibbleCount(cmd, 'fill player color');
        const px = readPixels(1);
        tokens.push({ type: 'fill_player', offset, cmd, count, ...px });
        break;
      }
      // 9. Shadow draw
      case 0x0b: {
        const count = nibbleCount(cmd, 'shadow draw');
        const px = readPixels(count);
        tokens.push({ type: 'shadow_draw', offset, cmd, count, ...px });
        break;
      }
      // 10. Extended — phân biệt bởi nibble cao
      case 0x0e: {
        tokens.push(readExtended(cmd, offset));
        break;
      }
      default:
        throw new SlpError(
          `Gặp draw command không hợp lệ${ctx}.`,
          `cmd_byte = 0x${cmd.toString(16).padStart(2, '0')} tại offset 0x${offset.toString(16)}.`,
        );
    }
  }

  return { tokens, end: p };

  function readExtended(cmd: number, offset: number): CommandToken {
    switch (cmd) {
      case 0x0e:
        return { type: 'ext_forward_draw', offset, cmd, count: 0 };
      case 0x1e:
        return { type: 'ext_reverse_draw', offset, cmd, count: 0 };
      case 0x2e:
        return { type: 'ext_normal_transform', offset, cmd, count: 0 };
      case 0x3e:
        return { type: 'ext_alternate_transform', offset, cmd, count: 0 };
      case 0x4e:
        return { type: 'ext_outline1', offset, cmd, count: 1 };
      case 0x5e: {
        const count = readByte('outline 1 fill count');
        return { type: 'ext_outline1_fill', offset, cmd, count };
      }
      case 0x6e:
        return { type: 'ext_outline2', offset, cmd, count: 1 };
      case 0x7e: {
        const count = readByte('outline 2 fill count');
        return { type: 'ext_outline2_fill', offset, cmd, count };
      }
      case 0x8e:
        return { type: 'ext_dither', offset, cmd, count: 0 };
      case 0x9e: {
        const count = readByte('premultiplied alpha count');
        need(count * 4, `${count} pixel BGRA`);
        const rgba: number[] = new Array(count * 4);
        for (let i = 0; i < count; i++) {
          const b = data[p++];
          const g = data[p++];
          const r = data[p++];
          const a = data[p++];
          rgba[i * 4] = r;
          rgba[i * 4 + 1] = g;
          rgba[i * 4 + 2] = b;
          // Alpha bị đảo trong lệnh này.
          rgba[i * 4 + 3] = 255 - a;
        }
        return { type: 'ext_premultiplied_alpha', offset, cmd, count, rgba };
      }
      case 0xae:
        return { type: 'ext_original_alpha', offset, cmd, count: 0 };
      default:
        throw new SlpError(
          `Gặp extended command chưa hỗ trợ${ctx}.`,
          `cmd_byte = 0x${cmd.toString(16).padStart(2, '0')} tại offset 0x${offset.toString(16)}.`,
        );
    }
  }
}

/** Số pixel mà một chuỗi token chiếm trên dòng (dùng để kiểm tra khớp width). */
export function rowPixelCount(tokens: CommandToken[]): number {
  return tokens.reduce((sum, t) => sum + t.count, 0);
}
