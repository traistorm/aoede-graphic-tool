import { ByteReader } from './binary';
import { decodeRow, type CommandToken, type DecodeRowOptions } from './commands';
import { isLz4Frame, lz4DecompressBlock } from './lz4';
import {
  OUTLINE_SPECIAL_INDEX,
  PixelKind,
  SlpError,
  type IndexedLayer,
  type SecondaryFrameInfo,
  type SlpFile,
  type SlpFrame,
  type SlpFrameInfo,
  type SlpHeader,
} from './types';

export interface ParseOptions {
  /**
   * Thứ tự byte của px_color_value ở version 4.1X.
   * true  = display modifier trước, palette index sau (theo spec).
   * false = palette index trước.
   */
  modifierFirst?: boolean;
  /** Ép pixel size (dùng cho SLP 32-bit); mặc định suy ra từ version. */
  pixelSizeOverride?: 1 | 2 | 4;
  /** Số cảnh báo tối đa gom lại trước khi dừng ghi log. */
  maxWarnings?: number;
}

const HEADER_SIZE_V3 = 32;
const HEADER_SIZE_V4 = 32;
const ROW_FULLY_TRANSPARENT = 0x8000;

/** Điểm vào chính: nhận nội dung file `.slp` và trả về cấu trúc đã decode. */
export function parseSlp(source: ArrayBuffer | Uint8Array, options: ParseOptions = {}): SlpFile {
  const raw = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (raw.length < 4) {
    throw new SlpError('File quá nhỏ, không phải file SLP.', `Chỉ có ${raw.length} byte.`);
  }

  const containerVersion = readVersionString(raw, 0);

  // --- 4.2P: container LZ4 bọc ngoài một file SLP bình thường ---
  if (containerVersion === '4.2P') {
    if (raw.length < 8) {
      throw new SlpError('File 4.2P hỏng: thiếu trường uncompressed size.', `File chỉ có ${raw.length} byte.`);
    }
    const uncompressedSize = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(4, true);
    const payload = raw.subarray(8);
    if (isLz4Frame(payload)) {
      throw new SlpError(
        'File 4.2P dùng LZ4 frame format, không phải block format.',
        'Định dạng SLP 4.2P chuẩn dùng LZ4 block. File này có thể đã bị đóng gói lại bằng công cụ khác.',
      );
    }
    const inner = lz4DecompressBlock(payload, uncompressedSize);
    const parsed = parseSlp(inner, options);
    return { ...parsed, containerVersion: '4.2P', compressed: true };
  }

  const isV4 = containerVersion.startsWith('4');
  const isV3OrLower = containerVersion === '2.0N' || containerVersion.startsWith('3.0') || containerVersion === '2.0';

  if (!isV4 && !isV3OrLower) {
    throw new SlpError(
      `Version SLP không được hỗ trợ: "${containerVersion}".`,
      'App này chỉ hỗ trợ 2.0N, 3.0, 4.0X, 4.1X và 4.2P (các version dùng bởi AoE1 và AoE1:DE).',
    );
  }

  const reader = new ByteReader(raw);
  const warnings: string[] = [];
  const header = isV4 ? readHeaderV4(reader) : readHeaderV3(reader);

  if (header.numFrames < 0 || header.numFrames > 100000) {
    throw new SlpError(
      'Số lượng frame trong header không hợp lệ.',
      `num_frames = ${header.numFrames}. File có thể bị hỏng hoặc không phải SLP.`,
    );
  }

  const pixelSize = options.pixelSizeOverride ?? (containerVersion === '4.1X' ? 2 : 1);
  const decodeOpts: DecodeRowOptions = {
    pixelSize,
    modifierFirst: options.modifierFirst ?? true,
  };

  // --- Frame info array ---
  const mainInfoOffset = isV4 ? (header.offsetMain || HEADER_SIZE_V4) : HEADER_SIZE_V3;
  const frameInfos = readFrameInfos(reader, mainInfoOffset, header.numFrames);

  let secondaryInfos: SecondaryFrameInfo[] | undefined;
  if (isV4 && header.offsetSecondary && header.offsetSecondary > 0) {
    try {
      secondaryInfos = readSecondaryFrameInfos(reader, header.offsetSecondary, header.numFrames);
    } catch (err) {
      warnings.push(
        `Không đọc được secondary frame info tại 0x${header.offsetSecondary.toString(16)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const frames: SlpFrame[] = [];
  for (let i = 0; i < header.numFrames; i++) {
    const info = frameInfos[i];
    const main = decodeLayer(reader, info, i, 'main', decodeOpts, warnings, options.maxWarnings ?? 50);
    const frame: SlpFrame = { index: i, info, main };

    const secInfo = secondaryInfos?.[i];
    if (secInfo && secInfo.width > 0 && secInfo.height > 0 && secInfo.cmdTableOffset > 0) {
      try {
        // Layer phụ luôn dùng 1 byte/pixel (shadow value).
        const layer = decodeLayer(
          reader,
          secInfo,
          i,
          'secondary',
          { pixelSize: 1, modifierFirst: false },
          warnings,
          options.maxWarnings ?? 50,
        );
        frame.secondaryInfo = secInfo;
        frame.secondary = { ...layer, frameType: secInfo.frameType };
      } catch (err) {
        warnings.push(
          `Frame ${i}: bỏ qua layer phụ vì lỗi — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    frames.push(frame);
  }

  return {
    containerVersion,
    version: containerVersion,
    compressed: false,
    header,
    frames,
    warnings,
    byteLength: raw.length,
  };
}

function readVersionString(bytes: Uint8Array, offset: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const c = bytes[offset + i];
    if (c === 0) continue;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** struct slp_header: char version[4]; int32 num_frames; char comment[24]; */
function readHeaderV3(reader: ByteReader): SlpHeader {
  reader.seek(0, 'header');
  const version = reader.ascii(4, 'version');
  const numFrames = reader.i32('num_frames');
  const comment = reader.ascii(24, 'comment');
  return { version, numFrames, comment };
}

/** struct slp_header_v4 — 32 byte. */
function readHeaderV4(reader: ByteReader): SlpHeader {
  reader.seek(0, 'header v4');
  const version = reader.ascii(4, 'version');
  const numFrames = reader.u16('num_frames');
  const type = reader.u16('type');
  const numDirections = reader.u16('num_directions');
  const framesPerDirection = reader.u16('frames_per_direction');
  const paletteId = reader.i32('palette_id');
  const offsetMain = reader.i32('offset_main');
  const offsetSecondary = reader.i32('offset_secondary');
  // 8 byte padding
  return {
    version,
    numFrames,
    type,
    numDirections,
    framesPerDirection,
    paletteId,
    offsetMain,
    offsetSecondary,
  };
}

function readFrameInfos(reader: ByteReader, offset: number, count: number): SlpFrameInfo[] {
  reader.seek(offset, 'frame info table');
  const out: SlpFrameInfo[] = [];
  for (let i = 0; i < count; i++) {
    const ctx = `frame info ${i}`;
    out.push({
      cmdTableOffset: reader.u32(ctx),
      outlineTableOffset: reader.u32(ctx),
      paletteOffset: reader.u32(ctx),
      properties: reader.u32(ctx),
      width: reader.i32(ctx),
      height: reader.i32(ctx),
      hotspotX: reader.i32(ctx),
      hotspotY: reader.i32(ctx),
    });
  }
  return out;
}

function readSecondaryFrameInfos(
  reader: ByteReader,
  offset: number,
  count: number,
): SecondaryFrameInfo[] {
  reader.seek(offset, 'secondary frame info table');
  const out: SecondaryFrameInfo[] = [];
  for (let i = 0; i < count; i++) {
    const ctx = `secondary frame info ${i}`;
    out.push({
      cmdTableOffset: reader.u32(ctx),
      outlineTableOffset: reader.u32(ctx),
      nullField: reader.u32(ctx),
      properties: reader.u24(ctx),
      frameType: reader.u8(ctx),
      width: reader.i32(ctx),
      height: reader.i32(ctx),
      hotspotX: reader.i32(ctx),
      hotspotY: reader.i32(ctx),
    });
  }
  return out;
}

interface LayerSource {
  cmdTableOffset: number;
  outlineTableOffset: number;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
}

/** Decode một layer (chính hoặc phụ) thành mảng pixel phẳng. */
function decodeLayer(
  reader: ByteReader,
  info: LayerSource,
  frameIndex: number,
  which: 'main' | 'secondary',
  decodeOpts: DecodeRowOptions,
  warnings: string[],
  maxWarnings: number,
): IndexedLayer {
  const { width, height } = info;
  if (width < 0 || height < 0 || width > 20000 || height > 20000) {
    throw new SlpError(
      `Frame ${frameIndex} có kích thước không hợp lệ.`,
      `width=${width}, height=${height} (layer ${which}).`,
    );
  }

  const total = width * height;
  const layer: IndexedLayer = {
    width,
    height,
    hotspotX: info.hotspotX,
    hotspotY: info.hotspotY,
    kind: new Uint8Array(total),
    value: new Uint16Array(total),
  };
  if (total === 0) return layer;

  const usesModifier = (decodeOpts.pixelSize ?? 1) === 2;
  if (usesModifier) layer.modifier = new Uint8Array(total);

  // --- Outline table ---
  reader.seek(info.outlineTableOffset, `outline table frame ${frameIndex} (${which})`);
  const leftSpace = new Int32Array(height);
  const rightSpace = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    leftSpace[y] = reader.u16(`outline table frame ${frameIndex} dòng ${y}`);
    rightSpace[y] = reader.u16(`outline table frame ${frameIndex} dòng ${y}`);
  }

  // --- Command offset table ---
  reader.seek(info.cmdTableOffset, `command offset table frame ${frameIndex} (${which})`);
  const cmdOffsets = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    cmdOffsets[y] = reader.u32(`command offset table frame ${frameIndex} dòng ${y}`);
  }

  const warn = (msg: string): void => {
    if (warnings.length < maxWarnings) warnings.push(msg);
    else if (warnings.length === maxWarnings) warnings.push('… (còn nhiều cảnh báo nữa, đã lược bớt)');
  };

  for (let y = 0; y < height; y++) {
    const left = leftSpace[y];
    const right = rightSpace[y];

    // Dòng trong suốt hoàn toàn → không có command byte nào cho dòng này.
    if (left === ROW_FULLY_TRANSPARENT || right === ROW_FULLY_TRANSPARENT) continue;

    const { tokens } = decodeRow(reader.bytes, cmdOffsets[y], {
      ...decodeOpts,
      context: `frame ${frameIndex}, dòng ${y}, layer ${which}`,
    });

    const painted = paintRow(layer, y, left, tokens, which);
    const expected = width - left - right;
    if (painted !== expected) {
      warn(
        `Frame ${frameIndex} dòng ${y} (${which}): vẽ ${painted} pixel nhưng outline table khai báo ${expected} ` +
          `(width=${width}, left=${left}, right=${right}).`,
      );
    }
  }

  return layer;
}

/** Áp chuỗi token lên một dòng của layer, trả về số pixel đã đi qua. */
function paintRow(
  layer: IndexedLayer,
  y: number,
  startX: number,
  tokens: CommandToken[],
  which: 'main' | 'secondary',
): number {
  const { width, kind, value, modifier } = layer;
  let x = startX;
  const rowBase = y * width;

  const put = (kindValue: PixelKind, paletteIndex: number, mod?: number): void => {
    if (x >= 0 && x < width) {
      kind[rowBase + x] = kindValue;
      value[rowBase + x] = paletteIndex;
      if (modifier && mod !== undefined) modifier[rowBase + x] = mod;
    }
    x++;
  };

  const ensureRgba = (): Uint8ClampedArray => {
    if (!layer.rgba) layer.rgba = new Uint8ClampedArray(width * layer.height * 4);
    return layer.rgba;
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'lesser_draw':
      case 'greater_draw': {
        for (let i = 0; i < token.count; i++) {
          if (token.rgba) {
            const rgba = ensureRgba();
            const p = (rowBase + x) * 4;
            if (x >= 0 && x < width) {
              rgba[p] = token.rgba[i * 4];
              rgba[p + 1] = token.rgba[i * 4 + 1];
              rgba[p + 2] = token.rgba[i * 4 + 2];
              rgba[p + 3] = token.rgba[i * 4 + 3];
            }
            put(PixelKind.Direct, 0);
          } else {
            put(PixelKind.Palette, token.indices![i], token.modifiers?.[i]);
          }
        }
        break;
      }
      case 'lesser_skip':
      case 'greater_skip':
        x += token.count;
        break;
      case 'player_draw':
        for (let i = 0; i < token.count; i++) {
          put(PixelKind.Player, token.indices![i], token.modifiers?.[i]);
        }
        break;
      case 'fill': {
        const idx = token.indices![0];
        const mod = token.modifiers?.[0];
        for (let i = 0; i < token.count; i++) put(PixelKind.Palette, idx, mod);
        break;
      }
      case 'fill_player': {
        const idx = token.indices![0];
        for (let i = 0; i < token.count; i++) put(PixelKind.Player, idx);
        break;
      }
      case 'shadow_draw':
        for (let i = 0; i < token.count; i++) put(PixelKind.Shadow, token.indices![i]);
        break;
      case 'ext_outline1':
      case 'ext_outline1_fill':
        for (let i = 0; i < token.count; i++) put(PixelKind.OutlinePlayer, 0);
        break;
      case 'ext_outline2':
      case 'ext_outline2_fill':
        for (let i = 0; i < token.count; i++) put(PixelKind.OutlineSpecial, OUTLINE_SPECIAL_INDEX);
        break;
      case 'ext_premultiplied_alpha': {
        const rgba = ensureRgba();
        for (let i = 0; i < token.count; i++) {
          if (x >= 0 && x < width) {
            const p = (rowBase + x) * 4;
            rgba[p] = token.rgba![i * 4];
            rgba[p + 1] = token.rgba![i * 4 + 1];
            rgba[p + 2] = token.rgba![i * 4 + 2];
            rgba[p + 3] = token.rgba![i * 4 + 3];
          }
          put(PixelKind.Direct, 0);
        }
        break;
      }
      // Các lệnh không sinh pixel.
      case 'ext_forward_draw':
      case 'ext_reverse_draw':
      case 'ext_normal_transform':
      case 'ext_alternate_transform':
      case 'ext_dither':
      case 'ext_original_alpha':
      case 'end_of_row':
        break;
    }
  }

  void which;
  return x - startX;
}
