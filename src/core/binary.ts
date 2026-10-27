import { SlpError } from './types';

/**
 * Đọc binary little-endian có kiểm tra biên, báo lỗi kèm ngữ cảnh rõ ràng
 * thay vì trả về NaN/undefined im lặng.
 */
export class ByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  private pos = 0;

  constructor(source: ArrayBuffer | Uint8Array) {
    this.bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get offset(): number {
    return this.pos;
  }

  seek(offset: number, context = 'seek'): void {
    if (!Number.isFinite(offset) || offset < 0 || offset > this.length) {
      throw new SlpError(
        `File hỏng hoặc offset không hợp lệ (${context}).`,
        `Offset 0x${Math.trunc(offset).toString(16)} nằm ngoài file (kích thước 0x${this.length.toString(16)} byte).`,
      );
    }
    this.pos = offset;
  }

  private need(n: number, context: string): void {
    if (this.pos + n > this.length) {
      throw new SlpError(
        `File SLP bị cắt cụt hoặc hỏng (${context}).`,
        `Cần đọc ${n} byte tại offset 0x${this.pos.toString(16)} nhưng file chỉ có 0x${this.length.toString(16)} byte.`,
      );
    }
  }

  u8(context = 'uint8'): number {
    this.need(1, context);
    return this.bytes[this.pos++];
  }

  u16(context = 'uint16'): number {
    this.need(2, context);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16(context = 'int16'): number {
    this.need(2, context);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u24(context = 'uint24'): number {
    this.need(3, context);
    const a = this.bytes[this.pos];
    const b = this.bytes[this.pos + 1];
    const c = this.bytes[this.pos + 2];
    this.pos += 3;
    return a | (b << 8) | (c << 16);
  }

  u32(context = 'uint32'): number {
    this.need(4, context);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(context = 'int32'): number {
    this.need(4, context);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Đọc `len` byte ASCII, bỏ null padding và khoảng trắng thừa. */
  ascii(len: number, context = 'ascii'): string {
    this.need(len, context);
    let out = '';
    for (let i = 0; i < len; i++) {
      const c = this.bytes[this.pos + i];
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    this.pos += len;
    return out.trim();
  }

  slice(len: number, context = 'slice'): Uint8Array {
    this.need(len, context);
    const out = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

/**
 * Buffer builder động cho phần ghi file — tương đương `struct.pack` bên Python.
 * Hỗ trợ patch lại offset sau khi biết vị trí thực tế.
 */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initialCapacity = 1 << 16) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.byteLength) return;
    let cap = this.buf.byteLength || 1024;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.len, v & 0xffff, true);
    this.len += 2;
    return this;
  }

  u24(v: number): this {
    this.ensure(3);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.len, v | 0, true);
    this.len += 4;
    return this;
  }

  bytes(data: Uint8Array | number[]): this {
    this.ensure(data.length);
    this.buf.set(data instanceof Uint8Array ? data : Uint8Array.from(data), this.len);
    this.len += data.length;
    return this;
  }

  /** Ghi chuỗi ASCII cố định `len` byte, phần thừa fill 0. */
  ascii(text: string, len: number): this {
    this.ensure(len);
    for (let i = 0; i < len; i++) {
      const code = i < text.length ? text.charCodeAt(i) & 0x7f : 0;
      this.buf[this.len + i] = code;
    }
    this.len += len;
    return this;
  }

  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }

  /** Đệm 0 tới bội số của `alignment`. */
  align(alignment: number): this {
    const rem = this.len % alignment;
    if (rem !== 0) this.zeros(alignment - rem);
    return this;
  }

  /** Ghi đè uint32 tại vị trí đã ghi trước đó (dùng để patch offset). */
  patchU32(position: number, value: number): void {
    if (position < 0 || position + 4 > this.len) {
      throw new RangeError(`patchU32 ngoài vùng đã ghi: ${position}`);
    }
    this.view.setUint32(position, value >>> 0, true);
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}
