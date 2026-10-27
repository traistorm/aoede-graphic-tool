import { type Palette, PaletteMatcher, createFallbackPalette, parsePaletteAuto } from '../core/palette';
import { PixelKind, type IndexedLayer } from '../core/types';
import { $, makeCanvas, readPngFile, setText } from './dom';
import { writeSlp, validateRoundTrip, type WritableFrame, type WriteVersion } from '../core/slpWriter';
import { downloadBlob } from './dom';

export interface ImportedFrame {
  name: string;
  imageData: ImageData;
  hotspotX: number;
  hotspotY: number;
}

const state: {
  files: ImportedFrame[];
  palette: Palette;
  secondaryFrame: ImportedFrame | null;
} = {
  files: [],
  palette: createFallbackPalette(),
  secondaryFrame: null,
};

export async function readPaletteFile(file: File): Promise<Palette> {
  const buf = await file.arrayBuffer();
  return parsePaletteAuto(new Uint8Array(buf), file.name);
}

/** Đọc nhiều PNG vào bộ nhớ. */
export async function readImportFile(files: FileList | File[]): Promise<void> {
  const list = Array.from(files).filter((f) => f.type === 'image/png' || f.name.endsWith('.png'));
  if (list.length === 0) return;
  const inputs = await Promise.all(list.map(readPngFile));
  for (const [i, input] of inputs.entries()) {
    state.files.push({
      name: input.name,
      imageData: input.imageData,
      hotspotX: Math.floor(input.imageData.width / 2),
      hotspotY: Math.floor(input.imageData.height / 2),
    });
    state.files[state.files.length - inputs.length + i].hotspotX = Math.floor(
      input.imageData.width / 2,
    );
  }
  renderImportList();
}

function renderImportList(): void {
  const wrap = $<HTMLDivElement>('import-list');
  wrap.innerHTML = '';
  if (state.files.length === 0) {
    setText($<HTMLElement>('btn-build-slp'), 'Build & validate SLP');
    $<HTMLButtonElement>('btn-build-slp').disabled = true;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const [i, f] of state.files.entries()) {
    const row = document.createElement('div');
    row.className = 'import-row';

    const preview = makeCanvas({
      width: f.imageData.width,
      height: f.imageData.height,
      data: f.imageData.data,
    });
    preview.width = 60;
    preview.height = 60;
    preview.style.imageRendering = 'pixelated';
    row.appendChild(preview);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${i}. ${f.name}`;
    row.appendChild(name);

    const dim = document.createElement('div');
    dim.textContent = `${f.imageData.width}×${f.imageData.height}`;
    row.appendChild(dim);

    const hx = document.createElement('input');
    hx.type = 'number';
    hx.value = String(f.hotspotX);
    hx.addEventListener('change', () => {
      f.hotspotX = Number.parseInt(hx.value, 10) || 0;
    });
    row.appendChild(hx);

    const hy = document.createElement('input');
    hy.type = 'number';
    hy.value = String(f.hotspotY);
    hy.addEventListener('change', () => {
      f.hotspotY = Number.parseInt(hy.value, 10) || 0;
    });
    row.appendChild(hy);

    const remove = document.createElement('button');
    remove.textContent = 'Xoá';
    remove.addEventListener('click', () => {
      state.files.splice(i, 1);
      renderImportList();
    });
    row.appendChild(remove);

    fragment.appendChild(row);
  }
  wrap.appendChild(fragment);
  $<HTMLButtonElement>('btn-build-slp').disabled = false;
  setText($<HTMLButtonElement>('btn-build-slp'), `Build & validate SLP (${state.files.length} frame)`);
}

export function clearImport(): void {
  state.files = [];
  state.secondaryFrame = null;
  renderImportList();
}

export function setSecondaryFrame(frame: ImportedFrame | null): void {
  state.secondaryFrame = frame;
}

/** Convert ImageData → IndexedLayer bằng PaletteMatcher. */
export function frameToIndexedLayer(
  imageData: ImageData,
  alphaThreshold: number,
  matcher: PaletteMatcher,
  hotspots: { x: number; y: number },
): IndexedLayer {
  const { width, height, data } = imageData;
  const kind = new Uint8Array(width * height);
  const value = new Uint16Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const a = data[p + 3];
    if (a < alphaThreshold) continue;
    value[i] = matcher.find(data[p], data[p + 1], data[p + 2]);
    kind[i] = PixelKind.Palette;
  }
  return { width, height, kind, value, hotspotX: hotspots.x, hotspotY: hotspots.y };
}

export function getImportState(): { files: ImportedFrame[]; palette: Palette } {
  return state;
}

export function setImportPalette(palette: Palette): void {
  state.palette = palette;
}

export interface BuildResult {
  ok: boolean;
  buffer?: Uint8Array;
  message: string;
  issues?: Array<{ frame: number; row: number; column: number; expected: string; actual: string }>;
}

export async function buildAndValidate(): Promise<BuildResult> {
  if (state.files.length === 0) {
    return { ok: false, message: 'Chưa có ảnh nào.' };
  }
  const alphaThreshold = Number(($<HTMLInputElement>('alpha-threshold')).value);
  const version = $<HTMLSelectElement>('output-version').value as WriteVersion;
  const hotspotMode = $<HTMLSelectElement>('hotspot-mode').value;
  const excludePlayer = ($<HTMLInputElement>('exclude-player')).checked;
  const includeSecondary = version === '4.0X' && state.secondaryFrame !== null;

  const matcher = new PaletteMatcher(state.palette, {
    excludeRanges: excludePlayer ? [[16, 31]] : undefined,
  });

  const writable: WritableFrame[] = [];
  for (const f of state.files) {
    const hotspots =
      hotspotMode === 'center'
        ? { x: f.hotspotX, y: f.hotspotY }
        : { x: 0, y: 0 };
    const layer = frameToIndexedLayer(f.imageData, alphaThreshold, matcher, hotspots);
    const wf: WritableFrame = {
      width: layer.width,
      height: layer.height,
      hotspotX: layer.hotspotX,
      hotspotY: layer.hotspotY,
      kind: layer.kind,
      value: layer.value,
    };
    if (includeSecondary) {
      // Tính shadow từ chính ảnh gốc (nơi nào alpha > ngưỡng) — đơn giản.
      const sec = imageToShadowLayer(f.imageData, alphaThreshold);
      wf.secondary = sec;
    }
    writable.push(wf);
  }

  const buffer = writeSlp(writable, { version, includeSecondary });
  const validation = validateRoundTrip(buffer, writable);

  return {
    ok: validation.ok,
    buffer,
    message: validation.message,
    issues: validation.issues,
  };
}

function imageToShadowLayer(imageData: ImageData, alphaThreshold: number): WritableFrame['secondary'] {
  const { width, height, data } = imageData;
  const kind = new Uint8Array(width * height);
  const value = new Uint16Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    if (data[p + 3] < alphaThreshold) continue;
    kind[i] = PixelKind.Palette;
    // Ánh xạ alpha 0..255 về shadow value 0..63 (255 - (value << 2) cho ra alpha 255..0)
    const a = data[p + 3];
    const shadowValue = Math.min(63, Math.max(0, Math.floor((255 - a) / 4)));
    value[i] = shadowValue;
  }
  return {
    width,
    height,
    hotspotX: Math.floor(width / 2),
    hotspotY: Math.floor(height / 2),
    kind,
    value,
    frameType: 0x02,
  };
}

export async function downloadBuiltSlp(result: BuildResult): Promise<void> {
  if (!result.ok || !result.buffer) return;
  // copy sang Uint8Array mới để đảm bảo type BlobPart đúng
  const copy = new Uint8Array(result.buffer);
  downloadBlob(new Blob([copy], { type: 'application/octet-stream' }), 'output.slp');
}
