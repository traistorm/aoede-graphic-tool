import { parseSlp } from '../core/slpReader';
import type { SlpFile } from '../core/types';
import { renderFrame } from '../core/render';
import { describeSlpType, PixelKind, type IndexedLayer, type SlpFrame } from '../core/types';
import { type Palette, PaletteMatcher, createFallbackPalette, getColor } from '../core/palette';
import { $, downloadBlob, makeCanvas, readPngFile, setText, show, writeToCanvas, hide } from './dom';
import JSZip from 'jszip';
import { frameToIndexedLayer, readPaletteFile } from './importer';
import { buildEditedSlp } from '../core/slpExport';

/** Trạng thái toàn cục của tab Đọc. */
export interface ReadState {
  slp: SlpFile | null;
  palette: Palette;
  /** Palette riêng cho Player color (AoE1:DE), null = dùng slice của palette chính. */
  playerPalette: Palette | null;
  selected: number;
  thumbs: HTMLCanvasElement[];
  renderCache: Map<number, ImageData>;
  onSelectionChanged?: () => void;
}

export function createReadState(): ReadState {
  return {
    slp: null,
    palette: createFallbackPalette(),
    playerPalette: null,
    selected: -1,
    thumbs: [],
    renderCache: new Map(),
  };
}

export function refreshPaletteBar(palette: Palette, playerPalette?: Palette | null): void {
  const bar = $<HTMLDivElement>('palette-bar');
  bar.innerHTML = '';
  for (let i = 0; i < palette.size; i++) {
    const span = document.createElement('span');
    span.style.background = `rgb(${palette.data[i * 3]}, ${palette.data[i * 3 + 1]}, ${palette.data[i * 3 + 2]})`;
    bar.appendChild(span);
  }
  if (palette.size < 256) {
    for (let i = palette.size; i < 256; i++) {
      const span = document.createElement('span');
      bar.appendChild(span);
    }
  }
  setText($<HTMLElement>('palette-name'), `(${palette.name} — ${palette.size} màu)`);
  refreshPlayerPreview(palette, playerPalette);
}

/**
 * Cập nhật ô preview = màu player đang chọn.
 * Nếu có player palette riêng (AoE1:DE), lấy shade giữa (index 8).
 * Nếu không, lấy slice 16+(player-1)*16+8 của palette chính.
 */
export function refreshPlayerPreview(palette: Palette, playerPalette?: Palette | null): void {
  const sel = $<HTMLSelectElement>('player');
  const p = Math.max(1, Math.min(8, Number(sel.value) || 1));
  const pal = playerPalette ?? palette;
  const idx = playerPalette ? 8 : 16 + (p - 1) * 16 + 8;
  const c = getColor(pal, idx);
  $<HTMLDivElement>('player-preview').style.background = `rgb(${c.r}, ${c.g}, ${c.b})`;
  $<HTMLDivElement>('player-preview').title = playerPalette
    ? `Player ${p} dùng playercolor palette — preview shade 8: rgb(${c.r}, ${c.g}, ${c.b})`
    : `Player ${p} dùng palette[${16 + (p - 1) * 16 + 8}] — preview: rgb(${c.r}, ${c.g}, ${c.b})`;
}

export async function handleSlpFile(file: File, state: ReadState): Promise<void> {
  const buf = await file.arrayBuffer();
  let slp: SlpFile;
  try {
    slp = parseSlp(buf);
  } catch (err) {
    setText($<HTMLElement>('slp-summary'), `❌ ${(err as Error).message}`);
    show($<HTMLElement>('slp-summary'));
    return;
  }
  state.slp = slp;
  state.renderCache.clear();
  state.selected = -1;
  renderSlpSummary(slp);
  renderThumbs(slp, state);
  setExportButtonsEnabled(slp.frames.length > 0);
}

function renderSlpSummary(slp: SlpFile): void {
  const summary = $<HTMLElement>('slp-summary');
  const header = slp.header;
  const rows: string[] = [];
  rows.push(
    `<h3>${slp.compressed ? `${slp.containerVersion} (đã giải nén)` : slp.version} — ${slp.frames.length} frame</h3>`,
  );
  rows.push('<table>');
  if (slp.compressed) rows.push(`<tr><td>Container</td><td><code>${slp.containerVersion}</code></td></tr>`);
  rows.push(`<tr><td>Version</td><td><code>${slp.version}</code></td></tr>`);
  if (header.type !== undefined) {
    rows.push(`<tr><td>Type</td><td>${describeSlpType(header.type)}</td></tr>`);
    rows.push(`<tr><td>Hướng × frame/hướng</td><td>${header.numDirections} × ${header.framesPerDirection}</td></tr>`);
    const pidName = describePaletteId(slp.frames[0].info.properties);
    rows.push(
      `<tr><td>Palette ID</td><td>0x${(slp.frames[0].info.properties >>> 0)
        .toString(16)
        .padStart(6, '0')} — ${pidName}</td></tr>`,
    );
  }
  if (header.comment) rows.push(`<tr><td>Comment</td><td>${escapeHtml(header.comment)}</td></tr>`);
  rows.push(
    `<tr><td>Frame đầu</td><td>${slp.frames[0].main.width}×${slp.frames[0].main.height}, hotspot (${slp.frames[0].main.hotspotX}, ${slp.frames[0].main.hotspotY})</td></tr>`,
  );
  if (slp.frames[0].secondary) {
    rows.push(
      `<tr><td>Layer phụ</td><td>frameType = 0x${slp.frames[0].secondary!.frameType
        .toString(16)
        .padStart(2, '0')}, ${slp.frames[0].secondary!.width}×${slp.frames[0].secondary!.height}</td></tr>`,
    );
  }
  rows.push(
    `<tr><td>Warnings</td><td>${slp.warnings.length === 0 ? '0' : slp.warnings.length}</td></tr>`,
  );

  // Đếm pixel từng loại trong frame đầu để người dùng biết dropdown Player có tác dụng không.
  const f0 = slp.frames[0].main;
  let nPlayer = 0, nPalette = 0, nShadow = 0, nOutlineP = 0, nOutlineS = 0;
  for (let i = 0; i < f0.kind.length; i++) {
    switch (f0.kind[i]) {
      case PixelKind.Player: nPlayer++; break;
      case PixelKind.Palette: nPalette++; break;
      case PixelKind.Shadow: nShadow++; break;
      case PixelKind.OutlinePlayer: nOutlineP++; break;
      case PixelKind.OutlineSpecial: nOutlineS++; break;
    }
  }
  const hasPlayerColors = nPlayer > 0 || nOutlineP > 0;
  rows.push('</table>');
  rows.push(
    `<p style="margin-top:8px;color:${hasPlayerColors ? 'var(--ok)' : 'var(--warn)'};font-size:0.85rem;">` +
      (hasPlayerColors
        ? `Frame đầu có <strong>${nPlayer}</strong> pixel player-color và <strong>${nOutlineP}</strong> pixel outline player — chọn dropdown Player ở trên sẽ thay đổi màu.`
        : `Frame đầu <strong>không có</strong> pixel player-color (palette=${nPalette}, shadow=${nShadow}, outline=${nOutlineP + nOutlineS}). Player dropdown sẽ <em>không có tác dụng</em> — màu được ghi cứng vào palette.`) +
      `</p>`,
  );
  summary.innerHTML = rows.join('');
  show(summary);

  const warn = $<HTMLElement>('slp-warnings');
  if (slp.warnings.length) {
    warn.innerHTML = `<strong>Cảnh báo khi parse:</strong><ul>${slp.warnings
      .slice(0, 20)
      .map((w: string) => `<li>${escapeHtml(w)}</li>`)
      .join('')}</ul>`;
    show(warn);
  } else {
    hide(warn);
  }
}

function renderThumbs(slp: SlpFile, state: ReadState): void {
  const wrap = $<HTMLDivElement>('thumbs');
  wrap.innerHTML = '';
  state.thumbs = [];
  const player = Number(($<HTMLSelectElement>('player')).value);
  const shadowAlpha = Number(($<HTMLInputElement>('shadow-alpha')).value);
  const includeSec = ($<HTMLInputElement>('include-secondary')).checked;
  const secOnly = ($<HTMLInputElement>('secondary-only')).checked;
  const override = parseColorOverride($<HTMLInputElement>('player-color-override').value);

  const fragment = document.createDocumentFragment();
  for (let i = 0; i < slp.frames.length; i++) {
    const frame = slp.frames[i];
    const img = renderFrame(frame.main, state.palette, frame.secondary, {
      player,
      shadowAlpha,
      includeSecondary: includeSec,
      secondaryOnly: secOnly,
      playerColorOverride: override,
      playerPalette: state.playerPalette,
    });
    const canvas = makeCanvas(img);
    const maxW = 100;
    const scale = Math.min(1, maxW / img.width);
    canvas.style.width = `${Math.max(1, Math.round(img.width * scale))}px`;
    canvas.style.height = `${Math.max(1, Math.round(img.height * scale))}px`;
    canvas.title = `Frame ${i}: ${img.width}×${img.height}, hotspot (${frame.main.hotspotX}, ${frame.main.hotspotY})`;

    const card = document.createElement('div');
    card.className = 'thumb';
    card.appendChild(canvas);
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = `${i} — ${img.width}×${img.height}`;
    card.appendChild(label);
    card.addEventListener('click', () => selectFrame(i, state));

    fragment.appendChild(card);
    state.thumbs.push(canvas);
  }
  wrap.appendChild(fragment);

  if (slp.frames.length > 0) selectFrame(0, state);
}

function selectFrame(index: number, state: ReadState): void {
  if (!state.slp) return;
  state.selected = index;
  for (const [i, c] of state.thumbs.entries()) {
    c.parentElement?.classList.toggle('selected', i === index);
  }
  const frame = state.slp.frames[index];
  const img = renderFrame(
    frame.main,
    state.palette,
    frame.secondary,
    { ...readRenderOptions(), playerPalette: state.playerPalette },
  );
  const canvas = $<HTMLCanvasElement>('canvas-full');
  writeToCanvas(canvas, img);
  canvas.style.width = '';
  canvas.style.height = '';
  show($<HTMLElement>('fullsize'));
  setText(
    $<HTMLElement>('fullsize-info'),
    `Frame ${index} — ${img.width}×${img.height} — hotspot (${frame.main.hotspotX}, ${frame.main.hotspotY}) — ${countNonTransparent(frame.main)} pixel không trong suốt`,
  );
  state.onSelectionChanged?.();
}

export function readRenderOptions(state?: ReadState): {
  player: number;
  shadowAlpha: number;
  includeSecondary: boolean;
  secondaryOnly: boolean;
  playerColorOverride: { r: number; g: number; b: number } | null;
  playerPalette?: Palette | null;
} {
  const enabled = ($<HTMLInputElement>('player-color-enabled')).checked;
  return {
    player: Number(($<HTMLSelectElement>('player')).value),
    shadowAlpha: Number(($<HTMLInputElement>('shadow-alpha')).value),
    includeSecondary: ($<HTMLInputElement>('include-secondary')).checked,
    secondaryOnly: ($<HTMLInputElement>('secondary-only')).checked,
    playerColorOverride: enabled
      ? parseColorOverride($<HTMLInputElement>('player-color-override').value)
      : null,
    playerPalette: state?.playerPalette ?? null,
  };
}

function parseColorOverride(value: string): { r: number; g: number; b: number } | null {
  // <input type="color"> trả ra "#rrggbb".
  if (!/^#([0-9a-f]{6})$/i.test(value)) return null;
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function countNonTransparent(layer: IndexedLayer): number {
  let n = 0;
  for (let i = 0; i < layer.kind.length; i++) if (layer.kind[i] !== PixelKind.Transparent) n++;
  return n;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Map palette_id (frame_info.properties) sang tên palette AoE1:DE.
 * Tham chiếu: slp-files.md, section "AoE1 DE Palette IDs".
 */
const AOE1_DE_PALETTE_NAMES: Record<number, string> = {
  0x000000: 'Default (50500)',
  0x010000: '01_units',
  0x020000: '02_nature',
  0x030000: '03_buildings_stonetool',
  0x040000: '04_buildings_greek',
  0x050000: '05_buildings_babylon',
  0x060000: '06_buildings_roman',
  0x070000: '07_nature_tree_conifer',
  0x080000: '08_nature_tree_palms',
  0x090000: '09_buildings_asian',
  0x0a0000: '10_buildings_egypt',
  0x360000: 'effects',
  0x08000000: 'effects',
};

function describePaletteId(properties: number): string {
  const known = AOE1_DE_PALETTE_NAMES[properties >>> 0];
  if (known) return known;
  // AoK HD palette IDs
  if ((properties & 0x07) === 0x07) return '32-bit / (value & 7) == 0x07';
  return 'không rõ';
}

function setExportButtonsEnabled(on: boolean): void {
  for (const id of [
    'btn-export-png',
    'btn-export-all',
    'btn-export-sheet',
    'btn-export-meta',
    'btn-replace-frame',
    'btn-export-slp',
  ]) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = !on;
  }
}

function resizeImageDataNearest(
  src: ImageData,
  targetW: number,
  targetH: number,
): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return src;

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = src.width;
  srcCanvas.height = src.height;
  const sctx = srcCanvas.getContext('2d');
  if (!sctx) return src;
  sctx.putImageData(src, 0, 0);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(srcCanvas, 0, 0, src.width, src.height, 0, 0, targetW, targetH);
  return ctx.getImageData(0, 0, targetW, targetH);
}

export async function replaceSelectedFrame(file: File, state: ReadState): Promise<void> {
  if (!state.slp || state.selected < 0) return;
  const input = await readPngFile(file);
  const matcher = new PaletteMatcher(state.palette);
  const frame = state.slp.frames[state.selected];

  let imgData = input.imageData;
  let hotspots = {
    x: frame.main.hotspotX,
    y: frame.main.hotspotY,
  };

  // Nếu ảnh đầu vào lớn (vd ảnh gen từ AI 512x512, 1024x1024) → tự động co về kích thước frame gốc
  if (imgData.width > 200 || imgData.height > 200) {
    const targetW = frame.main.width || 64;
    const targetH = frame.main.height || 64;
    imgData = resizeImageDataNearest(imgData, targetW, targetH);
  } else if (imgData.width !== frame.main.width || imgData.height !== frame.main.height) {
    // Tự tính hotspot tỉ lệ nếu kích thước ảnh nhỏ khác kích thước gốc
    const scaleX = imgData.width / (frame.main.width || 1);
    const scaleY = imgData.height / (frame.main.height || 1);
    hotspots = {
      x: Math.round(frame.main.hotspotX * scaleX),
      y: Math.round(frame.main.hotspotY * scaleY),
    };
  }

  const newLayer = frameToIndexedLayer(imgData, 1, matcher, hotspots);
  frame.main = newLayer;
  state.renderCache.delete(state.selected);

  // Cập nhật thumbnail canvas
  const canvas = state.thumbs[state.selected];
  if (canvas) {
    const player = Number(($<HTMLSelectElement>('player')).value) || 1;
    const shadowAlpha = Number(($<HTMLInputElement>('shadow-alpha')).value);
    const includeSec = ($<HTMLInputElement>('include-secondary')).checked;
    const secOnly = ($<HTMLInputElement>('secondary-only')).checked;
    const override = parseColorOverride(($<HTMLInputElement>('player-color-override')).value);
    const img = renderFrame(frame.main, state.palette, frame.secondary, {
      player,
      shadowAlpha,
      includeSecondary: includeSec,
      secondaryOnly: secOnly,
      playerColorOverride: override,
      playerPalette: state.playerPalette,
    });
    const scale = Math.min(1, 100 / img.width);
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.style.width = `${Math.max(1, Math.round(img.width * scale))}px`;
    canvas.style.height = `${Math.max(1, Math.round(img.height * scale))}px`;
    canvas.title = `Frame ${state.selected}: ${img.width}×${img.height}, hotspot (${frame.main.hotspotX}, ${frame.main.hotspotY})`;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const label = canvas.nextElementSibling;
    if (label) label.textContent = `${state.selected} — ${img.width}×${img.height}`;
  }

  selectFrame(state.selected, state);
}

export function exportSlpFile(state: ReadState): void {
  if (!state.slp) return;
  try {
    const buf = buildEditedSlp(state.slp);
    const blob = new Blob([buf.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    downloadBlob(blob, `edited_${sanitizeFilename(state.slp.version)}.slp`);
  } catch (error) {
    const notice = $<HTMLElement>('remap-result');
    notice.dataset.tone = 'error';
    setText(notice, `Không xuất SLP: ${(error as Error).message}`);
    show(notice);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob thất bại'))), 'image/png');
  });
}

async function renderToPng(
  layer: IndexedLayer,
  state: ReadState,
  secondary?: SlpFrame['secondary'],
): Promise<Blob> {
  const img = renderFrame(layer, state.palette, secondary, {
    ...readRenderOptions(),
    playerPalette: state.playerPalette,
  });
  const canvas = makeCanvas(img);
  return canvasToPng(canvas);
}

export async function exportSelectedPng(state: ReadState): Promise<void> {
  if (!state.slp || state.selected < 0) return;
  const frame = state.slp.frames[state.selected];
  const blob = await renderToPng(frame.main, state, frame.secondary);
  downloadBlob(blob, `frame_${String(frame.index).padStart(4, '0')}.png`);
}

export async function exportAllPng(state: ReadState): Promise<void> {
  if (!state.slp) return;
  const zip = new JSZip();
  const metadata: Array<{ index: number; width: number; height: number; hotspot: [number, number] }> = [];

  for (const frame of state.slp.frames) {
    const blob = await renderToPng(frame.main, state, frame.secondary);
    zip.file(`frame_${String(frame.index).padStart(4, '0')}.png`, blob);
    metadata.push({
      index: frame.index,
      width: frame.main.width,
      height: frame.main.height,
      hotspot: [frame.main.hotspotX, frame.main.hotspotY],
    });
  }
  zip.file('metadata.json', JSON.stringify({ version: state.slp.version, frames: metadata }, null, 2));
  const out = await zip.generateAsync({ type: 'blob' });
  downloadBlob(out, `${sanitizeFilename(state.slp.version)}.zip`);
}

export async function exportSpritesheet(state: ReadState, columns = 16): Promise<void> {
  if (!state.slp) return;
  const frames = state.slp.frames;
  if (frames.length === 0) return;
  const cellW = Math.max(...frames.map((f: SlpFrame) => f.main.width));
  const cellH = Math.max(...frames.map((f: SlpFrame) => f.main.height));
  const rows = Math.ceil(frames.length / columns);
  const canvas = document.createElement('canvas');
  canvas.width = cellW * columns;
  canvas.height = cellH * rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D không khả dụng.');
  for (const frame of frames) {
    const img = renderFrame(frame.main, state.palette, frame.secondary, {
      ...readRenderOptions(),
      playerPalette: state.playerPalette,
    });
    const data = new Uint8ClampedArray(img.data);
    const imageData = new ImageData(data, img.width, img.height);
    const tmp = document.createElement('canvas');
    tmp.width = img.width;
    tmp.height = img.height;
    const tctx = tmp.getContext('2d');
    if (!tctx) continue;
    tctx.putImageData(imageData, 0, 0);
    const col = frame.index % columns;
    const row = Math.floor(frame.index / columns);
    ctx.drawImage(tmp, col * cellW, row * cellH);
  }
  const blob = await canvasToPng(canvas);
  downloadBlob(blob, `${sanitizeFilename(state.slp.version)}-spritesheet.png`);
}

export function exportMetadata(state: ReadState): void {
  if (!state.slp) return;
  const data = state.slp.frames.map((f: SlpFrame) => ({
    index: f.index,
    width: f.main.width,
    height: f.main.height,
    hotspot: [f.main.hotspotX, f.main.hotspotY],
    secondary: f.secondary
      ? {
          frameType: f.secondary.frameType,
          width: f.secondary.width,
          height: f.secondary.height,
          hotspot: [f.secondary.hotspotX, f.secondary.hotspotY],
        }
      : null,
  }));
  const blob = new Blob([JSON.stringify({ version: state.slp.version, frames: data }, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, `${sanitizeFilename(state.slp.version)}-metadata.json`);
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_');
}

export async function loadPalette(file: File, state: ReadState, target: 'read' | 'import'): Promise<void> {
  state.palette = await readPaletteFile(file);
  refreshPaletteBar(state.palette, state.playerPalette);
  if (target === 'import') {
    setText($<HTMLElement>('palette-name-import'), `(${state.palette.name} — ${state.palette.size} màu)`);
  }
  if (target === 'read' && state.slp) {
    state.renderCache.clear();
    renderThumbs(state.slp, state);
  }
}

/** Nạp palette riêng cho Player color (AoE1:DE). */
export async function loadPlayerPalette(file: File, state: ReadState): Promise<void> {
  state.playerPalette = await readPaletteFile(file);
  const bar = $<HTMLDivElement>('palette-bar-player');
  bar.innerHTML = '';
  for (let i = 0; i < state.playerPalette.size; i++) {
    const span = document.createElement('span');
    const d = state.playerPalette.data;
    span.style.background = `rgb(${d[i * 3]}, ${d[i * 3 + 1]}, ${d[i * 3 + 2]})`;
    bar.appendChild(span);
  }
  bar.hidden = false;
  setText(
    $<HTMLElement>('palette-name'),
    `(chính: ${state.palette.name} — player: ${state.playerPalette.name})`,
  );
  refreshPlayerPreview(state.palette, state.playerPalette);
  if (state.slp) {
    state.renderCache.clear();
    renderThumbs(state.slp, state);
  }
}
