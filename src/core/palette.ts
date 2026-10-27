import { SlpError } from './types';

export interface PaletteEntry {
  r: number;
  g: number;
  b: number;
}

export interface Palette {
  name: string;
  /** Số entry thực tế đọc được. */
  size: number;
  /** RGB phẳng, độ dài = 256 * 3 (thiếu thì fill đen). */
  data: Uint8Array;
  source: 'jasc' | 'binary' | 'builtin';
}

export const PALETTE_SLOTS = 256;

export function getColor(palette: Palette, index: number): PaletteEntry {
  const i = ((index % PALETTE_SLOTS) + PALETTE_SLOTS) % PALETTE_SLOTS;
  return {
    r: palette.data[i * 3],
    g: palette.data[i * 3 + 1],
    b: palette.data[i * 3 + 2],
  };
}

/**
 * Parse palette JASC-PAL (`.pal` / `.palx`), định dạng dùng trong AoE1:DE:
 *
 *   JASC-PAL
 *   0100
 *   256
 *   r g b
 *   ...
 *
 * Dòng thứ 4 trở đi tương ứng index 0, 1, 2...
 */
export function parseJascPal(text: string, name = 'palette'): Palette {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l, i) => i < 3 || l.length > 0);

  if (lines.length < 4 || lines[0].toUpperCase() !== 'JASC-PAL') {
    throw new SlpError(
      'File palette không phải định dạng JASC-PAL.',
      'Dòng đầu tiên phải là "JASC-PAL". Nếu là palette nhị phân 768 byte, hãy dùng parseBinaryPalette.',
    );
  }

  const declared = Number.parseInt(lines[2], 10);
  if (!Number.isFinite(declared) || declared <= 0) {
    throw new SlpError(
      'File palette hỏng: số lượng entry không hợp lệ.',
      `Dòng 3 phải là số entry, đọc được: "${lines[2]}"`,
    );
  }

  const data = new Uint8Array(PALETTE_SLOTS * 3);
  let count = 0;
  for (let i = 3; i < lines.length && count < PALETTE_SLOTS; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) {
      throw new SlpError(
        `File palette hỏng tại dòng ${i + 1}.`,
        `Mỗi dòng màu cần 3 số "r g b", đọc được: "${line}"`,
      );
    }
    const r = clampByte(Number.parseInt(parts[0], 10));
    const g = clampByte(Number.parseInt(parts[1], 10));
    const b = clampByte(Number.parseInt(parts[2], 10));
    data[count * 3] = r;
    data[count * 3 + 1] = g;
    data[count * 3 + 2] = b;
    count++;
  }

  if (count === 0) {
    throw new SlpError('File palette không có màu nào.', 'Không đọc được entry RGB nào sau header.');
  }

  return { name, size: Math.min(count, declared || count), data, source: 'jasc' };
}

/** Palette nhị phân dạng thô: 768 byte RGB (một số bản mod dùng). */
export function parseBinaryPalette(bytes: Uint8Array, name = 'palette'): Palette {
  if (bytes.length < 3) {
    throw new SlpError('File palette nhị phân quá ngắn.', `Chỉ có ${bytes.length} byte.`);
  }
  const count = Math.min(PALETTE_SLOTS, Math.floor(bytes.length / 3));
  const data = new Uint8Array(PALETTE_SLOTS * 3);
  data.set(bytes.subarray(0, count * 3));
  return { name, size: count, data, source: 'binary' };
}

/** Tự nhận diện JASC-PAL (text) hay palette nhị phân. */
export function parsePaletteAuto(bytes: Uint8Array, name = 'palette'): Palette {
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 8));
  if (head.toUpperCase().startsWith('JASC-PAL')) {
    return parseJascPal(new TextDecoder('ascii').decode(bytes), name);
  }
  if (bytes.length === 768 || bytes.length === 772) {
    return parseBinaryPalette(bytes, name);
  }
  // Thử parse như text để báo lỗi có ngữ cảnh.
  return parseJascPal(new TextDecoder('ascii').decode(bytes), name);
}

/**
 * Load palette từ URL (dùng với `palettes/manifest.json` của project).
 * Hàm async, throw ra message thân thiện nếu file không truy cập được.
 */
export async function loadPaletteFromUrl(url: string, displayName?: string): Promise<Palette> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    throw new SlpError(
      `Không fetch được palette từ "${url}".`,
      `Có thể app đang chạy qua file:// và trình duyệt chặn fetch. Hãy chạy qua HTTP (npm run dev / preview).`,
    );
  }
  if (!response.ok) {
    throw new SlpError(
      `HTTP ${response.status} khi tải palette "${url}".`,
      `${response.statusText}. Kiểm tra file có tồn tại trong thư mục palettes/.`,
    );
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  return parsePaletteAuto(buf, displayName ?? url);
}

/**
 * Parse file `palettes.conf` — mỗi dòng không comment là `palette_id,filename`.
 */
export function parsePalettesConf(text: string): Array<{ id: number; file: string }> {
  const out: Array<{ id: number; file: string }> = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const [idStr, file] = trimmed.split(',').map((s) => s.trim());
    const id = Number.parseInt(idStr, 10);
    if (Number.isFinite(id) && file) out.push({ id, file });
  }
  return out;
}

/** Serialize ngược lại ra JASC-PAL (tiện khi muốn lưu palette đã chỉnh). */
export function serializeJascPal(palette: Palette): string {
  const n = palette.size || PALETTE_SLOTS;
  const rows: string[] = ['JASC-PAL', '0100', String(n)];
  for (let i = 0; i < n; i++) {
    rows.push(`${palette.data[i * 3]} ${palette.data[i * 3 + 1]} ${palette.data[i * 3 + 2]}`);
  }
  return rows.join('\r\n') + '\r\n';
}

/**
 * Palette dự phòng khi người dùng chưa nạp file `.pal`.
 * KHÔNG chính xác so với game — ch� để xem hình dạng sprite.
 *
 * Bố cục mô phỏng palette AoE: index 0 = trong suốt/đen, 16..143 = 8 player
 * color × 16 sắc độ, phần còn lại là color cube 6×6×6 + thang xám.
 */
export function createFallbackPalette(): Palette {
  const data = new Uint8Array(PALETTE_SLOTS * 3);
  const set = (i: number, r: number, g: number, b: number): void => {
    data[i * 3] = r;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = b;
  };

  set(0, 0, 0, 0);
  // 1..15: thang xám tối
  for (let i = 1; i < 16; i++) {
    const v = Math.round((i / 15) * 120);
    set(i, v, v, v);
  }

  // 16..143: 8 player color × 16 sắc độ.
  // Mỗi player có 1 hue chính, gradient từ tối → sáng qua 16 bậc.
  // (Màu KHÔNG chính xác với AoE1 — chỉ để preview khi chưa nạp .pal)
  const playerHues: Array<[number, number, number]> = [
    [60, 100, 220], // 1 — xanh dương (Blue)
    [220, 60, 60], // 2 — đỏ (Red)
    [240, 220, 60], // 3 — vàng (Yellow)
    [139, 90, 43], // 4 — nâu (Brown)
    [240, 140, 40], // 5 — cam (Orange)
    [60, 200, 80], // 6 — lục (Green)
    [180, 80, 220], // 7 — tím (Purple)
    [60, 220, 220], // 8 — xanh lơ (Teal)
  ];
  for (let p = 0; p < 8; p++) {
    const [hr, hg, hb] = playerHues[p];
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      // Sắc độ từ ~30% → 100% độ bão hoà của hue.
      const scale = 0.3 + 0.7 * t;
      set(16 + p * 16 + i, Math.round(hr * scale), Math.round(hg * scale), Math.round(hb * scale));
    }
  }

  // 144..247: color cube 6×6×6 = 104 màu (vừa đủ phần còn lại)
  let idx = 144;
  for (let r = 0; r < 4 && idx < 248; r++) {
    for (let g = 0; g < 6 && idx < 248; g++) {
      for (let b = 0; b < 6 && idx < 248; b++) {
        set(idx++, Math.round((r * 255) / 3), Math.round((g * 255) / 5), Math.round((b * 255) / 5));
      }
    }
  }
  // Phần còn trống fill xám trung bình
  while (idx < 248) {
    set(idx++, 128, 128, 128);
  }

  // 248..255: thang xám sáng
  for (let i = 248; i < 256; i++) {
    const v = Math.round(((i - 248) / 7) * 255);
    set(i, v, v, v);
  }
  // Index 243 dùng cho Outline 2 → cho màu trắng dễ nhìn
  set(243, 255, 255, 255);

  return { name: 'Fallback palette (không chính xác với game)', size: 256, data, source: 'builtin' };
}

/**
 * Tìm palette index gần nhất với màu RGB (khoảng cách Euclid trong không gian RGB).
 * Có cache để encode ảnh lớn không bị chậm.
 */
export class PaletteMatcher {
  private cache = new Map<number, number>();
  private readonly candidates: number[];

  constructor(
    private readonly palette: Palette,
    options: { excludeRanges?: Array<[number, number]>; limit?: number } = {},
  ) {
    const limit = options.limit ?? palette.size ?? PALETTE_SLOTS;
    const excluded = new Set<number>();
    for (const [start, end] of options.excludeRanges ?? []) {
      for (let i = start; i <= end; i++) excluded.add(i);
    }
    this.candidates = [];
    for (let i = 0; i < Math.min(limit, PALETTE_SLOTS); i++) {
      if (!excluded.has(i)) this.candidates.push(i);
    }
    if (this.candidates.length === 0) {
      throw new SlpError(
        'Không còn màu nào trong palette để so khớp.',
        'Vùng loại trừ đã che hết toàn bộ palette.',
      );
    }
  }

  find(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    let best = this.candidates[0];
    let bestDist = Number.POSITIVE_INFINITY;
    const data = this.palette.data;
    for (const i of this.candidates) {
      const dr = data[i * 3] - r;
      const dg = data[i * 3 + 1] - g;
      const db = data[i * 3 + 2] - b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
        if (dist === 0) break;
      }
    }
    this.cache.set(key, best);
    return best;
  }
}

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}
