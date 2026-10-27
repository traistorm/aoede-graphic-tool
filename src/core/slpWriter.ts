import { ByteWriter } from './binary';
import { parseSlp } from './slpReader';
import { PixelKind, SlpError, type IndexedLayer } from './types';

/** Một frame đầu vào cho writer (đã ở dạng palette index). */
export interface WritableFrame {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  /** PixelKind cho từng pixel. */
  kind: Uint8Array;
  /** Palette index / player base index / shadow value. */
  value: Uint16Array;
  /** Giữ nguyên frame_info.properties / palette ID khi xuất file đã chỉnh. */
  properties?: number;
  /** Layer phụ (chỉ dùng khi ghi 4.0X). */
  secondary?: {
    width: number;
    height: number;
    hotspotX: number;
    hotspotY: number;
    kind: Uint8Array;
    value: Uint16Array;
    /** 0x02 Shadow (mặc định), 0x08 VFX Alpha... */
    frameType?: number;
    properties?: number;
  };
}

export type WriteVersion = '2.0N' | '4.0X';

export interface WriteOptions {
  version?: WriteVersion;
  /** Comment 24 byte, chỉ dùng cho version <= 3.0. */
  comment?: string;
  /** Trường `type` của header v4. */
  type?: number;
  paletteId?: number;
  numDirections?: number;
  framesPerDirection?: number;
  /** Ghi layer phụ khi có (chỉ 4.0X). */
  includeSecondary?: boolean;
  /** Ngưỡng số pixel giống nhau liên tiếp để dùng lệnh Fill. */
  fillThreshold?: number;
}

const HEADER_SIZE = 32;
const ROW_FULLY_TRANSPARENT = 0x8000;
const MAX_GREATER_COUNT = 0xfff; // ((0xF0) << 4) + 0xFF
const MAX_BYTE_COUNT = 0xff;
const MAX_LESSER_COUNT = 0x3f;
const MAX_NIBBLE_COUNT = 0x0f;

/**
 * Ghi danh sách frame ra buffer `.slp`.
 *
 * Bố cục:
 *   header → frame info array → (outline table + command offset table + command data) từng frame
 *   → [4.0X + secondary] secondary frame info array → dữ liệu layer phụ
 * Các offset trong frame info được patch lại sau khi biết vị trí thực tế.
 */
export function writeSlp(frames: WritableFrame[], options: WriteOptions = {}): Uint8Array {
  const version = options.version ?? '2.0N';
  if (frames.length === 0) {
    throw new SlpError('Không có frame nào để ghi.', 'Hãy nạp ít nhất một ảnh PNG.');
  }
  if (version === '2.0N' && frames.length > 0x7fffffff) {
    throw new SlpError('Quá nhiều frame.', `num_frames = ${frames.length}`);
  }
  if (version === '4.0X' && frames.length > 0xffff) {
    throw new SlpError('Version 4.0X chỉ chứa tối đa 65535 frame.', `num_frames = ${frames.length}`);
  }

  for (const [i, f] of frames.entries()) {
    validateFrame(f, i);
  }

  const writeSecondary =
    version === '4.0X' && (options.includeSecondary ?? true) && frames.some((f) => f.secondary);

  const w = new ByteWriter(1 << 18);

  // --- Header ---
  if (version === '2.0N') {
    w.ascii('2.0N', 4);
    w.i32(frames.length);
    w.ascii(options.comment ?? 'Created by SLP Studio', 24);
  } else {
    w.ascii('4.0X', 4);
    w.u16(frames.length);
    w.u16(options.type ?? 0x00);
    w.u16(options.numDirections ?? 1);
    w.u16(options.framesPerDirection ?? frames.length);
    w.i32(options.paletteId ?? 0);
    w.i32(HEADER_SIZE); // offset_main
    w.i32(0); // offset_secondary — patch sau
    w.zeros(8);
  }
  const offsetSecondaryPos = version === '4.0X' ? 4 + 2 * 4 + 4 + 4 : -1;

  // --- Frame info array (offset sẽ patch lại) ---
  const frameInfoPos: number[] = [];
  for (const f of frames) {
    frameInfoPos.push(w.length);
    w.u32(0); // cmd_table_offset
    w.u32(0); // outline_table_offset
    w.u32(0); // palette_offset (unused)
    w.u32(f.properties ?? (version === '4.0X' ? (options.paletteId ?? 0) : 0)); // properties
    w.i32(f.width);
    w.i32(f.height);
    w.i32(f.hotspotX);
    w.i32(f.hotspotY);
  }

  // --- Dữ liệu từng frame ---
  const fillThreshold = options.fillThreshold ?? 3;
  for (const [i, f] of frames.entries()) {
    const encoded = encodeLayerRows(
      { width: f.width, height: f.height, kind: f.kind, value: f.value },
      fillThreshold,
      `frame ${i}`,
    );

    const outlineTableOffset = w.length;
    for (let y = 0; y < f.height; y++) {
      w.u16(encoded.leftSpace[y]);
      w.u16(encoded.rightSpace[y]);
    }

    const cmdTableOffset = w.length;
    const cmdDataStart = cmdTableOffset + 4 * f.height;
    for (let y = 0; y < f.height; y++) {
      w.u32(cmdDataStart + encoded.rowOffsets[y]);
    }
    w.bytes(encoded.data);

    w.patchU32(frameInfoPos[i], cmdTableOffset);
    w.patchU32(frameInfoPos[i] + 4, outlineTableOffset);
  }

  // --- Layer phụ (chỉ 4.0X) ---
  if (writeSecondary) {
    w.align(4);
    const secondaryTableOffset = w.length;
    w.patchU32(offsetSecondaryPos, secondaryTableOffset);

    const secInfoPos: number[] = [];
    for (const f of frames) {
      const s = f.secondary;
      secInfoPos.push(w.length);
      w.u32(0); // sec_cmd_table_offset
      w.u32(0); // sec_outline_table_offset
      w.u32(0); // sec_null
      w.u24(s?.properties ?? 0); // sec_properties
      w.u8(s?.frameType ?? 0x02); // sec_frame_type
      w.i32(s?.width ?? 0);
      w.i32(s?.height ?? 0);
      w.i32(s?.hotspotX ?? 0);
      w.i32(s?.hotspotY ?? 0);
    }

    for (const [i, f] of frames.entries()) {
      const s = f.secondary;
      if (!s) continue;
      const encoded = encodeLayerRows(
        { width: s.width, height: s.height, kind: s.kind, value: s.value },
        fillThreshold,
        `frame ${i} (layer phụ)`,
        true,
      );

      const outlineTableOffset = w.length;
      for (let y = 0; y < s.height; y++) {
        w.u16(encoded.leftSpace[y]);
        w.u16(encoded.rightSpace[y]);
      }
      const cmdTableOffset = w.length;
      const cmdDataStart = cmdTableOffset + 4 * s.height;
      for (let y = 0; y < s.height; y++) {
        w.u32(cmdDataStart + encoded.rowOffsets[y]);
      }
      w.bytes(encoded.data);

      w.patchU32(secInfoPos[i], cmdTableOffset);
      w.patchU32(secInfoPos[i] + 4, outlineTableOffset);
    }
  }

  return w.toUint8Array();
}

function validateFrame(f: WritableFrame, index: number): void {
  if (!Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width <= 0 || f.height <= 0) {
    throw new SlpError(
      `Frame ${index} có kích thước không hợp lệ.`,
      `width=${f.width}, height=${f.height}`,
    );
  }
  if (f.kind.length !== f.width * f.height || f.value.length !== f.width * f.height) {
    throw new SlpError(
      `Frame ${index} có dữ liệu pixel không khớp kích thước.`,
      `Cần ${f.width * f.height} pixel, nhận được kind=${f.kind.length}, value=${f.value.length}`,
    );
  }
  if (f.width > 0xffff || f.height > 0xffff) {
    throw new SlpError(
      `Frame ${index} quá lớn cho định dạng SLP.`,
      `Tối đa 65535 x 65535, nhận ${f.width} x ${f.height}.`,
    );
  }
}

interface EncodedLayer {
  leftSpace: Uint16Array;
  rightSpace: Uint16Array;
  /** Offset của dòng trong `data`. */
  rowOffsets: Uint32Array;
  data: Uint8Array;
}

/** Encode toàn bộ dòng của một layer thành command stream liên tục. */
function encodeLayerRows(
  layer: Pick<IndexedLayer, 'width' | 'height' | 'kind' | 'value'>,
  fillThreshold: number,
  context: string,
  secondaryLayer = false,
): EncodedLayer {
  const { width, height } = layer;
  const leftSpace = new Uint16Array(height);
  const rightSpace = new Uint16Array(height);
  const rowOffsets = new Uint32Array(height);
  const out = new ByteWriter(Math.max(1024, width * height));

  for (let y = 0; y < height; y++) {
    rowOffsets[y] = out.length;
    const row = encodeRow(layer, y, fillThreshold, `${context}, dòng ${y}`, secondaryLayer);
    if (row.fullyTransparent) {
      // Dòng trong suốt hoàn toàn: đánh dấu 0x8000 và KHÔNG ghi command nào.
      leftSpace[y] = ROW_FULLY_TRANSPARENT;
      rightSpace[y] = ROW_FULLY_TRANSPARENT;
      continue;
    }
    leftSpace[y] = row.leftSpace;
    rightSpace[y] = row.rightSpace;
    out.bytes(row.bytes);
  }

  return { leftSpace, rightSpace, rowOffsets, data: out.toUint8Array() };
}

export interface EncodedRow {
  fullyTransparent: boolean;
  leftSpace: number;
  rightSpace: number;
  bytes: Uint8Array;
}

/**
 * Encode một dòng thành chuỗi draw command tối ưu:
 *  - Fill khi >= `fillThreshold` pixel cùng màu liên tiếp
 *  - Lesser/Greater draw cho block không lặp
 *  - Lesser/Greater skip cho khoảng trong suốt ở giữa
 *  - Kết thúc bằng 0x0F
 */
export function encodeRow(
  layer: Pick<IndexedLayer, 'width' | 'height' | 'kind' | 'value'>,
  y: number,
  fillThreshold = 3,
  context = '',
  secondaryLayer = false,
): EncodedRow {
  const { width, kind, value } = layer;
  const base = y * width;

  let firstX = -1;
  let lastX = -1;
  for (let x = 0; x < width; x++) {
    if (kind[base + x] !== PixelKind.Transparent) {
      if (firstX < 0) firstX = x;
      lastX = x;
    }
  }

  if (firstX < 0) {
    return { fullyTransparent: true, leftSpace: 0, rightSpace: 0, bytes: new Uint8Array(0) };
  }

  const w = new ByteWriter(Math.max(64, (lastX - firstX + 1) * 2));

  const sameRun = (start: number, k: number): number => {
    const v = value[base + start];
    let n = 1;
    while (
      start + n <= lastX &&
      kind[base + start + n] === k &&
      value[base + start + n] === v
    ) {
      n++;
    }
    return n;
  };

  const kindRun = (start: number, k: number): number => {
    let n = 1;
    while (start + n <= lastX && kind[base + start + n] === k) n++;
    return n;
  };

  const checkByte = (v: number, what: string): number => {
    if (v < 0 || v > 255) {
      throw new SlpError(
        `Giá trị pixel vượt quá 1 byte khi ghi SLP (${what}).`,
        `${context}: giá trị ${v} không nằm trong 0..255. Version 2.0N/4.0X chỉ hỗ trợ 1 byte/pixel.`,
      );
    }
    return v;
  };

  let x = firstX;
  while (x <= lastX) {
    const k = kind[base + x] as PixelKind;

    if (k === PixelKind.Transparent) {
      const n = kindRun(x, PixelKind.Transparent);
      emitSkip(w, n);
      x += n;
      continue;
    }

    if (secondaryLayer && k !== PixelKind.Palette) {
      // Layer phụ chỉ dùng Lesser draw / Lesser skip / Fill.
      throw new SlpError(
        'Layer phụ chỉ hỗ trợ pixel dạng giá trị đơn.',
        `${context}: gặp PixelKind=${k} tại x=${x}.`,
      );
    }

    switch (k) {
      case PixelKind.Palette: {
        const run = sameRun(x, k);
        if (run >= fillThreshold) {
          emitFill(w, run, checkByte(value[base + x], 'fill'));
          x += run;
          break;
        }
        // Gom block draw cho tới khi gặp kind khác hoặc gặp run đáng dùng Fill.
        let cursor = x;
        while (cursor <= lastX && kind[base + cursor] === PixelKind.Palette) {
          const rl = sameRun(cursor, PixelKind.Palette);
          if (rl >= fillThreshold && cursor > x) break;
          cursor += rl;
        }
        const n = cursor - x;
        emitDraw(w, n, (i) => checkByte(value[base + x + i], 'draw'));
        x = cursor;
        break;
      }
      case PixelKind.Player: {
        const run = sameRun(x, k);
        if (run >= fillThreshold) {
          emitCountThenPixels(w, 0x0a, run, 1, () => checkByte(value[base + x], 'fill player'));
          x += run;
          break;
        }
        let cursor = x;
        while (cursor <= lastX && kind[base + cursor] === PixelKind.Player) {
          const rl = sameRun(cursor, PixelKind.Player);
          if (rl >= fillThreshold && cursor > x) break;
          cursor += rl;
        }
        const n = cursor - x;
        emitChunked(n, MAX_BYTE_COUNT, (start, len) =>
          emitCountThenPixels(w, 0x06, len, len, (i) =>
            checkByte(value[base + x + start + i], 'player draw'),
          ),
        );
        x = cursor;
        break;
      }
      case PixelKind.Shadow: {
        const n = kindRun(x, PixelKind.Shadow);
        emitChunked(n, MAX_BYTE_COUNT, (start, len) =>
          emitCountThenPixels(w, 0x0b, len, len, (i) =>
            checkByte(value[base + x + start + i], 'shadow draw'),
          ),
        );
        x += n;
        break;
      }
      case PixelKind.OutlinePlayer: {
        const n = kindRun(x, PixelKind.OutlinePlayer);
        emitOutline(w, n, 0x4e, 0x5e);
        x += n;
        break;
      }
      case PixelKind.OutlineSpecial: {
        const n = kindRun(x, PixelKind.OutlineSpecial);
        emitOutline(w, n, 0x6e, 0x7e);
        x += n;
        break;
      }
      case PixelKind.Direct:
        throw new SlpError(
          'Chưa hỗ trợ ghi SLP 32-bit.',
          `${context}: frame chứa pixel màu trực tiếp (BGRA), chỉ ghi được SLP dạng palette.`,
        );
      default:
        throw new SlpError('Pixel không hợp lệ khi encode.', `${context}: PixelKind=${k} tại x=${x}.`);
    }
  }

  w.u8(0x0f); // End of row

  return {
    fullyTransparent: false,
    leftSpace: firstX,
    rightSpace: width - 1 - lastX,
    bytes: w.toUint8Array(),
  };
}

/** Chia N thành các đoạn <= max rồi gọi callback(start, len). */
function emitChunked(n: number, max: number, fn: (start: number, len: number) => void): void {
  let done = 0;
  while (done < n) {
    const len = Math.min(max, n - done);
    fn(done, len);
    done += len;
  }
}

function emitSkip(w: ByteWriter, n: number): void {
  emitChunked(n, MAX_GREATER_COUNT, (_start, len) => {
    if (len <= MAX_LESSER_COUNT) {
      w.u8((len << 2) | 0x01);
    } else {
      w.u8((((len >>> 8) & 0x0f) << 4) | 0x03);
      w.u8(len & 0xff);
    }
  });
}

function emitDraw(w: ByteWriter, n: number, pixelAt: (i: number) => number): void {
  emitChunked(n, MAX_GREATER_COUNT, (start, len) => {
    if (len <= MAX_LESSER_COUNT) {
      w.u8((len << 2) | 0x00);
    } else {
      w.u8((((len >>> 8) & 0x0f) << 4) | 0x02);
      w.u8(len & 0xff);
    }
    for (let i = 0; i < len; i++) w.u8(pixelAt(start + i));
  });
}

function emitFill(w: ByteWriter, n: number, pixel: number): void {
  emitChunked(n, MAX_BYTE_COUNT, (_start, len) => {
    emitCountThenPixels(w, 0x07, len, 1, () => pixel);
  });
}

/**
 * Lệnh có count nằm ở nibble cao (hoặc byte kế tiếp nếu nibble = 0),
 * theo sau là `pixelCount` giá trị màu.
 */
function emitCountThenPixels(
  w: ByteWriter,
  lowNibble: number,
  count: number,
  pixelCount: number,
  pixelAt: (i: number) => number,
): void {
  if (count <= MAX_NIBBLE_COUNT && count > 0) {
    w.u8((count << 4) | lowNibble);
  } else {
    w.u8(lowNibble);
    w.u8(count & 0xff);
  }
  for (let i = 0; i < pixelCount; i++) w.u8(pixelAt(i));
}

function emitOutline(w: ByteWriter, n: number, singleCmd: number, fillCmd: number): void {
  if (n === 1) {
    w.u8(singleCmd);
    return;
  }
  emitChunked(n, MAX_BYTE_COUNT, (_start, len) => {
    if (len === 1) {
      w.u8(singleCmd);
    } else {
      w.u8(fillCmd);
      w.u8(len & 0xff);
    }
  });
}

// ---------------------------------------------------------------------------
// Round-trip validation
// ---------------------------------------------------------------------------

export interface RoundTripIssue {
  frame: number;
  row: number;
  column: number;
  expected: string;
  actual: string;
}

export interface RoundTripResult {
  ok: boolean;
  framesChecked: number;
  pixelsChecked: number;
  issues: RoundTripIssue[];
  message: string;
}

/**
 * Đọc lại buffer vừa ghi bằng chính parser ở phần A và so khớp từng pixel
 * với dữ liệu gốc. Trả về danh sách lỗi cụ thể (frame nào, dòng nào, cột nào).
 */
export function validateRoundTrip(
  buffer: Uint8Array,
  original: WritableFrame[],
  maxIssues = 20,
): RoundTripResult {
  const issues: RoundTripIssue[] = [];
  let pixelsChecked = 0;

  let parsed;
  try {
    parsed = parseSlp(buffer);
  } catch (err) {
    return {
      ok: false,
      framesChecked: 0,
      pixelsChecked: 0,
      issues: [],
      message: `Không đọc lại được file vừa tạo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (parsed.frames.length !== original.length) {
    return {
      ok: false,
      framesChecked: 0,
      pixelsChecked: 0,
      issues: [],
      message: `Số frame không khớp: ghi ${original.length}, đọc lại được ${parsed.frames.length}.`,
    };
  }

  for (let i = 0; i < original.length && issues.length < maxIssues; i++) {
    const src = original[i];
    const dst = parsed.frames[i].main;

    if (dst.width !== src.width || dst.height !== src.height) {
      issues.push({
        frame: i,
        row: -1,
        column: -1,
        expected: `${src.width}x${src.height}`,
        actual: `${dst.width}x${dst.height}`,
      });
      continue;
    }
    if (dst.hotspotX !== src.hotspotX || dst.hotspotY !== src.hotspotY) {
      issues.push({
        frame: i,
        row: -1,
        column: -1,
        expected: `hotspot (${src.hotspotX}, ${src.hotspotY})`,
        actual: `hotspot (${dst.hotspotX}, ${dst.hotspotY})`,
      });
    }

    for (let y = 0; y < src.height && issues.length < maxIssues; y++) {
      for (let x = 0; x < src.width; x++) {
        const p = y * src.width + x;
        pixelsChecked++;
        const ek = src.kind[p];
        const ak = dst.kind[p];
        const ev = ek === PixelKind.Transparent ? 0 : src.value[p];
        const av = ak === PixelKind.Transparent ? 0 : dst.value[p];
        if (ek !== ak || ev !== av) {
          issues.push({
            frame: i,
            row: y,
            column: x,
            expected: `${PixelKind[ek] ?? ek}#${ev}`,
            actual: `${PixelKind[ak] ?? ak}#${av}`,
          });
          if (issues.length >= maxIssues) break;
        }
      }
    }
  }

  const ok = issues.length === 0;
  return {
    ok,
    framesChecked: original.length,
    pixelsChecked,
    issues,
    message: ok
      ? `Round-trip OK: ${original.length} frame, ${pixelsChecked.toLocaleString('vi-VN')} pixel khớp hoàn toàn.`
      : `Phát hiện ${issues.length} điểm lệch khi đọc lại file vừa tạo.`,
  };
}
