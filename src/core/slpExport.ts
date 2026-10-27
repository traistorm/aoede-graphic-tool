import { parseSlp } from './slpReader';
import { validateRoundTrip, writeSlp, type WritableFrame, type WriteVersion } from './slpWriter';
import { SlpError, type SlpFile } from './types';

/** Export indexed edits, retaining palette IDs instead of substituting writer defaults. */
export function buildEditedSlp(slp: SlpFile): Uint8Array {
  if (!['2.0N', '3.0', '4.0X'].includes(slp.version)) {
    throw new SlpError('Chưa hỗ trợ ghi SLP ' + slp.version + '. Xuất PNG để giữ dữ liệu, không chuyển ngầm sang định dạng khác.');
  }
  if (slp.frames.some(frame => frame.main.modifier || frame.main.rgba || frame.secondary?.modifier || frame.secondary?.rgba)) {
    throw new SlpError('File có modifier hoặc RGBA mà writer indexed chưa hỗ trợ. Hãy xuất PNG.');
  }
  const version: WriteVersion = slp.version === '4.0X' ? '4.0X' : '2.0N';
  const frames: WritableFrame[] = slp.frames.map(frame => ({
    ...frame.main,
    properties: frame.info.properties,
    secondary: frame.secondary ? { ...frame.secondary, properties: frame.secondaryInfo?.properties } : undefined,
  }));
  const buffer = writeSlp(frames, {
    version,
    comment: slp.header.comment,
    type: slp.header.type,
    paletteId: slp.header.paletteId,
    numDirections: slp.header.numDirections,
    framesPerDirection: slp.header.framesPerDirection,
    includeSecondary: true,
  });
  const validation = validateRoundTrip(buffer, frames);
  if (!validation.ok) throw new SlpError('Không xuất file vì kiểm tra đọc lại thất bại.', validation.message);
  const parsed = parseSlp(buffer);
  for (const [i, frame] of slp.frames.entries()) {
    const actual = parsed.frames[i];
    if (actual.info.properties !== frame.info.properties) throw new SlpError(`Palette ID không khớp ở frame ${i}.`);
    if (frame.secondary) {
      const a = actual.secondary;
      const b = frame.secondary;
      if (!a || a.width !== b.width || a.height !== b.height || a.hotspotX !== b.hotspotX || a.hotspotY !== b.hotspotY ||
          a.frameType !== b.frameType || a.kind.some((v, p) => v !== b.kind[p]) || a.value.some((v, p) => v !== b.value[p]) ||
          actual.secondaryInfo?.properties !== (frame.secondaryInfo?.properties ?? 0)) {
        throw new SlpError(`Layer phụ không khớp ở frame ${i}; chưa tải file xuống.`);
      }
    }
  }
  return buffer;
}
