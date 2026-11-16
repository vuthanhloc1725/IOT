# Backend: thu hồi Node và đồng bộ Device khi mất kết nối

## Thu hồi Node

Khi Admin thu hồi Node, Backend tìm các Device loại PUMP/FAN đang có `isOn=true` và lifecycle thuộc ACTIVE/FAULT/MAINTENANCE. Với từng Device, Backend tạo lệnh OFF qua `commandService.issue()` và chờ ACK tối đa 5 giây. Chỉ ACK thành công mới làm `isOn=false` thông qua luồng xử lý ACK hiện có.

Sau bước yêu cầu dừng, Backend disable tài khoản MQTT Dynamic Security, đánh dấu Node bị thu hồi và gọi `markOffline()` để phát trạng thái offline cho toàn bộ Device con. Response API có trường `safeStop` gồm `requested`, `acknowledged`, `failed`, `skipped` và `details` để Admin biết lệnh dừng nào đã được xác nhận.

Nếu Node offline hoặc không ACK, Backend không thể bảo đảm relay vật lý đã tắt. Không được diễn giải việc khóa MQTT là bằng chứng thiết bị đã dừng. Cần kiểm tra tại hiện trường hoặc có cơ chế fail-safe độc lập trong Firmware/phần cứng.

## Đồng bộ khi Node offline/online

`nodeService.markOffline()` phát `device:update` với `isOnline:false` cho mọi Device trực thuộc Node, kể cả Device chưa Active. Lifecycle và `isOn` không bị tự ý thay đổi vì mất kết nối. Cảnh báo offline được tạo cho Device chưa Decommissioned.

Khi Node online trở lại, `onBackOnline()` phát trạng thái kết nối cho các Device; Device Decommissioned không được đánh dấu online. Backend tiếp tục retry cấu hình đang chờ ACK.

## Không thay đổi Firmware

Các thay đổi này chỉ ở Backend. Backend dùng giao thức lệnh OFF hiện có (`action:pump`/`action:fan`, `on:false`) và ACK hiện có. Firmware cần tiếp tục thực hiện lệnh OFF và trả ACK đúng `commandUuid` như hợp đồng MQTT hiện tại.
