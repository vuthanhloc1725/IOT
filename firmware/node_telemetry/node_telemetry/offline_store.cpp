/*
 * offline_store.cpp - Hiện thực lưu trữ offline bằng LittleFS
 * CHỈ được gọi từ task mạng (taskNet) -> không cần khóa.
 *
 * v1.1: vị trí đã gửi (offset) trong /sending.jsonl được lưu NVS sau mỗi lô gửi thành
 * công -> mất điện giữa lúc gửi bù chỉ gửi lại tối đa 1 lô (20 bản ghi), không gửi lại cả file.
 */
#include "offline_store.h"
#include "config.h"
#include <LittleFS.h>
#include <Preferences.h>

static Preferences sStorePrefs;
static void saveOffset(size_t off) { sStorePrefs.putUInt("off", (uint32_t)off); }

static size_t sOffset = 0;       // vị trí đã gửi xong trong SENDING_FILE
static size_t sNextOffset = 0;   // vị trí sau lô vừa đọc (chờ commit)
static bool   sReady = false;

bool storeInit() {
  // true = tự format nếu phân vùng chưa được định dạng (lần đầu nạp)
  sReady = LittleFS.begin(true);
  sStorePrefs.begin(NVS_STORE_NS, false);
  if (sReady && LittleFS.exists(SENDING_FILE)) {
    sOffset = sNextOffset = sStorePrefs.getUInt("off", 0);   // gửi tiếp từ chỗ dừng
  } else {
    sOffset = sNextOffset = 0;
  }
  if (!sReady) Serial.println(F("[STORE] LOI: khong mount duoc LittleFS"));
  else Serial.printf("[STORE] LittleFS OK, dang cho gui bu: %lu bytes\n", (unsigned long)storeBytes());
  return sReady;
}

static size_t fileSize(const char* path) {
  if (!LittleFS.exists(path)) return 0;
  File f = LittleFS.open(path, "r");
  if (!f) return 0;
  size_t s = f.size();
  f.close();
  return s;
}

uint32_t storeBytes() {
  if (!sReady) return 0;
  size_t sending = fileSize(SENDING_FILE);
  return fileSize(BACKLOG_FILE) + (sending > sOffset ? sending - sOffset : 0);
}

bool storeAppend(const char* line) {
  if (!sReady) return false;
  if (fileSize(BACKLOG_FILE) + strlen(line) + 1 > BACKLOG_MAX_BYTES) return false;
  File f = LittleFS.open(BACKLOG_FILE, "a");
  if (!f) return false;
  f.print(line);
  f.print('\n');
  f.close();
  return true;
}

bool storeHasPending() {
  if (!sReady) return false;
  return LittleFS.exists(SENDING_FILE) || LittleFS.exists(BACKLOG_FILE);
}

int storeReadBatch(char* out, size_t outLen, int maxRecords) {
  if (!sReady || outLen < 4) return 0;
  if (!LittleFS.exists(SENDING_FILE)) {
    if (!LittleFS.exists(BACKLOG_FILE)) return 0;
    LittleFS.rename(BACKLOG_FILE, SENDING_FILE);
    sOffset = 0;
    saveOffset(0);
  }
  File f = LittleFS.open(SENDING_FILE, "r");
  if (!f) return 0;
  if (sOffset >= f.size()) {               // đã gửi hết file
    f.close();
    LittleFS.remove(SENDING_FILE);
    sOffset = sNextOffset = 0;
    saveOffset(0);
    return 0;
  }
  f.seek(sOffset);

  size_t pos = 0;
  out[pos++] = '[';
  int n = 0;
  char line[460];
  sNextOffset = sOffset;
  while (n < maxRecords && f.available()) {
    size_t before = f.position();
    size_t len = f.readBytesUntil('\n', line, sizeof(line) - 1);
    line[len] = 0;
    if (len == 0 || line[0] != '{') { sNextOffset = f.position(); continue; }  // bỏ dòng hỏng
    if (pos + len + 3 > outLen) { sNextOffset = before; break; }               // hết chỗ -> lô sau
    if (n > 0) out[pos++] = ',';
    memcpy(out + pos, line, len);
    pos += len;
    n++;
    sNextOffset = f.position();
  }
  f.close();
  out[pos++] = ']';
  out[pos] = 0;
  if (n == 0) {                            // chỉ toàn dòng hỏng -> bỏ qua
    sOffset = sNextOffset;
    saveOffset(sOffset);
  }
  return n;
}

void storeCommitBatch() {
  sOffset = sNextOffset;
  saveOffset(sOffset);
}

void storeFormat() {
  LittleFS.remove(BACKLOG_FILE);
  LittleFS.remove(SENDING_FILE);
  sOffset = sNextOffset = 0;
  saveOffset(0);
}
