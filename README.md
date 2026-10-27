# SLP Studio

Web app client-side để **đọc, xuất ảnh và tạo file `.slp`** cho **Age of Empires 1 (1997)** và **AoE1: Definitive Edition**.

## Tính năng

1. **Đọc / parse file SLP** — kéo-thả hoặc chọn file `.slp`, tự nhận diện version `2.0N` / `3.0` / `4.0X` / `4.1X` / `4.2P` (container LZ4). Render lưới thumbnail + xem full-size từng frame.
2. **Export ảnh** — xuất PNG, đóng gói ZIP (nhiều frame + `metadata.json`), ghép spritesheet, tải `metadata.json` riêng. Tất cả xử lý trong trình duyệt, không upload lên server.
3. **Import ảnh → tạo file SLP** — nhận nhiều PNG, map sang palette index, encode draw command tối ưu (Fill, Greater/Lesser draw/skip), ghi ra `.slp` 2.0N hoặc 4.0X. Tự **đọc lại file vừa build để validate pixel-by-pixel** trước khi cho tải xuống.
4. **Core remap chỉ số palette** — `remapSlpPalette()` thay chỉ số màu trên layer chính của một hoặc toàn bộ frame; `getPaletteUsage()` thống kê các màu đang dùng. Đây là API trong code, chưa có nút điều khiển trên giao diện và chưa tự đổi hue/giữ sắc độ theo màu đích.

### Remap màu bằng API core

```ts
import { getPaletteUsage, remapSlpPalette } from './src/core/paletteRemap';

// Chỉ số palette, không phải mã RGB/HEX. Thay đồng thời: 1 → 2, 2 → 3.
// frameIndices là vị trí trong slp.frames, không phải trường frame.index.
const edited = remapSlpPalette(slp, new Map([[1, 2], [2, 3]]), {
  frameIndices: [0, 1],
});
const colors = getPaletteUsage(edited); // count giảm dần, rồi index tăng dần
```

Bỏ `frameIndices` để chọn tất cả; `[]` chọn không frame nào; phần tử trùng
chỉ xử lý một lần. Key/value mapping phải là số nguyên `0..255`, vị trí frame
phải hợp lệ, nếu sai sẽ báo `SlpError`, kể cả mapping không được pixel nào dùng.

Chỉ pixel `PixelKind.Palette` trên main layer được đổi. Màu player, shadow,
outline, direct RGBA và layer phụ giữ nguyên; mọi object/typed array trong kết
quả được sao chép độc lập, không sửa file đã parse ban đầu. Hàm giữ metadata,
kích thước và hotspot, không thêm màu mới vào palette hoặc sửa file `.pal`.
Input phải là `SlpFile` đã parse hợp lệ. Bước ghi SLP vẫn do writer hiện có
thực hiện; chưa xác nhận kết quả remap trong game.

## Version hỗ trợ

| Version | Game | Ghi chú |
|---|---|---|
| `2.0N` | AoE1 gốc | Palette index 1 byte |
| `3.0` | AoE1:DE terrain/rescale | Palette index 1 byte |
| `4.0X` | AoE1:DE | Palette index 1 byte, có thể có layer phụ (shadow) |
| `4.1X` | AoE1:DE | Display modifier + palette index 2 byte |
| `4.2P` | AoE1:DE (Update 38862+) | Container LZ4 bọc ngoài file SLP — tự giải nén rồi parse tiếp |

## Bố cục project

```
src/
  core/           ← code thuần, không phụ thuộc DOM, test được trong Node
    types.ts        Định nghĩa struct, enum PixelKind, lỗi SlpError
    binary.ts       ByteReader / ByteWriter (LE, có bounds check, patch offset)
    commands.ts     Decoder draw command (pure, đã test đúng chuỗi byte mẫu trong spec)
    lz4.ts          LZ4 block decompression thuần JS (cho container 4.2P)
    palette.ts      Parser JASC-PAL + palette nhị phân 768 byte + PaletteMatcher
    paletteRemap.ts Remap palette index và thống kê màu, không sửa input
    slpReader.ts    parseSlp() — parse đầy đủ file SLP thành IndexedLayer
    render.ts       Render layer → RgbaImage (hỗ trợ player color override, shadow, layer phụ)
    slpWriter.ts    writeSlp() + validateRoundTrip() (đọc lại file vừa ghi, so khớp pixel)
  ui/
    dom.ts          Helper DOM tối giản
    app.ts          Tab Đọc & Export
    importer.ts     Tab Import & tạo SLP
    main.ts         Điểm vào, nối dây sự kiện
    styles.css      CSS dark theme
test/
  commands.test.ts   Test decode command theo ví dụ trong spec + edge cases
  palette.test.ts    Test JASC-PAL parser, PaletteMatcher, LZ4 block decompression
  paletteRemap.test.ts Test remap đồng thời, chọn frame, clone và validation
  slp.test.ts        Test encode, writeSlp, validateRoundTrip (55/55 pass)
index.html
package.json
tsconfig.json
vite.config.ts
```

## Cài & chạy

```bash
npm install
npm run dev          # vite dev server
npm run test         # vitest
npm run build        # tsc + vite build → dist/
npm run preview      # serve dist/
```

## Lưu ý kỹ thuật

- **Toàn bộ chạy phía client** — không có backend, không upload file `.slp` / `.pal` lên server. Dùng `File` API + `ArrayBuffer` + `<canvas>`.
- **Draw command** — nhận diện dựa trên 4 bit thấp, thứ tự kiểm tra quan trọng: `0x0F` (end of row) phải kiểm tra trước 2 bit thấp (`0b00` / `0b01`) để tránh nhầm với greater skip.
- **Pixel 2 byte của 4.1X** — spec không chính thức về thứ tự byte (modifier-first hay index-first). Có option `modifierFirst` trong `DecodeRowOptions` để chuyển nếu gặp SLP dùng thứ tự ngược lại.
- **Layer phụ (shadow / VFX alpha)** — đọc cùng lệnh nhưng 1 byte/pixel. Shadow quy đổi ra alpha theo `alpha = 255 - (value << 2)`. VFX alpha giữ nguyên giá trị.
- **Container 4.2P** — header 8 byte, sau đó LZ4 block format (không phải LZ4 frame format). Nếu file dùng frame format (`0x04224d18`) thì báo lỗi rõ ràng.
- **Round-trip validation** — sau khi ghi file, app tự parse lại bằng chính `parseSlp()` rồi so từng pixel. Nếu lệch thì báo frame/dòng/cột cụ thể trước khi cho tải file.

## Bảo mật

File SLP/palette là dữ liệu game của người dùng. Toàn bộ pipeline chạy trong trình duyệt, không gửi đi đâu cả. App có thể chạy hoàn toàn offline (mở `dist/index.html` từ file:// cũng được).
