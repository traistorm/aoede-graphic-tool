import {
  createReadState,
  exportAllPng,
  exportMetadata,
  exportSelectedPng,
  exportSlpFile,
  exportSpritesheet,
  handleSlpFile,
  loadPalette,
  readRenderOptions,
  refreshPaletteBar,
  refreshPlayerPreview,
  replaceSelectedFrame,
} from './app';
import {
  buildAndValidate,
  clearImport,
  downloadBuiltSlp,
  readImportFile,
  readPaletteFile,
  setImportPalette,
} from './importer';
import { $, hide, setText, show } from './dom';
import { type Palette, createFallbackPalette, loadPaletteFromUrl } from '../core/palette';
import { type IndexedLayer, type SecondaryLayer, type SlpFile, PixelKind } from '../core/types';
import { renderFrame } from '../core/render';
import { encodeRow } from '../core/slpWriter';
import { createPaletteRemapUI } from './paletteRemap';

const readState = createReadState();
const remapUI = createPaletteRemapUI(readState, reRenderVisible);
readState.onSelectionChanged = remapUI.refresh;
let importPalette: Palette = createFallbackPalette();
refreshPaletteBar(readState.palette, readState.playerPalette);

// Kh�i tạo dropdown palette từ manifest. Nếu chạy qua file://, fetch sẽ fail
// → dropdown rỗng, user vẫn dùng được file picker.
interface PalEntry {
  id?: number;
  player?: number;
  file: string;
  label?: string;
  name?: string;
  description?: string;
}
interface PalManifest {
  main?: PalEntry[];
  playerColor?: PalEntry[];
}

/** AoE1:DE player → tên file playercolor_*.pal */
const PLAYER_COLOR_FILES: Record<number, string> = {
  1: 'playercolor_blue.pal',
  2: 'playercolor_red.pal',
  3: 'playercolor_yellow.pal',
  4: 'playercolor_brown.pal',
  5: 'playercolor_orange.pal',
  6: 'playercolor_green.pal',
  7: 'playercolor_purple.pal',
  8: 'playercolor_teal.pal',
};

let initPromise: Promise<void> | null = null;

function initApp(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const r = await fetch('palettes/manifest.json');
        if (r.ok) {
          const manifest = (await r.json()) as PalManifest;
          const mainSel = $<HTMLSelectElement>('pal-main');
          for (const e of manifest.main ?? []) {
            const opt = document.createElement('option');
            opt.value = e.file;
            opt.textContent = `0x${(e.id ?? 0)
              .toString(16)
              .padStart(2, '0')} — ${e.name}${e.description ? ' (' + e.description + ')' : ''}`;
            opt.dataset.file = e.file;
            mainSel.appendChild(opt);
          }
          // Auto-chọn 01_units nếu có.
          const def = (manifest.main ?? []).find((e) => e.file === '01_units.pal');
          if (def) {
            mainSel.value = def.file;
            await pickPaletteFile(def.file, 'main');
          }
        }
      } catch {
        // Không có manifest (vd. chạy qua file://) → bỏ qua.
      }
      // Luôn load playercolor palette cho Player đang chọn (mặc định Player 1 - Blue)
      const playerVal = Number(($<HTMLSelectElement>('player')).value) || 1;
      await loadPlayerColorFor(playerVal);
    })();
  }
  return initPromise;
}

// Bắt đầu khởi tạo ngay
initApp();

/** Fetch palette theo tên file trong folder palettes/ rồi apply. */
async function pickPaletteFile(file: string, target: 'main' | 'player'): Promise<void> {
  try {
    const pal = await loadPaletteFromUrl(`palettes/${file}`, file);
    if (target === 'main') {
      readState.palette = pal;
    } else {
      readState.playerPalette = pal;
    }
    refreshPaletteBar(readState.palette, readState.playerPalette);
    refreshPlayerPreview(readState.palette, readState.playerPalette);
    updatePaletteName();
    if (readState.slp) reRenderVisible();
  } catch (err) {
    setText($<HTMLElement>('palette-name'), `❌ ${(err as Error).message}`);
  }
}

function updatePaletteName(): void {
  const mode = readState.playerPalette ? 'AoE1:DE (player palette riêng)' : 'slice 16+(player-1)*16';
  setText(
    $<HTMLElement>('palette-name'),
    `(chính: ${readState.palette.name}${readState.playerPalette ? ' — player: ' + readState.playerPalette.name : ''} — mode: ${mode})`,
  );
}

/** Load playercolor_X.pal cho player N từ folder palettes/. */
async function loadPlayerColorFor(playerN: number): Promise<void> {
  const file = PLAYER_COLOR_FILES[playerN];
  if (!file) return;
  await pickPaletteFile(file, 'player');
}

/** Tự động chọn palette chính phù hợp với Palette ID của file SLP (nếu có trong manifest). */
async function tryAutoSelectMainPalette(slp: SlpFile): Promise<void> {
  if (!slp.frames.length) return;
  const prop = slp.frames[0].info.properties >>> 0;
  const map: Record<number, string> = {
    0x010000: '01_units.pal',
    0x020000: '02_nature.pal',
    0x030000: '03_buildings_stonetool.pal',
    0x040000: '04_buildings_greek.pal',
    0x050000: '05_buildings_babylon.pal',
    0x060000: '06_buildings_roman.pal',
    0x070000: '07_nature_tree_conifers.pal',
    0x080000: '08_nature_tree_palms.pal',
    0x090000: '09_buildings_asian.pal',
    0x0a0000: '10_buildings_egypt.pal',
    0x360000: 'effects.pal',
    0x08000000: 'effects.pal',
  };
  const targetFile = map[prop];
  if (!targetFile) return;
  const mainSel = $<HTMLSelectElement>('pal-main');
  if (mainSel.value !== targetFile) {
    const hasOpt = Array.from(mainSel.options).some((o) => o.value === targetFile);
    if (hasOpt) {
      mainSel.value = targetFile;
      await pickPaletteFile(targetFile, 'main');
    }
  }
}

// ---- Tab switching ----
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
const panels: Record<string, HTMLElement> = {
  read: $<HTMLElement>('panel-read'),
  import: $<HTMLElement>('panel-import'),
  about: $<HTMLElement>('panel-about'),
};
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab!;
    for (const t of tabs) t.setAttribute('aria-selected', String(t === tab));
    for (const key of Object.keys(panels)) {
      if (key === name) show(panels[key]);
      else hide(panels[key]);
    }
  });
}

async function onSlpFileLoaded(file: File): Promise<void> {
  const p = Number(($<HTMLSelectElement>('player')).value) || 1;
  await loadPlayerColorFor(p);
  await handleSlpFile(file, readState);
  if (readState.slp) {
    await tryAutoSelectMainPalette(readState.slp);
  }
  await loadPlayerColorFor(p);
  reRenderVisible();
}

// ---- Tab Đọc: dropzone, file, palette, render options ----
attachDragDrop($<HTMLDivElement>('dropzone-slp'), async (files) => {
  if (files[0]) {
    await onSlpFileLoaded(files[0]);
  }
});

$<HTMLInputElement>('file-slp').addEventListener('change', async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (input.files?.[0]) {
    await onSlpFileLoaded(input.files[0]);
  }
  input.value = '';
});

$<HTMLInputElement>('file-pal').addEventListener('change', async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (input.files?.[0]) await loadPalette(input.files[0], readState, 'read');
  input.value = '';
});

$<HTMLSelectElement>('pal-main').addEventListener('change', (e) => {
  const file = (e.currentTarget as HTMLSelectElement).value;
  if (file) pickPaletteFile(file, 'main');
});

/** Khi user đổi Player dropdown → tự fetch playercolor tương ứng. */
document.getElementById('player')!.addEventListener('change', async (e) => {
  const n = Number((e.currentTarget as HTMLSelectElement).value) || 1;
  await loadPlayerColorFor(n);
});

for (const id of [
  'player-color-enabled',
  'player-color-override',
  'shadow-alpha',
  'include-secondary',
  'secondary-only',
]) {
  const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
  const event = el.tagName === 'INPUT' && (el.type === 'range' || el.type === 'color') ? 'input' : 'change';
  el.addEventListener(event, () => {
    refreshPlayerPreview(readState.palette, readState.playerPalette);
    reRenderVisible();
  });
  el.addEventListener('change', () => {
    refreshPlayerPreview(readState.palette, readState.playerPalette);
    reRenderVisible();
  });
}

function reRenderVisible(): void {
  remapUI.refresh();
  if (!readState.slp) return;
  const opts = readRenderOptions(readState);
  for (const [i, canvas] of readState.thumbs.entries()) {
    const frame = readState.slp.frames[i];
    const img = renderFrame(frame.main, readState.palette, frame.secondary, opts);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  }
  const idx = readState.selected;
  if (idx >= 0) {
    const frame = readState.slp.frames[idx];
    const img = renderFrame(frame.main, readState.palette, frame.secondary, opts);
    const canvas = $<HTMLCanvasElement>('canvas-full');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  }
}

function renderFrameFor(frame: { main: IndexedLayer; secondary?: SecondaryLayer }) {
  return renderFrame(frame.main, readState.palette, frame.secondary, readRenderOptions(readState));
}

// ---- Export ----
$<HTMLButtonElement>('btn-export-png').addEventListener('click', () => exportSelectedPng(readState));
$<HTMLButtonElement>('btn-export-all').addEventListener('click', () => exportAllPng(readState));
$<HTMLButtonElement>('btn-export-sheet').addEventListener('click', () => exportSpritesheet(readState));
$<HTMLButtonElement>('btn-export-meta').addEventListener('click', () => exportMetadata(readState));

$<HTMLButtonElement>('btn-replace-frame').addEventListener('click', () => {
  $<HTMLInputElement>('file-replace-frame').click();
});
$<HTMLInputElement>('file-replace-frame').addEventListener('change', async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (input.files?.[0]) {
    await replaceSelectedFrame(input.files[0], readState);
  }
  input.value = '';
});
$<HTMLButtonElement>('btn-export-slp').addEventListener('click', () => exportSlpFile(readState));

// ---- Tab Import ----
attachDragDrop($<HTMLDivElement>('dropzone-png'), async (files) => {
  await readImportFile(files);
});

$<HTMLInputElement>('file-png').addEventListener('change', async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (input.files) await readImportFile(input.files);
  input.value = '';
});

$<HTMLInputElement>('file-pal-import').addEventListener('change', async (e) => {
  const input = e.currentTarget as HTMLInputElement;
  if (input.files?.[0]) {
    importPalette = await readPaletteFile(input.files[0]);
    setImportPalette(importPalette);
    setText($<HTMLElement>('palette-name-import'), `(${importPalette.name} — ${importPalette.size} màu)`);
  }
  input.value = '';
});

$<HTMLButtonElement>('btn-clear-import').addEventListener('click', () => clearImport());

$<HTMLButtonElement>('btn-build-slp').addEventListener('click', async () => {
  const result = await buildAndValidate();
  const out = $<HTMLElement>('import-result');
  if (result.ok && result.buffer) {
    setText(out, `✅ ${result.message}`);
    show(out);
    downloadBuiltSlp(result);
  } else {
    const list = (result.issues ?? [])
      .slice(0, 10)
      .map(
        (i) =>
          `<tr><td>${i.frame}</td><td>${i.row}</td><td>${i.column}</td><td>${i.expected}</td><td>${i.actual}</td></tr>`,
      )
      .join('');
    out.innerHTML = `❌ ${result.message}${
      list ? `<table><thead><tr><th>Frame</th><th>Dòng</th><th>Cột</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${list}</tbody></table>` : ''
    }`;
    show(out);
  }
});

function attachDragDrop(zone: HTMLElement, handler: (files: File[]) => Promise<void> | void): void {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    if (!e.dataTransfer) return;
    await handler(Array.from(e.dataTransfer.files));
  });
}

// Giữ tham chiếu để tránh linter báo unused, dùng khi debug.
void renderFrameFor;
void PixelKind;
void encodeRow;
