/**
 * Kiểu dữ liệu dùng chung cho toàn bộ pipeline SLP.
 *
 * Tham chiếu spec: SLP dùng trong Age of Empires 1 (1997) và AoE1: Definitive Edition.
 * Version hỗ trợ: 2.0N, 3.0, 4.0X, 4.1X, 4.2P (LZ4 container).
 */

export const SUPPORTED_VERSIONS = ['2.0N', '3.0', '4.0X', '4.1X', '4.2P'] as const;
export type SlpVersion = (typeof SUPPORTED_VERSIONS)[number];

/** Loại nội dung của một pixel sau khi decode draw command. */
export enum PixelKind {
  /** Không vẽ gì (skip command hoặc nằm ngoài vùng outline) → alpha = 0. */
  Transparent = 0,
  /** value = palette index. */
  Palette = 1,
  /** value = player color base index; index thật = value + player * 16. */
  Player = 2,
  /** Shadow draw command của layer chính. */
  Shadow = 3,
  /** Extended 0x4E / 0x5E — viền màu player. */
  OutlinePlayer = 4,
  /** Extended 0x6E / 0x7E — viền palette index 243. */
  OutlineSpecial = 5,
  /** SLP 32-bit: màu nằm trực tiếp trong `rgba`. */
  Direct = 6,
}

/** Palette index cố định dùng cho Outline 2 (0x6E / 0x7E). */
export const OUTLINE_SPECIAL_INDEX = 243;

/** Bảng `type` trong header v4. */
export const SLP_TYPE_FLAGS: Array<{ bit: number; name: string }> = [
  { bit: 0x00, name: 'Normal' },
  { bit: 0x01, name: 'Color Mask' },
  { bit: 0x02, name: 'Shadow Layer' },
  { bit: 0x04, name: 'Outline' },
  { bit: 0x08, name: 'VFX Color' },
  { bit: 0x10, name: 'VFX Alpha' },
  { bit: 0x20, name: 'Decay' },
];

export function describeSlpType(type: number): string {
  if (type === 0) return 'Normal (0x00)';
  const names = SLP_TYPE_FLAGS.filter((f) => f.bit !== 0 && (type & f.bit) !== 0).map((f) => f.name);
  const hex = `0x${type.toString(16).padStart(2, '0').toUpperCase()}`;
  return names.length ? `${names.join(' + ')} (${hex})` : `Unknown (${hex})`;
}

/** struct slp_frame_info — 32 byte, little endian. */
export interface SlpFrameInfo {
  cmdTableOffset: number;
  outlineTableOffset: number;
  paletteOffset: number;
  /** Không dùng ở bản cũ; AoE1:DE dùng làm palette ID. */
  properties: number;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
}

/** struct secondary_frame_info — 32 byte, chỉ có ở version >= 4.0X. */
export interface SecondaryFrameInfo {
  cmdTableOffset: number;
  outlineTableOffset: number;
  nullField: number;
  /** uint24 */
  properties: number;
  /** 0x02 Shadow, 0x08 VFX Alpha, ... */
  frameType: number;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
}

/** Header đã chuẩn hoá cho cả hai nhánh version. */
export interface SlpHeader {
  /** Version thật sự của dữ liệu SLP (sau khi giải nén 4.2P). */
  version: string;
  numFrames: number;
  /** Chỉ có ở version <= 3.0. */
  comment?: string;
  /** Các field dưới đây chỉ có ở version >= 4.0. */
  type?: number;
  numDirections?: number;
  framesPerDirection?: number;
  paletteId?: number;
  offsetMain?: number;
  offsetSecondary?: number;
}

/** Một layer ảnh đã decode thành mảng pixel phẳng (row-major). */
export interface IndexedLayer {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  /** PixelKind cho từng pixel, độ dài = width * height. */
  kind: Uint8Array;
  /** Palette index / player base index / shadow value. */
  value: Uint16Array;
  /** Display modifier (chỉ 4.1X), độ dài = width * height nếu có. */
  modifier?: Uint8Array;
  /** RGBA cho pixel PixelKind.Direct (SLP 32-bit), độ dài = width * height * 4. */
  rgba?: Uint8ClampedArray;
}

/** Layer phụ (shadow / VFX alpha) của version >= 4.0X. */
export interface SecondaryLayer extends IndexedLayer {
  /** 0x02 Shadow, 0x08 VFX Alpha... quyết định cách quy đổi ra alpha. */
  frameType: number;
}

export interface SlpFrame {
  index: number;
  info: SlpFrameInfo;
  main: IndexedLayer;
  secondaryInfo?: SecondaryFrameInfo;
  secondary?: SecondaryLayer;
}

export interface SlpFile {
  /** Version ghi ở 4 byte đầu file (có thể là "4.2P"). */
  containerVersion: string;
  /** Version thật của dữ liệu SLP sau khi giải nén. */
  version: string;
  compressed: boolean;
  header: SlpHeader;
  frames: SlpFrame[];
  /** Cảnh báo không chặn (dữ liệu lệch nhẹ so với spec) để hiển thị lên UI. */
  warnings: string[];
  /** Kích thước dữ liệu SLP sau giải nén. */
  byteLength: number;
}

/** Lỗi có thông điệp thân thiện để show thẳng lên UI. */
export class SlpError extends Error {
  readonly detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = 'SlpError';
    this.detail = detail;
  }
}
