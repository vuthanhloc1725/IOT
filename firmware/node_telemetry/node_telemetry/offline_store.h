/*
 * offline_store.h - Lưu bản tin vào Flash (LittleFS) khi mất mạng và đọc lại
 * theo lô để "gửi bù" (backfill) khi có mạng trở lại.
 *
 *  - Khi offline: mỗi bản tin là 1 dòng JSON, ghi nối vào /backlog.jsonl
 *  - Khi online : đổi tên /backlog.jsonl -> /sending.jsonl rồi gửi dần từng lô
 *                 (bản tin mới phát sinh lúc mất mạng lần nữa vẫn ghi vào backlog)
 *  - Mất điện giữa chừng: dữ liệu vẫn nằm trong Flash, khởi động lại gửi tiếp.
 *    Có thể có bản ghi gửi trùng -> server loại trùng theo (device_id, bc, seq).
 */
#pragma once
#include <Arduino.h>

bool     storeInit();
bool     storeAppend(const char* jsonLine);    // false nếu đầy (bản ghi bị bỏ)
uint32_t storeBytes();                          // tổng dung lượng đang chờ gửi
bool     storeHasPending();

// Đọc 1 lô tối đa maxRecords bản ghi thành mảng JSON "[{...},{...}]" vào out.
// Trả về số bản ghi đọc được (0 = đã hết, file gửi đã được xóa).
int      storeReadBatch(char* out, size_t outLen, int maxRecords);
void     storeCommitBatch();                    // gọi sau khi publish lô thành công
void     storeFormat();
