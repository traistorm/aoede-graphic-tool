import { SlpError } from './types';

/**
 * Giải nén LZ4 block format (không phải frame format).
 *
 * SLP version 4.2P (AoE1:DE từ Update 38862) là container:
 *   [0..4)  "4.2P"
 *   [4..8)  uint32 uncompressed size
 *   [8..]   LZ4 block data
 *
 * Cài đặt thuần JS để không phụ thuộc thư viện ngoài — thuật toán LZ4 block
 * chỉ gồm token (literal length / match length) + offset 16-bit little endian.
 */
export function lz4DecompressBlock(src: Uint8Array, uncompressedSize: number): Uint8Array {
  if (uncompressedSize < 0 || uncompressedSize > 1 << 30) {
    throw new SlpError(
      'Kích thước sau giải nén của file 4.2P không hợp lệ.',
      `uncompressed size = ${uncompressedSize}`,
    );
  }
  const dst = new Uint8Array(uncompressedSize);
  const sEnd = src.length;
  let s = 0;
  let d = 0;

  while (s < sEnd) {
    const token = src[s++];

    // --- literals ---
    let litLen = token >>> 4;
    if (litLen === 15) {
      let add: number;
      do {
        if (s >= sEnd) throw truncated('literal length');
        add = src[s++];
        litLen += add;
      } while (add === 255);
    }
    if (litLen > 0) {
      if (s + litLen > sEnd) throw truncated('literals');
      if (d + litLen > uncompressedSize) throw overflow('literals');
      dst.set(src.subarray(s, s + litLen), d);
      s += litLen;
      d += litLen;
    }

    // Block kết thúc bằng một chuỗi literal, không có match phía sau.
    if (s >= sEnd) break;

    // --- match ---
    if (s + 2 > sEnd) throw truncated('match offset');
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0 || offset > d) {
      throw new SlpError(
        'Dữ liệu LZ4 trong file 4.2P bị hỏng.',
        `Match offset không hợp lệ (${offset}) tại vị trí giải nén ${d}.`,
      );
    }

    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let add: number;
      do {
        if (s >= sEnd) throw truncated('match length');
        add = src[s++];
        matchLen += add;
      } while (add === 255);
    }
    matchLen += 4; // minmatch

    if (d + matchLen > uncompressedSize) throw overflow('match');
    let m = d - offset;
    // Copy từng byte vì match có thể chồng lấn (offset < matchLen).
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++];
  }

  if (d !== uncompressedSize) {
    throw new SlpError(
      'Giải nén LZ4 không khớp kích thước khai báo trong header 4.2P.',
      `Giải nén được ${d} byte nhưng header khai báo ${uncompressedSize} byte.`,
    );
  }
  return dst;
}

function truncated(what: string): SlpError {
  return new SlpError('Dữ liệu LZ4 trong file 4.2P bị cắt cụt.', `Hết dữ liệu khi đọc ${what}.`);
}

function overflow(what: string): SlpError {
  return new SlpError(
    'Dữ liệu LZ4 trong file 4.2P bị hỏng.',
    `Ghi vượt quá kích thước khai báo khi xử lý ${what}.`,
  );
}

/** Magic number của LZ4 *frame* format — không dùng trong SLP nhưng cần báo lỗi rõ. */
export function isLz4Frame(src: Uint8Array): boolean {
  return src.length >= 4 && src[0] === 0x04 && src[1] === 0x22 && src[2] === 0x4d && src[3] === 0x18;
}
