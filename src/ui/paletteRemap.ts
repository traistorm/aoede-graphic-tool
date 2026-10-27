import { getColor, type Palette } from '../core/palette';
import { getPaletteUsage, remapSlpPalette, type PaletteRemapOptions } from '../core/paletteRemap';
import { renderFrame } from '../core/render';
import type { SlpFile } from '../core/types';
import { readRenderOptions, type ReadState } from './app';
import { $, hide, show, writeToCanvas } from './dom';

/** Draft edits live in the dialog; cancel never writes back to the loaded SLP. */
export function createPaletteRemapUI(state: ReadState, redraw: () => void): { refresh: () => void } {
  const dialog = $<HTMLDialogElement>('remap-dialog');
  const launch = $<HTMLButtonElement>('btn-remap-palette');
  const scope = $<HTMLSelectElement>('remap-scope');
  const source = $<HTMLSelectElement>('remap-source');
  const target = $<HTMLSelectElement>('remap-target');
  const add = $<HTMLButtonElement>('remap-add');
  const apply = $<HTMLButtonElement>('remap-apply');
  const status = $<HTMLElement>('remap-status');
  const result = $<HTMLElement>('remap-result');
  const grid = $<HTMLElement>('remap-colors');
  const rows = $<HTMLElement>('remap-mappings');
  let baseline: SlpFile | null = null;
  let palette: Palette = state.palette;
  let selected = -1;
  let lastFile: SlpFile | null = null;
  let draft: SlpFile | null = null;
  let changedPixels = 0;
  let mapping = new Map<number, number>();
  let usage: Array<{ index: number; count: number }> = [];

  function options(): PaletteRemapOptions {
    return scope.value === 'all' ? {} : { frameIndices: [selected] };
  }

  function color(index: number): string {
    const { r, g, b } = getColor(palette, index);
    return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
  }

  function chip(index: number): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = 'remap-chip';
    el.style.backgroundColor = color(index);
    el.title = `#${index} · ${color(index)}`;
    return el;
  }

  function updatePickers(): void {
    add.disabled = source.value === '' || target.value === '' || source.value === target.value;
    for (const [id, control] of [['remap-source-chip', source], ['remap-target-chip', target]] as const) {
      const el = $<HTMLElement>(id);
      el.style.backgroundColor = control.value === '' ? 'transparent' : color(Number(control.value));
      el.title = control.value === '' ? 'Không có màu' : color(Number(control.value));
    }
    for (const button of grid.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.index === target.value));
    }
  }

  function updatePreview(): void {
    if (!baseline) return;
    changedPixels = usage.reduce((n, entry) => n +
      (mapping.has(entry.index) && mapping.get(entry.index) !== entry.index ? entry.count : 0), 0);
    draft = mapping.size ? remapSlpPalette(baseline, mapping, options()) : null;
    const before = baseline.frames[selected];
    const after = draft?.frames[selected] ?? before;
    const opts = { ...readRenderOptions(state), secondaryOnly: false };
    for (const [id, frame] of [['remap-before', before], ['remap-after', after]] as const) {
      const canvas = $<HTMLCanvasElement>(id);
      writeToCanvas(canvas, renderFrame(frame.main, palette, frame.secondary, opts));
      canvas.style.width = `${Math.min(frame.main.width * 3, 280)}px`;
    }
    $<HTMLElement>('remap-preview-info').textContent =
      `Frame ${selected} · ${before.main.width}×${before.main.height}px · hotspot (${before.main.hotspotX}, ${before.main.hotspotY})`;
    apply.disabled = changedPixels === 0;
    status.textContent = usage.length === 0
      ? 'Không có pixel màu thường trong phạm vi này. Thử chọn toàn bộ frame.'
      : `${mapping.size} cặp màu · ${changedPixels.toLocaleString('vi-VN')} pixel sẽ đổi` +
        (scope.value === 'all' ? ` trên ${baseline.frames.length} frame. Xem trước frame ${selected}.` : ` trên frame ${selected}.`);
    if (palette.source === 'builtin') status.textContent += ' Đang dùng palette dự phòng; nạp palette game để xem đúng màu.';
  }

  function updateRows(): void {
    rows.replaceChildren();
    for (const [from, to] of mapping) {
      const row = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = `#${from} → #${to}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remap-quiet';
      remove.textContent = 'Bỏ';
      remove.setAttribute('aria-label', `Bỏ cặp màu ${from} sang ${to}`);
      remove.addEventListener('click', () => {
        mapping.delete(from);
        updateRows();
        updatePreview();
      });
      row.append(chip(from), text, chip(to), remove);
      rows.append(row);
    }
    $<HTMLElement>('remap-empty').hidden = mapping.size !== 0;
  }

  function updateScope(): void {
    if (!baseline) return;
    usage = getPaletteUsage(baseline, options());
    const old = source.value;
    source.replaceChildren();
    for (const entry of usage) {
      if (entry.index >= palette.size) continue;
      source.add(new Option(`#${entry.index} · ${color(entry.index)} · ${entry.count.toLocaleString('vi-VN')} px`, String(entry.index)));
    }
    if (Array.from(source.options).some(option => option.value === old)) source.value = old;
    source.disabled = source.options.length === 0;
    updatePickers();
    updateRows();
    updatePreview();
  }

  function refresh(): void {
    launch.disabled = !state.slp?.frames.length;
    if (lastFile !== state.slp) {
      hide(result);
      lastFile = state.slp;
    }
    if (dialog.open && (baseline !== state.slp || palette !== state.palette || selected !== state.selected)) {
      dialog.close();
      result.textContent = 'Dữ liệu hoặc palette đã thay đổi. Mở lại Đổi màu palette để xem trước.';
      show(result);
    }
  }

  launch.addEventListener('click', () => {
    if (!state.slp?.frames.length) return;
    baseline = state.slp;
    palette = state.palette;
    selected = state.selected >= 0 && state.selected < baseline.frames.length ? state.selected : 0;
    scope.value = 'current';
    mapping = new Map();
    target.replaceChildren();
    grid.replaceChildren();
    for (let index = 0; index < palette.size; index++) {
      target.add(new Option(`#${index} · ${color(index)}`, String(index)));
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.index = String(index);
      button.style.backgroundColor = color(index);
      button.title = `#${index} · ${color(index)}`;
      button.setAttribute('aria-label', `Chọn màu đích ${index}, ${color(index)}`);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => { target.value = String(index); updatePickers(); });
      grid.append(button);
    }
    updateScope();
    dialog.showModal();
  });
  scope.addEventListener('change', updateScope);
  source.addEventListener('change', updatePickers);
  target.addEventListener('change', updatePickers);
  add.addEventListener('click', () => {
    if (add.disabled) return;
    mapping.set(Number(source.value), Number(target.value));
    updateRows();
    updatePreview();
  });
  for (const id of ['remap-close', 'remap-cancel']) {
    $<HTMLButtonElement>(id).addEventListener('click', () => dialog.close());
  }
  dialog.addEventListener('close', () => { baseline = null; draft = null; mapping.clear(); });
  apply.addEventListener('click', () => {
    if (apply.disabled || !draft || baseline !== state.slp || palette !== state.palette) return;
    const next = draft;
    const count = changedPixels;
    const pairs = mapping.size;
    state.slp = next;
    state.renderCache.clear();
    dialog.close();
    redraw();
    result.textContent = `Đã đổi ${count.toLocaleString('vi-VN')} pixel với ${pairs} cặp màu. Có thể xuất PNG hoặc SLP bên trên; file gốc trên máy vẫn giữ nguyên.`;
    result.dataset.tone = 'success';
    show(result);
  });
  refresh();
  return { refresh };
}
