/**
 * Helper DOM tối giản — không dùng framework, chỉ cần querySelector + EventTarget.
 * Mục tiêu: mỗi dòng đều đọc rõ ràng, không che giấu state.
 */
export function $<T extends Element = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Không tìm thấy phần tử #${id}`);
  return el as unknown as T;
}

export function show(el: HTMLElement): void {
  el.hidden = false;
}
export function hide(el: HTMLElement): void {
  el.hidden = true;
}

export function setText(el: HTMLElement, text: string): void {
  el.textContent = text;
}

/** Tải file xuống client. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Tạo canvas từ RgbaImage và gắn vào DOM. */
export function makeCanvas(img: { width: number; height: number; data: Uint8ClampedArray }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Trình duyệt không hỗ trợ canvas 2D.');
  const imageData = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  ctx.putImageData(imageData, 0, 0);
  return c;
}

/** Đọc RgbaImage vào ImageData từ một canvas đã tồn tại. */
export function writeToCanvas(
  canvas: HTMLCanvasElement,
  img: { width: number; height: number; data: Uint8ClampedArray },
): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Trình duyệt không hỗ trợ canvas 2D.');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
}

/** Đọc ImageData từ HTMLImageElement (PNG sau khi decode). */
export async function readPngFile(file: File): Promise<{
  name: string;
  imageData: ImageData;
}> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`Không đọc được ảnh ${file.name}`));
      im.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Trình duyệt không hỗ trợ canvas 2D.');
    ctx.drawImage(img, 0, 0);
    return { name: file.name, imageData: ctx.getImageData(0, 0, canvas.width, canvas.height) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Format số cho người Việt, có phân cách hàng nghìn. */
export function fmtNumber(n: number): string {
  return n.toLocaleString('vi-VN');
}
