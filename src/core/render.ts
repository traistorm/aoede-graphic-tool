import { getColor, type Palette } from './palette';
import { PixelKind, type IndexedLayer, type SecondaryLayer } from './types';

/** Ảnh RGBA thuần, không phụ thuộc DOM (để test được trong Node). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface RenderOptions {
  /** Player 0..7 — index thật = value + player * 16. */
  player?: number;
  /** Ghi đè màu player bằng màu tuỳ chọn thay vì tra palette. */
  playerColorOverride?: { r: number; g: number; b: number } | null;
  /** Alpha cho pixel Shadow draw của layer chính (0..255). */
  shadowAlpha?: number;
  /** Vẽ kèm layer phụ (shadow / VFX alpha) nếu có. */
  includeSecondary?: boolean;
  /** Chỉ vẽ layer phụ (dùng khi muốn export riêng shadow). */
  secondaryOnly?: boolean;
  /**
   * Palette riêng cho Player color (AoE1:DE dùng palette tách biệt).
   * Nếu có, pixel Player/OutlinePlayer lấy màu từ palette này theo
   * `value + player * 16` — bỏ qua slice của palette chính.
   */
  playerPalette?: Palette | null;
}

const DEFAULT_SHADOW_ALPHA = 128;

/** Render layer chính (kèm layer phụ nếu bật) ra ảnh RGBA. */
export function renderFrame(
  main: IndexedLayer,
  palette: Palette,
  secondary?: SecondaryLayer,
  options: RenderOptions = {},
): RgbaImage {
  const { width, height } = main;
  const out: RgbaImage = {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };

  if (secondary && (options.includeSecondary || options.secondaryOnly)) {
    // Căn theo hotspot: mainX = secX - secHotspotX + mainHotspotX
    const dx = main.hotspotX - secondary.hotspotX;
    const dy = main.hotspotY - secondary.hotspotY;
    blitSecondary(out, secondary, dx, dy);
  }

  if (!options.secondaryOnly) {
    blitMain(out, main, palette, options);
  }

  return out;
}

/** Render riêng layer phụ ở đúng kích thước của nó. */
export function renderSecondary(secondary: SecondaryLayer): RgbaImage {
  const out: RgbaImage = {
    width: secondary.width,
    height: secondary.height,
    data: new Uint8ClampedArray(secondary.width * secondary.height * 4),
  };
  blitSecondary(out, secondary, 0, 0);
  return out;
}

function blitMain(
  out: RgbaImage,
  layer: IndexedLayer,
  palette: Palette,
  options: RenderOptions,
): void {
  const player = clamp(options.player ?? 1, 1, 8);
  const shadowAlpha = options.shadowAlpha ?? DEFAULT_SHADOW_ALPHA;
  const override = options.playerColorOverride ?? null;
  const playerPal = options.playerPalette ?? null;
  const total = layer.width * layer.height;

  for (let i = 0; i < total; i++) {
    const kind = layer.kind[i] as PixelKind;
    if (kind === PixelKind.Transparent) continue;

    const p = i * 4;
    switch (kind) {
      case PixelKind.Palette: {
        const c = getColor(palette, layer.value[i]);
        writePixel(out.data, p, c.r, c.g, c.b, 255);
        break;
      }
      case PixelKind.Player:
      case PixelKind.OutlinePlayer: {
        const base = kind === PixelKind.OutlinePlayer ? 0 : layer.value[i];
        if (override) {
          // Giữ lại sắc độ trong dải 16 bậc của player color.
          const shade = 0.35 + 0.65 * ((base % 16) / 15);
          writePixel(
            out.data,
            p,
            override.r * shade,
            override.g * shade,
            override.b * shade,
            255,
          );
        } else if (playerPal) {
          // AoE1:DE: mỗi player có 1 file palette riêng (vd playercolor_blue.pal);
          // 16 shade của player nằm ở index 0..15, KHÔNG cần +player*16.
          const c = getColor(playerPal, base);
          writePixel(out.data, p, c.r, c.g, c.b, 255);
        } else {
          // AoE1 cổ điển / AoK / SWGB: player color là slice 16+(player-1)*16..+15
          // của palette chính.
          const c = getColor(palette, base + player * 16);
          writePixel(out.data, p, c.r, c.g, c.b, 255);
        }
        break;
      }
      case PixelKind.OutlineSpecial: {
        const c = getColor(palette, layer.value[i]);
        writePixel(out.data, p, c.r, c.g, c.b, 255);
        break;
      }
      case PixelKind.Shadow: {
        writePixel(out.data, p, 0, 0, 0, shadowAlpha);
        break;
      }
      case PixelKind.Direct: {
        if (layer.rgba) {
          writePixel(out.data, p, layer.rgba[p], layer.rgba[p + 1], layer.rgba[p + 2], layer.rgba[p + 3]);
        }
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Layer phụ:
 *  - Shadow (frameType 0x02): shadow_alpha = 255 - (shadow_value << 2), màu đen.
 *  - VFX alpha: giữ nguyên giá trị làm alpha, hiển thị dạng mask trắng.
 */
function blitSecondary(out: RgbaImage, layer: SecondaryLayer, dx: number, dy: number): void {
  const isShadow = layer.frameType === 0x02 || layer.frameType === 0x00;
  for (let y = 0; y < layer.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= out.height) continue;
    for (let x = 0; x < layer.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= out.width) continue;
      const src = y * layer.width + x;
      if (layer.kind[src] === PixelKind.Transparent) continue;

      const v = layer.value[src] & 0xff;
      const alpha = isShadow ? clamp(255 - (v << 2), 0, 255) : clamp(v, 0, 255);
      if (alpha <= 0) continue;
      const p = (ty * out.width + tx) * 4;
      if (isShadow) writePixel(out.data, p, 0, 0, 0, alpha);
      else writePixel(out.data, p, 255, 255, 255, alpha);
    }
  }
}

function writePixel(
  data: Uint8ClampedArray,
  p: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const srcA = a / 255;
  if (srcA >= 1 || data[p + 3] === 0) {
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = a;
    return;
  }
  // Alpha blend "source-over" cho trường hợp main vẽ đè lên shadow.
  const dstA = data[p + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) {
    data[p + 3] = 0;
    return;
  }
  data[p] = (r * srcA + data[p] * dstA * (1 - srcA)) / outA;
  data[p + 1] = (g * srcA + data[p + 1] * dstA * (1 - srcA)) / outA;
  data[p + 2] = (b * srcA + data[p + 2] * dstA * (1 - srcA)) / outA;
  data[p + 3] = outA * 255;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
