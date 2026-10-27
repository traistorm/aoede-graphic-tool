# Prompt: Xây dựng Web App đọc/ghi file SLP (Age of Empires 1 & AoE1:DE)

Dán nguyên văn phần dưới đây vào Claude (khuyến nghị Claude Code, vì đây là project nhiều file) để nó code cho mày.

---

## YÊU CẦU DỰ ÁN

Viết cho tôi một **web app** (chạy hoàn toàn phía client, không cần backend/server — HTML + JS/TypeScript thuần hoặc React, dùng `<canvas>` để render) để làm việc với file `.slp` của **Age of Empires 1 (1997) và Age of Empires 1: Definitive Edition**. Không cần hỗ trợ AoE2/AoE2:HD/SWGB — chỉ 2 game trên.

Phạm vi version cần hỗ trợ (đây là toàn bộ version mà 2 game trên dùng):
- `2.0N` — AoE1 gốc
- `3.0`, `4.0X`, `4.1X`, `4.2P` — AoE1:DE

Ứng dụng cần 3 chức năng chính, chạy ngay trên trình duyệt:

1. **Đọc/parse file SLP** — người dùng kéo-thả hoặc chọn file `.slp` (dùng `File` API + `ArrayBuffer`/`DataView`), tự nhận diện version và parse.
2. **Export ảnh** — xuất từng frame ra PNG (giữ kênh alpha), export hàng loạt (zip nhiều file, dùng thư viện `JSZip`), hoặc ghép spritesheet — tất cả xử lý và tải xuống ngay trên client (không upload lên server).
3. **Import ảnh → tạo file SLP** — nhận PNG (một hoặc nhiều file), mã hoá lại thành draw command, ghi ra `.slp` (version `2.0N` mặc định, có option `4.0X`), cho tải file xuống.

Cũng cần đọc file palette (`.pal`/`.palx` dạng JASC-PAL) vì SLP không tự chứa màu, chỉ chứa index vào palette.

Dưới đây là toàn bộ spec định dạng, bám sát để không sai byte nào.

---

## SPEC ĐỊNH DẠNG SLP

### 1. Nén (chỉ với version `4.2P`, dùng trong AoE1:DE từ Update 38862)

`4.2P` là container nén LZ4 bọc ngoài 1 file SLP bình thường:

| Length | Type | Mô tả |
|---|---|---|
| 4 bytes | string | Version = "4.2P" |
| 4 bytes | uint32 | Uncompressed size |
| variable | LZ4 | Dữ liệu SLP đã nén |

→ Giải nén LZ4 trước (dùng thư viện JS như `lz4js` hoặc tự cài đặt LZ4 block decompression), sau đó parse như file SLP bình thường (sẽ ra version thật bên trong, ví dụ `4.1X`).

### 2. Header (version ≤ 3.0 — dùng cho AoE1 gốc và SLP rescale/terrain của AoE1:DE)

```c
struct slp_header {
  char  version[4];    // "2.0N" hoặc "3.0"
  int32 num_frames;
  char  comment[24];
};
```
Tương đương đọc bằng JS: 4 byte ASCII, sau đó `readInt32LE()`, sau đó 24 byte ASCII (bỏ qua null padding).

### 3. Header (version ≥ 4.0 — AoE1:DE)

```c
struct slp_header_v4 {
  char  version[4];         // "4.0X" / "4.1X"
  int16 num_frames;
  int16 type;                // xem bảng Type bên dưới
  int16 num_directions;      // thường = 1, chỉ để tham khảo
  int16 frames_per_direction;
  int32 palette_id;
  int32 offset_main;         // offset tới frame info của layer chính, thường = 0x20
  int32 offset_secondary;    // offset tới frame info của layer phụ (shadow/alpha), 0 nếu không có
  byte  padding[8];
};
```
Đọc bằng JS `DataView`: 4 byte string, rồi lần lượt `getUint16(..., true)` x4, `getInt32(..., true)` x3, bỏ qua 8 byte padding. Tổng header = 32 byte.

Bảng `type`:
- 0x00 Normal, 0x01 Color Mask, 0x02 Shadow Layer, 0x04 Outline,
  0x08 VFX Color, 0x10 VFX Alpha, 0x20 Decay

### 4. Frame Info (lặp lại `num_frames` lần, ngay sau header)

```c
struct slp_frame_info {
  uint32 cmd_table_offset;
  uint32 outline_table_offset;
  uint32 palette_offset;   // unused
  uint32 properties;       // unused ở bản cũ, ở AoE1:DE dùng làm palette ID
  int32  width;
  int32  height;
  int32  hotspot_x;
  int32  hotspot_y;
};
```
32 byte/struct, toàn bộ little-endian.

Nếu là version ≥4.0 và `offset_secondary != 0`: có thêm `num_frames` struct `slp_frame_info` cho layer phụ tại offset đó.

⚠️ Với `4.1X`, thứ tự outline table và command table trong dữ liệu **có thể bị đảo**, luôn dùng offset trong struct, không đọc tuần tự.

### 5. Outline Table (tại `outline_table_offset`, độ dài = `height` phần tử)

```c
struct slp_frame_row_edge {
  uint16 left_space;
  uint16 right_space;
};
```
- Nếu `left_space` hoặc `right_space` = `0x8000` → cả dòng trong suốt hoàn toàn, không có command byte cho dòng này, phải tự skip khi đọc VÀ khi ghi (không encode command gì cho dòng đó).
- Số pixel có dữ liệu vẽ trong dòng = `width - left_space - right_space`.

### 6. Command Offset Table (tại `cmd_table_offset`, độ dài = `height` × uint32)

Mỗi phần tử là offset (uint32) trỏ tới lệnh vẽ đầu tiên của dòng tương ứng. Dữ liệu command thực sự bắt đầu ngay sau bảng này: `cmd_table_offset + 4 * height`.

### 7. Draw Commands

Đọc tuần tự byte `cmd_byte`. Xác định lệnh bằng cách nhìn các bit thấp. Kết thúc 1 dòng bằng byte `0x0F` (End of row).

Độ dài `px_color_value` phụ thuộc version:
- version ≤ 4.0: 1 byte = palette index
- version ≥ 4.1: 2 byte = display_modifier + palette index
- SLP 32-bit: 4 byte BGRA

Bảng lệnh đầy đủ (nhận diện qua 4 bit thấp của cmd_byte):

| Tên | Byte pattern | Pixel count | Mô tả |
|---|---|---|---|
| Lesser draw | `0bXXXXXX00` | `cmd_byte >> 2` | vẽ N pixel màu từ palette, theo sau cmd_byte |
| Lesser skip | `0bXXXXXX01` | `cmd_byte >> 2` | bỏ qua N pixel (trong suốt) |
| Greater draw | `0bXXXX0010` | `(cmd_byte & 0xF0)<<4 + next` | vẽ N pixel (N > 64) |
| Greater skip | `0bXXXX0011` | `(cmd_byte & 0xF0)<<4 + next` | bỏ qua N pixel (N > 64) |
| Player color draw | `0bXXXX0110` | `cmd_byte>>4` hoặc next nếu =0 | vẽ N pixel player-color, real index = `player_color_palette_index + player*16` |
| Fill | `0bXXXX0111` | `cmd_byte>>4` hoặc next nếu =0 | 1 giá trị màu, lặp N lần |
| Fill player color | `0bXXXX1010` | `cmd_byte>>4` hoặc next nếu =0 | 1 player index, lặp N lần |
| Shadow draw | `0bXXXX1011` | `cmd_byte>>4` hoặc next nếu =0 | vẽ N pixel shadow |
| Extended command | `0bXXXX1110` | tuỳ loại | xem bảng extended bên dưới |
| End of row | `0x0F` | 0 | kết thúc dòng |

Extended commands (byte thấp = `0xE`, phân biệt bởi nibble cao):

| Tên | Byte | Ghi chú |
|---|---|---|
| Forward Draw | 0x0E | hầu như không dùng |
| Reverse Draw | 0x1E | hầu như không dùng |
| Normal Transform | 0x2E | — |
| Alternate Transform | 0x3E | — |
| Outline 1 | 0x4E | 1 pixel viền player-color |
| Outline 1 Fill | 0x5E | N pixel (N = next byte), viền player-color |
| Outline 2 | 0x6E | 1 pixel viền palette_index=243 |
| Outline 2 Fill | 0x7E | N pixel viền palette_index=243 |
| Dither | 0x8E | không rõ / gần như không dùng |
| Premultiplied Alpha | 0x9E | chỉ SLP 32-bit, N pixel BGRA, alpha bị đảo (255-alpha) |
| Original Alpha | 0xAE | không rõ / gần như không dùng |

### 8. Secondary Frame Info (chỉ version ≥4.0X, dùng cho shadow/VFX alpha layer — quan trọng với AoE1:DE)

```c
struct secondary_frame_info {
  uint32 sec_cmd_table_offset;
  uint32 sec_outline_table_offset;
  uint32 sec_null;
  uint24 sec_properties;
  uint8  sec_frame_type;   // 0x02 Shadow / 0x08 VFX Alpha ...
  int32  sec_width;
  int32  sec_height;
  int32  sec_hotspot_x;
  int32  sec_hotspot_y;
};
```
32 byte/struct, mảng dài `num_frames`, đặt ngay sau toàn bộ command chính (padding null byte để offset chia hết).

Secondary draw commands chỉ dùng 3 lệnh: **Lesser draw / Lesser skip / Fill** (cùng cú pháp bit như bảng chính), giá trị đọc được là "shadow value" 1 byte:

```
shadow_alpha = 255 - (shadow_value << 2)
```
(Với VFX alpha thì giữ nguyên giá trị, không đảo.)

### 9. Palette file (JASC-PAL, `.pal`/`.palx` — dùng trong AoE1:DE)

```
JASC-PAL
0100
<số lượng entry>
r g b
r g b
...
```
Dòng thứ 4 trở đi = index 0, 1, 2... map trực tiếp vào palette index dùng trong SLP. Đọc bằng cách split text theo dòng (`FileReader.readAsText`).

---

## YÊU CẦU CHỨC NĂNG CỤ THỂ

### A. Đọc & Export ảnh
1. UI kéo-thả (drag & drop) hoặc `<input type="file">` để chọn file `.slp` + file palette `.pal`/`.palx`.
2. Tự nhận diện version từ 4 byte đầu (kể cả `4.2P` cần giải nén LZ4 trước khi parse tiếp).
3. Parse toàn bộ frame, decode draw command → `ImageData` RGBA theo `(width, height)` của từng frame (dùng canvas 2D context), pixel skip → alpha = 0.
4. Xử lý riêng: player color (cho chọn màu preview qua color picker, mặc định tô 1 màu cố định như xanh dương), shadow layer (alpha theo công thức ở trên) nếu có secondary data.
5. UI: lưới thumbnail tất cả frame (render canvas nhỏ), click vào để xem full-size + thông tin (width/height/hotspot).
6. Export: click 1 frame → tải PNG (`canvas.toBlob` + `<a download>`), hoặc nút "Export All" → đóng gói bằng `JSZip` thành 1 file `.zip` gồm `frame_000.png`, `frame_001.png`... kèm `metadata.json` (width, height, hotspot mỗi frame) để có thể import lại chính xác. Có option ghép spritesheet (canvas lớn, layout lưới N cột).

### B. Import ảnh → tạo SLP
1. Nhận 1 hoặc nhiều PNG qua file input/drag-drop, coi mỗi ảnh là 1 frame (đọc pixel qua canvas `getImageData`).
2. Với mỗi pixel: alpha = 0 → transparent (dùng skip command); ngược lại tìm màu gần nhất trong palette đang chọn (nearest-neighbor Euclid trong RGB) → ra palette index.
3. Encode mỗi dòng thành chuỗi command tối ưu (ưu tiên Fill khi ≥3 pixel cùng màu liên tiếp, Lesser/Greater draw cho block không lặp, Lesser/Greater skip cho block trong suốt), kết thúc dòng bằng `0x0F`.
4. Tự tính `left_space`/`right_space` cho outline table dựa trên vùng trong suốt ở 2 đầu mỗi dòng; nếu cả dòng trong suốt thì set `0x8000` và không ghi command cho dòng đó.
5. Ghi đúng thứ tự vào `ArrayBuffer`/`Uint8Array` động (dùng buffer builder tự viết, tương tự `struct.pack` bên Python nhưng bằng `DataView.setUint32(..., true)` v.v.): header → frame info array → (outline table + command offset table + command data) cho từng frame → cuối cùng patch lại các offset trong header/frame info cho khớp vị trí thực tế.
6. Cho set hotspot (x,y) mỗi frame qua input số, mặc định = tâm ảnh (width/2, height/2).
7. Xuất version `2.0N` làm mặc định (đơn giản, đủ dùng cho cả AoE1 lẫn AoE1:DE), có option xuất `4.0X` nếu cần layer phụ. Không cần hỗ trợ ghi `4.1X`/`4.2P` (display modifier + nén LZ4) trừ khi tôi yêu cầu thêm sau.
8. Sau khi build xong buffer, **tự đọc lại bằng chính parser ở phần A để validate (round-trip test) ngay trên client** — so khớp pixel với ảnh gốc, nếu lệch thì báo lỗi cụ thể (frame nào, dòng nào) trước khi cho tải file xuống.

### C. Yêu cầu kỹ thuật khác
- Toàn bộ chạy client-side, không backend, không upload file lên đâu cả — quan trọng vì file SLP/palette là dữ liệu game của người dùng.
- Dùng TypeScript nếu được (rõ kiểu cho struct), tách module rõ ràng: `slpReader.ts`, `slpWriter.ts`, `palette.ts`, `ui.ts`/component React.
- Viết test (Vitest/Jest) cho decode command, dùng đúng ví dụ trong spec: byte `0x08 0x55 0xF4 0x19 0x28 0x99 0x35 0xF4 0x6D 0x67 0x6E 0xA5 0x01 0x4D 0x8E 0x0F` phải ra: lesser draw 2 pixel `[0x55,0xF4]`, lesser skip 6 pixel, lesser draw 10 pixel, end of row.
- UI đơn giản, không cần đẹp, ưu tiên chạy đúng: 1 trang, 2 tab "Đọc/Export" và "Import/Tạo SLP".
- Xử lý lỗi rõ ràng khi version không hỗ trợ hoặc file bị hỏng (hiện message trên UI, không throw ra console im lặng).

Hãy bắt đầu bằng việc dựng khung project (Vite + TS, không cần framework nặng) + viết `slpReader.ts` và `palette.ts` trước, test được qua console/UI tối giản (in ra kích thước từng frame + render thử 1 frame lên canvas), sau đó mới làm `slpWriter.ts` và hoàn thiện UI.
