# NexusFlag Demo Guide

Flag `new-delivery-pricing` trên Juice Shop: bật free ship cho đơn từ 50¤, code mới có bug, AutoPilot tự tắt flag trong ≤35 giây, không cần redeploy.

Tài khoản: dashboard `demo-admin@nexusflag.local` / `demo-admin-password-1`, workspace `juice-shop-demo`. Shopper demo: `shopperNN@demo.local` / `Demo-shopper-pw-1!` (do `traffic.mjs` tạo).

## Vai trò của từng terminal

| Cửa sổ | Vai trò | Khi nào chạm vào |
| --- | --- | --- |
| T1 Platform | core-api + streaming + AutoPilot | Bật rồi để yên |
| T2 Dashboard | Giao diện web, http://localhost:3000 | Bật rồi để yên, show trên trình duyệt |
| T3 Shop | Juice Shop có gắn SDK, http://127.0.0.1:3100 | Bật rồi để yên |
| T4 Điều khiển | Gõ lệnh trong suốt demo | Bước 5–16 |
| T5 Phụ | Dùng khi T4 đang bận | Bước 15 và 17 |

- `traffic.mjs` giả lập khách checkout liên tục (mặc định 5 request/giây, 20 user), in tỷ lệ `v1`/`v2` và số lỗi 5xx. `v1` là giá hiện tại, `v2` là giá mới có free ship.
- `flag.mjs` điều khiển flag (`on`, `off`, `status`, `reenable`), giống bấm nút trên dashboard.

## Phần 0: Khởi động (trước demo 10–15 phút)

### 0.1 Mở Docker Desktop
Đợi báo "Engine running".

### 0.2 Bật Postgres
```powershell
cd D:\FPT_projects\Capstone\NexusFlag
docker compose -f deploy/docker-compose.db.yml up -d
```
Khởi động container `nexusflag-db`. Dữ liệu đã provision vẫn còn, không cần migrate hay provision lại.

### T1: Platform
```powershell
cd D:\FPT_projects\Capstone\NexusFlag
$env:DATABASE_URL="postgresql://nexusflag:nexusflag@localhost:5432/nexusflag"
$env:GOOGLE_AUTH_DISABLED="true"
$env:AUTOPILOT_ENABLED="true"
pnpm dev:embedded
```
- `DATABASE_URL`: DB mà core-api dùng.
- `GOOGLE_AUTH_DISABLED=true`: tắt đăng nhập Google, dùng email + mật khẩu.
- `AUTOPILOT_ENABLED=true`: bật AutoPilot. Thiếu biến này thì không bao giờ có disable.
- `pnpm dev:embedded`: chạy core-api (3001) và streaming (4000) trong một tiến trình.

Đợi 1–2 phút đến khi log có `CONFIG_DELIVERY_READY`. Để yên.

### T2: Dashboard
```powershell
cd D:\FPT_projects\Capstone\NexusFlag
$env:NEXUSFLAG_CORE_API_URL="http://localhost:3001"
$env:NEXUSFLAG_DASHBOARD_ORIGIN="http://localhost:3000"
pnpm --filter @nexusflag/dashboard dev
```
Chạy giao diện web ở http://localhost:3000. Thiếu `NEXUSFLAG_CORE_API_URL` thì dashboard lỗi khi khởi động. Để yên.

### T3: Shop (chạy sau khi T1 sẵn sàng)
```powershell
$env:PATH="D:\FPT_projects\Capstone\.node-22\node-v22.23.5-win-x64;$env:PATH"
cd D:\FPT_projects\Capstone\juice-shop-nexus-demo\nexusflag-demo
node start-shop.mjs
```
- Dòng đầu đặt Node 22.23.5 portable lên đầu `PATH` (chỉ trong terminal này). Shop cần Node >= 22.22.3 và npm 11.
- `start-shop.mjs` chạy Juice Shop ở cổng 3100 với API key lấy từ `.env.demo`.

Đợi dòng `client ready (bootstrapped, seq N, transport streaming)`. Thấy `NOT bootstrapped` nghĩa là T1 chưa chạy hoặc key sai. Để yên. **Không chạy lại `provision.mjs`**: chạy lại sẽ cấp key mới và phải restart shop.

### T4: Điều khiển
```powershell
$env:PATH="D:\FPT_projects\Capstone\.node-22\node-v22.23.5-win-x64;$env:PATH"
cd D:\FPT_projects\Capstone\juice-shop-nexus-demo\nexusflag-demo
node flag.mjs status
```
Kết quả đúng: `enabled: false`, policy `AUTONOMOUS`, `activeIncidentId: null`.

### T5: Terminal phụ
Mở thêm một terminal, chạy hai dòng `$env:PATH=...` và `cd ...` như T4.

### Trình duyệt
1. Mở http://localhost:3000, đăng nhập `demo-admin@nexusflag.local`, chọn workspace `juice-shop-demo`.
2. Mở hai tab http://127.0.0.1:3100: một tab đăng nhập `shopperNN@demo.local`, một tab đăng nhập user thường (đăng ký tài khoản mới). Giỏ hàng cả hai cần có món trên 50¤.

Lưu ý: DB SQLite của shop bị tạo lại mỗi lần bật shop, nên các user `shopperNN` mất sau mỗi lần restart. Cần chạy `node traffic.mjs --duration 30` (bước 5) trước khi đăng nhập user demo.

## Phần 1: Kịch bản demo (18 bước, ~12 phút)

### Act 1: Gắn SDK (phút 0–3, chỉ mở code)
1. `lib/nexusflag.ts` (`initNexusFlag`): chỉ file này biết SDK. Không có API key thì shop chạy như Juice Shop gốc.
2. `lib/nexusflag.ts` (`isFeatureOn`): `evaluate()` đọc bộ nhớ, không bao giờ throw, lỗi thì coi như OFF (BR-05). Chỉ checkout đi nhánh v2 mới được báo về.
3. `routes/order.ts`: khối `if (isFeatureOn(...))`. Chỉ vào `chosenDelivery!.price`, đây là bug cài sẵn.

### Act 2: Flag và rule (phút 3–5.5)

| Bước | Chạy ở | Lệnh | Ý nghĩa |
| --- | --- | --- | --- |
| 4 | Dashboard | (không có) | Mở flag: OFF, rule `demo EQ true`, chỉ `@demo.local` nhận tính năng, khớp đầu tiên thắng |
| 5 | T4 | `node traffic.mjs --duration 30` | Tải 30 giây khi flag OFF, baseline toàn v1, request `deliveryMethodId:"999"` vẫn thành công |
| 6 | T4 | `node flag.mjs on` | Bật flag, đẩy xuống shop qua SSE (<500 ms) |
| 7 | Trình duyệt | checkout ở 2 tab | Tab demo: phí giao hàng 0. Tab thường: có phí |

### Act 3: Policy (phút 5.5–6.5)

| Bước | Chạy ở | Lệnh | Ý nghĩa |
| --- | --- | --- | --- |
| 8 | Dashboard, policy | (không có) | `error_rate > 0.05` trong 30s, `minSamples` 30, cooldown 60s, recovery `< 0.02` (chỉ để tham khảo), AUTONOMOUS. Mọi policy sinh ra ở ADVISORY (BR-11), chỉ Admin nâng lên được và có audit (UC-21) |

### Act 4: Sự cố (phút 6.5–9)

| Bước | Chạy ở | Lệnh | Ý nghĩa |
| --- | --- | --- | --- |
| 9 | T4 | `node traffic.mjs --bad-ratio 0 --duration 0` | Tải chạy mãi (`--duration 0`), 0% lỗi (`--bad-ratio 0`), v1 và v2 trộn lẫn |
| 10 | T4 | gõ `0.3` + Enter | "Ship bug": 30% request lỗi, `err30s` vượt 5% |
| 11 | (không có) | (không có) | Nói về cách sửa truyền thống: tìm bug, vá, PR, CI, redeploy mất vài phút đến vài giờ |
| 12 | T4 | không gõ gì, chờ | AutoPilot tự DISABLE. Trong ≤35s thấy `##### CONTAINED ... #####`, mọi checkout về v1, request `999` trả 200 |
| 13 | Trình duyệt, tab demo | checkout lại | Phí giao hàng bình thường. Trình duyệt chỉ thấy ở lần checkout kế tiếp vì SSE chỉ tới shop server |
| 14 | Dashboard, Incidents | (không có) | CONTAINED, actor AutoPilot, error rate, Wilson lower bound, config cause `AUTOPILOT`, có audit (BR-07) |

### Act 5: Khôi phục (phút 10–12)

| Bước | Chạy ở | Lệnh | Ý nghĩa |
| --- | --- | --- | --- |
| 15 | T5 | `node flag.mjs status` | `enabled: false` và có incident. Không có đường tự bật lại (BR-03) |
| 16 | T4 | gõ `0` + Enter | Bug được "sửa", `5xx` dừng |
| 17 | T5 | `node flag.mjs reenable` | Người bật lại (UC-31). Nhận `409 COOLDOWN_ACTIVE` thì đợi hết 60s rồi chạy lại. Xong thì incident RESOLVED, flag ON |
| 18 | Trình duyệt, tab demo | checkout lại | Free ship quay lại. Hết demo |

## Thông điệp cần nhấn mạnh
1. AutoPilot chỉ được DISABLE, không bao giờ tự bật lại. Re-enable luôn là hành động của người.
2. AutoPilot chỉ hành động khi đủ mẫu (`minSamples` 30). Ít mẫu thì chỉ khuyến nghị.
3. Mọi hành động tự động đều có audit log, webhook và hiển thị trên dashboard.

## Tùy chọn thêm
- **Dưới ngưỡng (sau bước 9):** gõ `0.03`. Ở khoảng 3% lỗi, flag vẫn ON.
- **Bug từ trình duyệt (bước 10 hoặc 11):** dán `console-snippet.js` vào devtools console của tab demo. Mỗi dòng in `checkout=500 X-Checkout-Version=v2` cho đến khi containment, sau đó là `200 v1`.

## Phần 2: Tắt mọi thứ
Nhấn Ctrl+C ở T1, T2, T3, T4. Sau đó:
```powershell
cd D:\FPT_projects\Capstone\NexusFlag
docker compose -f deploy/docker-compose.db.yml stop
```
Dùng `stop`, không dùng `down -v` (`-v` xóa dữ liệu đã provision).

## Trước buổi thật
- Chạy thử bước 5–17 một lần để đo lại thời gian containment. Con số 27.8s và 26.0s trong README của shop là của bản cũ, đừng đọc ra.
- Sau lần chạy thử, chạy `node flag.mjs status` để kiểm tra flag đang ON hay có incident. Cần về trạng thái đầu thì dùng `node flag.mjs off`, nhưng chưa kiểm chứng lệnh này có đóng incident cũ hay không, hãy xem lại bằng `status`.
