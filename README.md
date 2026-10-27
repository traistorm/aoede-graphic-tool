# SLP Studio

Web app client-side để **đọc, xuất ảnh và tạo file `.slp`** cho **Age of Empires 1 (1997)** và **AoE1: Definitive Edition**.

## Tính năng

1. **Đọc / parse file SLP** — kéo-thả hoặc chọn file `.slp`, tự nhận diện version `2.0N` / `3.0` / `4.0X` / `4.1X` / `4.2P` (container LZ4). Render lưới thumbnail + xem full-size từng frame.
2. **Export ảnh** — xuất PNG, đóng gói ZIP (nhiều frame + `metadata.json`), ghép spritesheet, tải `metadata.json` riêng. Tất cả xử lý trong trình duyệt, không upload lên server.
3. **Import ảnh → tạo file SLP** — nhận nhiều PNG, map sang palette index, encode draw command tối ưu (Fill, Greater/Lesser draw/skip), ghi ra `.slp` 2.0N hoặc 4.0X. Tự **đọc lại file vừa build để validate pixel-by-pixel** trước khi cho tải xuống.
4. **Đổi màu palette** — nút trong tab Đọc & Export, chọn frame hiện tại hoặc toàn bộ, ghép nhiều cặp màu nguồn → đích rồi xem trước/áp dụng. Chỉ thay màu thường trên layer chính, giữ kích thước, hotspot, màu player và layer phụ.

### Đổi màu trên giao diện

1. Nạp SLP và palette game phù hợp, chọn frame để xem trước.
2. Bấm **Đổi màu palette**, chọn phạm vi áp dụng.
3. Chọn màu nguồn đang dùng và màu đích từ dropdown hoặc bảng màu, bấm **Thêm / cập nhật cặp màu**. Có thể ghép nhiều sắc độ sáng/tối trong cùng lượt; các cặp được thay đồng thời.
4. Đối chiếu ảnh **Trước / Sau** và số pixel thay đổi. **Hủy**, nút đóng hoặc Escape bỏ bản nháp; **Áp dụng đổi màu** cập nhật dữ liệu đang mở, không ghi đè file gốc.
5. Xuất PNG hoặc **Xuất file .SLP**. SLP được đọc lại để kiểm pixel, hotspot, palette ID từng frame và layer phụ trước khi tải xuống.

Đây là thay chỉ số màu có sẵn, chưa tự đổi hue/giữ sắc độ theo một màu RGB đích và không thêm màu vào palette. Nên ghép nhiều cặp sáng/tối để giữ chiều sâu. Nếu chưa nạp palette game, ảnh dùng palette dự phòng và có cảnh báo.

Ghi SLP đã chỉnh hỗ trợ `2.0N`, `3.0` (xuất thành `2.0N`) và `4.0X`; container `4.2P` xuất thành phiên bản bên trong đã giải nén. `4.1X`, dữ liệu modifier hoặc direct RGBA chưa được writer hỗ trợ: app báo lỗi thay vì tải file mất dữ liệu; có thể xuất PNG. Chưa kiểm tra file đổi màu trong game.

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
Input phải là `SlpFile` đã parse hợp lệ. Dùng `buildEditedSlp()` trong
`src/core/slpExport.ts` để ghi lại file đã chỉnh với bước kiểm tra đọc lại.

## Palette chuyển tông: mẫu hoa anh đào

### Phân biệt hai cách đổi màu

| Cách | Thay đổi gì? | Cần palette mới? | Trạng thái |
|---|---|---|---|
| Remap index | Ví dụ pixel đang trỏ ô 8 chuyển sang ô 73; RGB của các ô không đổi | Không, nếu màu đích đã có trong palette đang dùng | Đã có nút **Đổi màu palette** |
| Chuyển tông palette | Pixel vẫn trỏ ô 8, nhưng RGB tại ô 8 trong bản palette riêng đổi từ xanh sang hồng | Có, phải giữ file palette đi kèm | Đã thử bằng script ngoài repo; **chưa có chức năng tạo/xuất palette trên UI** |

Mẫu hoa anh đào dùng cách thứ hai vì palette `02_nature.pal` gốc gần như không có
dải hồng sáng phù hợp. Không dùng AI sinh ảnh, không phóng to rồi thu nhỏ sprite,
không thêm ô màu thứ 257 và không sửa palette gốc. Các hình so sánh phóng lớn chỉ
để xem, dùng nearest-neighbor; PNG xuất riêng vẫn giữ kích thước thật.

### Thuật toán đã dùng, đủ để tái tạo

Đầu vào là bản sao palette 256 màu đã parse bằng `parseJascPal()`; không sửa trực
tiếp `palette.data` của bản gốc. Với mỗi ô RGB, chuẩn hóa ba kênh về `0..1`, tính
HSV và chỉ chọn ô thỏa **đồng thời**:

- Hue trong `[49°, 175°]`: vàng xanh đến xanh lá.
- Chênh lệch `max(R,G,B) - min(R,G,B) >= 0.035`.
- Saturation `>= 0.22`.

Tính độ sáng có trọng số trên các kênh sRGB đã chuẩn hóa:
`y = 0.2126R + 0.7152G + 0.0722B`. Đây là đại lượng dùng cho hiệu ứng thử,
không phải phép đo luminance tuyến tính hay bảo toàn độ sáng vật lý.
Đặt `t = min(1, (y / 0.75)^0.72)`, nội suy tuyến tính lần lượt qua năm mốc RGB:

| Vị trí | RGB | Vai trò |
|---|---|---|
| 0 | `62, 29, 47` | Bóng hồng sẫm |
| 0.25 | `148, 64, 102` | Hồng đậm |
| 0.5 | `222, 133, 167` | Hồng trung gian |
| 0.75 | `255, 211, 225` | Hồng phấn |
| 1 | `255, 245, 245` | Trắng phớt hồng |

Chỉ thay RGB ở đúng chỉ số đã chọn; giữ nguyên mọi ô khác. Cách này giữ thứ tự
sáng/tối tương đối để tán cây còn chiều sâu, nhưng có chủ động nâng sáng và không
cam kết giữ độ tương phản y hệt nguồn. Ngưỡng trên dành cho mẫu thử, không phải
quy tắc chuẩn cho mọi cây/palette.

Ví dụ hàm thuần tương đương script đã dùng (chỉ là tài liệu, chưa tích hợp vào app):

```ts
import type { Palette } from './src/core/palette';

function makeSakuraPalette(original: Palette): Palette {
  const palette = { ...original, name: '02_nature_sakura', data: original.data.slice() };
  const stops = [[62, 29, 47], [148, 64, 102], [222, 133, 167], [255, 211, 225], [255, 245, 245]];
  for (let i = 0; i < palette.size; i++) {
    const [r, g, b] = Array.from(original.data.slice(i * 3, i * 3 + 3), v => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d < 0.035 || d / max < 0.22) continue;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    if (h < 49 || h > 175) continue;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const pos = Math.min(1, (y / 0.75) ** 0.72) * (stops.length - 1);
    const a = Math.min(stops.length - 2, Math.floor(pos)), f = pos - a;
    palette.data.set(stops[a].map((v, c) => Math.round(v + (stops[a + 1][c] - v) * f)), i * 3);
  }
  return palette;
}
```

Ghi palette thành JASC-PAL: ba dòng đầu là `JASC-PAL`, `0100`, `256`, sau đó
256 dòng `R G B` theo nguyên thứ tự index. Mẫu này chỉ đổi palette nên có thể dùng
SLP gốc với palette mới; bản `tree_sakura.slp` được xuất bằng `buildEditedSlp()`
để kiểm tra writer, **không nhúng RGB mới vào SLP**. SLP vẫn giữ palette ID ban đầu.

### Mở mẫu trên giao diện hiện tại

1. Nạp `tree_sakura.slp` hoặc SLP cây gốc ở tab **Đọc & Export**.
2. Đợi app nạp file và tự chọn palette theo frame đầu.
3. Chọn **Nạp file khác** ở phần palette chính, nạp `02_nature_sakura.pal`.
4. Chọn các frame để kiểm tra, rồi xuất PNG/ZIP/spritesheet như bình thường.

Nên nạp palette tùy chỉnh **sau khi** mở SLP: luồng nạp SLP có thể tự chọn lại
palette theo metadata. File `.slp` tải xuống không chứa palette tùy chỉnh và không
tự liên kết theo tên file `.pal`; khi mở lại vẫn cần nạp đúng palette đi kèm.
PNG đã chứa màu RGBA nên xem riêng được, không cần palette.

### Dùng lại cho cây khác và đưa vào game

- Cây khác cùng bảng RGB/index của `02_nature` có thể dùng palette mới này; kết quả
  còn tùy các ô màu cây đó sử dụng. Cùng palette ID chỉ là gợi ý, cần kiểm tra đúng
  file palette/bản game/mod thực tế.
- Cây dùng palette khác, ví dụ `07_nature_tree_conifers` hoặc `08_nature_tree_palms`,
  cần tạo bản chuyển tông từ **palette nguồn của nó**, không gắn thẳng palette này.
- Thuật toán chọn màu, không hiểu bộ phận của cây. Nếu lá và thân dùng chung index,
  hoặc thân có ô xanh thuộc ngưỡng, cả hai cùng đổi. Không cam kết tự giữ thân cây
  với mọi sprite; cần xem trước hoặc loại ô đó khỏi tập màu được chuyển.
- Thay palette dùng chung trong game có thể đổi cả cỏ, bụi cây và vật thể khác dùng
  các ô tương ứng. Muốn chỉ đổi một loại cây cần xác minh cơ chế đăng ký palette
  riêng và gán palette cho sprite của đúng bản game/mod. App hiện chưa làm việc đó.
- Giữ palette gốc và bản sao lưu. Chưa kiểm tra mẫu trong AoE/AoE:DE; không coi việc
  PNG đúng màu hoặc SLP parse lại thành công là bằng chứng game đã nạp palette mới.

### Kết quả thử và vị trí artifact

Mẫu local: `n_all_treeAsh_x1.SLP`, container `4.2P`, 16 frame; frame 0 là
`67×74 px`, hotspot `(36, 80)`. Palette nguồn `02_nature.pal` có **156 ô** thỏa
ngưỡng và được đổi RGB; đây không phải số màu chắc chắn xuất hiện trên từng frame.
SLP xuất ra `4.0X` đã parse lại, đối chiếu đủ 16 frame: kind/index pixel, kích thước,
hotspot, palette properties và layer phụ giữ nguyên.

Artifact trên PC thực hiện thử: `D:/projects/aoede-tool/previews/sakura/`:

- `make-preview.mjs`: script dùng Vite SSR để gọi core TypeScript, tạo palette/SLP,
  dữ liệu RGBA và `report.json`; có đường dẫn tuyệt đối của PC, không phải CLI đóng gói.
- `make-images.py`: dùng Pillow tạo PNG và ảnh so sánh nearest-neighbor.
- `02_nature_sakura.pal`, `tree_sakura.slp`, `tree_sakura.png`, `tree_original.png`.
- `sakura-comparison.png`, `sakura-all-frames.png`, `report.json` (các ô RGB trước/sau).

Các artifact/script thử này nằm **ngoài repo**, không có sẵn khi clone/pull trên PC
khác. Thuật toán ở trên là tài liệu tái tạo; file game và palette không được commit.

### Gợi ý cho agent phát triển tiếp

Chưa có yêu cầu triển khai tính năng mới trong đợt ghi tài liệu này. Nếu phát triển
chuyển tông tự động, có thể dùng hàm thuần và UI chọn dải màu nguồn/màu đích, xem
trước rồi xác nhận; không bắt buộc AI/agent hay API tính phí. Nên:

- Tách rõ chế độ remap index và chỉnh RGB palette, giữ nguyên hành vi remap hiện có.
- Dùng bản nháp palette sao chép độc lập, hỗ trợ Hủy và không ghi đè palette nguồn.
- Cho chỉnh tập index cần đổi; không coi nhận diện xanh là phân đoạn lá hoàn hảo.
- Xuất palette riêng cùng SLP khi cần, giải thích rõ palette ID/đăng ký trong game
  chưa tự được xử lý; đừng quảng cáo chỉ cần SLP là đủ.
- Kiểm tra input không bị sửa, số/thứ tự ô màu giữ nguyên, ô ngoài tập chọn giữ nguyên,
  các mức tối/sáng và nhiều loại cây. Đọc lại SLP và đối chiếu pixel/metadata/layer phụ;
  thử trong game riêng nếu muốn xác nhận tương thích thực tế.

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
    slpExport.ts    Xuất SLP đã chỉnh, giữ palette metadata và kiểm layer phụ
  ui/
    dom.ts          Helper DOM tối giản
    app.ts          Tab Đọc & Export
    paletteRemap.ts Popup bản nháp remap, chọn màu và xem trước
    importer.ts     Tab Import & tạo SLP
    main.ts         Điểm vào, nối dây sự kiện
    styles.css      CSS dark theme
test/
  commands.test.ts   Test decode command theo ví dụ trong spec + edge cases
  palette.test.ts    Test JASC-PAL parser, PaletteMatcher, LZ4 block decompression
  paletteRemap.test.ts Test remap đồng thời, chọn frame, clone và validation
  slp.test.ts        Test encode, writeSlp, validateRoundTrip
  slpExport.test.ts  Test xuất remap, palette ID, metadata và layer phụ
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
