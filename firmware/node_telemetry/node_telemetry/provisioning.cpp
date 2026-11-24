/*
 * provisioning.cpp - v1.5: claim token -> MQTT credentials (xem provisioning.h)
 *
 *  Bảng xử lý kết quả POST /api/provisioning/claim (mã lỗi = error.code của Backend):
 *   200/201                      -> lưu nodeCode + MQTT user/pass + bảng thiết bị, xóa token, nối broker
 *                                   (replay=true: gọi lại cùng token trong 10 phút -> Backend cấp lại mật khẩu)
 *   mất mạng / 5xx / 429         -> thử lại 10s, 20s ... 5 phút (429: theo Retry-After)
 *   CLAIM_IN_PROGRESS            -> chờ details.retryAfterSec rồi thử lại
 *   INVENTORY_MISMATCH           -> in danh sách sai lệch, 2 phút thử lại (Admin sửa thiết bị trên web)
 *   CLAIM_TOKEN_USED / _EXPIRED / CLAIM_SUPERSEDED / NODE_ALREADY_CLAIMED / NODE_REVOKED
 *                                -> token hết giá trị: XÓA token, cần cấp token mới trên web
 *   CLAIM_INVALID / CLAIM_BAD_REQUEST / INSECURE_TRANSPORT / BROKER_TLS_REQUIRED / 404 / 4xx khác
 *                                -> DỪNG (giữ token) tới khi "claim retry", nhập token mới hoặc đổi URL
 */
#include "provisioning.h"
#include "app_state.h"
#include "devices.h"
#include "tls_ca.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <stdarg.h>

static volatile bool sKick = false;   // đặt từ task khác: token/URL mới hoặc "claim retry"
static bool     sHalted   = false;    // lỗi cần người sửa -> không tự gọi lại
static bool     sWaiting  = false;    // đang chờ tới sNextTry
static uint32_t sNextTry  = 0;
static uint32_t sBackoff  = PROV_RETRY_MIN_MS;
static bool     sWarnedNoApi = false;
static uint8_t  sAuthFails = 0;       // broker từ chối user/pass liên tiếp
static char     sLastErr[160] = "";   // truy cập trong stateLock()

// HTTP client tĩnh: đỡ tốn stack task mạng
static WiFiClient       sHttp;
static WiFiClientSecure sHttps;

// ---------------------------------------------------------------------------
static void setErr(const char* fmt, ...) {
  char buf[sizeof(sLastErr)];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  stateLock();
  strlcpy(sLastErr, buf, sizeof(sLastErr));
  stateUnlock();
  if (buf[0]) Serial.printf("[PROV] %s\n", buf);
}

// Bỏ khoảng trắng đầu/cuối (token copy từ web hay dính dấu cách / xuống dòng)
static void trimCopy(const char* in, char* out, size_t len) {
  if (!in) in = "";
  while (*in == ' ' || *in == '\t' || *in == '\r' || *in == '\n') in++;
  strlcpy(out, in, len);
  size_t n = strlen(out);
  while (n && (out[n - 1] == ' ' || out[n - 1] == '\t' || out[n - 1] == '\r' || out[n - 1] == '\n')) out[--n] = 0;
}

static void scheduleIn(uint32_t ms) {
  sWaiting = true;
  sNextTry = millis() + ms;
  Serial.printf("[PROV] Thu lai sau %lus\n", (unsigned long)(ms / 1000));
}

static void scheduleBackoff() {
  scheduleIn(sBackoff);
  sBackoff = (sBackoff * 2 > PROV_RETRY_MAX_MS) ? PROV_RETRY_MAX_MS : sBackoff * 2;
}

static void halt() {
  sHalted = true;
  sWaiting = false;
  Serial.println(F("[PROV] Da DUNG claim. Sua loi roi go \"claim retry\", hoac nhap token / URL moi."));
}

static void dropToken() {
  stateLock();
  gProv.claimToken[0] = 0;
  stateUnlock();
  provSave();
  sWaiting = false;
  Serial.println(F("[PROV] Da xoa token. Tren web: Node -> \"Cap claim token\" -> nhap token moi (khong can xoa Flash)."));
}

// "http://h:3000", "http://h:3000/", "http://h:3000/api" -> "http://h:3000/api/provisioning/claim"
static bool buildClaimUrl(const char* api, char* out, size_t len) {
  char base[sizeof(gProv.apiUrl)];
  strlcpy(base, api, sizeof(base));
  size_t n = strlen(base);
  while (n && base[n - 1] == '/') base[--n] = 0;
  if (n >= 4 && !strcasecmp(base + n - 4, "/api")) base[n -= 4] = 0;
  return n && snprintf(out, len, "%s/api/provisioning/claim", base) < (int)len;
}

static void urlHost(const char* url, char* out, size_t len) {
  const char* p = strstr(url, "://");
  p = p ? p + 3 : url;
  size_t n = strcspn(p, ":/");
  if (n >= len) n = len - 1;
  memcpy(out, p, n);
  out[n] = 0;
}

static bool isLoopback(const char* h) {
  return !strcasecmp(h, "localhost") || !strncmp(h, "127.", 4) || !strcmp(h, "0.0.0.0") || !strcmp(h, "::1");
}

// ---------------------------------------------------------------------------
bool provSetToken(const char* token) {
  char t[sizeof(gProv.claimToken)];
  trimCopy(token, t, sizeof(t));
  size_t n = strlen(t);
  bool ok = n >= 20 && n < sizeof(t) - 1;
  for (size_t i = 0; ok && i < n; i++) ok = isalnum((unsigned char)t[i]) || t[i] == '-' || t[i] == '_';
  if (!ok) {
    Serial.println(F("[PROV] Token khong hop le (can chuoi 43 ky tu A-Z a-z 0-9 - _ copy tu web)"));
    return false;
  }
  stateLock();
  strlcpy(gProv.claimToken, t, sizeof(gProv.claimToken));
  stateUnlock();
  provSave();
  sKick = true;
  Serial.println(F("[PROV] Da luu claim token -> claim ngay khi co WiFi"));
  return true;
}

bool provSetApi(const char* url) {
  char u[sizeof(gProv.apiUrl)];
  trimCopy(url, u, sizeof(u));
  size_t n = strlen(u);
  while (n && u[n - 1] == '/') u[--n] = 0;
  if (strncasecmp(u, "http://", 7) && strncasecmp(u, "https://", 8)) {
    Serial.println(F("[PROV] URL Backend phai bat dau bang http:// hoac https:// (vd http://192.168.1.10:3000)"));
    return false;
  }
  if (n < 10 || n >= sizeof(u) - 1) {
    Serial.println(F("[PROV] URL Backend qua ngan / qua dai"));
    return false;
  }
  stateLock();
  strlcpy(gProv.apiUrl, u, sizeof(gProv.apiUrl));
  stateUnlock();
  provSave();
  sKick = true;
  Serial.printf("[PROV] Backend URL = %s\n", u);
  return true;
}

void provClearToken() {
  stateLock();
  gProv.claimToken[0] = 0;
  stateUnlock();
  provSave();
  Serial.println(F("[PROV] Da xoa claim token"));
}

void provRetryNow() { sKick = true; }

void provPrint() {
  char api[sizeof(gProv.apiUrl)], tok[sizeof(gProv.claimToken)], err[sizeof(sLastErr)];
  char id[32], host[64], user[32];
  uint16_t port;
  uint8_t tls;
  stateLock();
  strlcpy(api, gProv.apiUrl, sizeof(api));
  strlcpy(tok, gProv.claimToken, sizeof(tok));
  strlcpy(err, sLastErr, sizeof(err));
  strlcpy(id, gConfig.deviceId, sizeof(id));
  strlcpy(host, gConfig.mqttHost, sizeof(host));
  strlcpy(user, gConfig.mqttUser, sizeof(user));
  port = gConfig.mqttPort;
  tls = gProv.mqttTls;
  stateUnlock();

  Serial.printf("[PROV] MAC (STA)    : %s   <- khai bao MAC nay khi tao Node tren web\n", WiFi.macAddress().c_str());
  Serial.printf("[PROV] Backend URL  : %s\n", api[0] ? api : "(chua dat - go: api http://<ip-backend>:3000)");
  if (tok[0]) {
    const char* st = sHalted ? "DUNG - sua loi roi \"claim retry\"" : sWaiting ? "cho thu lai" : "san sang";
    Serial.printf("[PROV] Claim token  : %.4s...(%u ky tu) - %s\n", tok, (unsigned)strlen(tok), st);
  } else {
    Serial.println(F("[PROV] Claim token  : khong co"));
  }
  Serial.printf("[PROV] Node / MQTT  : %s  %s@%s:%u%s\n", id, user[0] ? user : "(chua co user)", host, port,
                tls ? " (TLS)" : "");
  if (sAuthFails) Serial.printf("[PROV] Broker tu choi tai khoan %u lan lien tiep\n", sAuthFails);
  Serial.printf("[PROV] Loi gan nhat : %s\n", err[0] ? err : "-");
}

// ---------------------------------------------------------------------------
bool provConfigureTls(WiFiClientSecure& client) {
  if (kTlsRootCa[0]) {
    client.setCACert(kTlsRootCa);
    return true;
  }
#if TLS_ALLOW_INSECURE
  static bool warned = false;
  if (!warned) {
    warned = true;
    Serial.println(F("[PROV] CANH BAO: TLS_ALLOW_INSECURE=1, KHONG kiem tra chung chi server (chi de thu nghiem)"));
  }
  client.setInsecure();
  return true;
#else
  setErr("Can ket noi TLS nhung tls_ca.h chua co CA (dan CA, hoac TLS_ALLOW_INSECURE=1 khi thu nghiem)");
  return false;
#endif
}

bool provWantsClaim() {
  stateLock();
  bool has = gProv.claimToken[0] != 0 && gProv.apiUrl[0] != 0;   // thiếu URL -> vẫn cho MQTT chạy bằng tài khoản cũ
  stateUnlock();
  return (has && !sHalted) || sKick;
}

bool provOnMqttConnect(int rc) {
  if (rc == 0) { sAuthFails = 0; return false; }
  if (rc != 4 && rc != 5) return false;   // 4 = sai user/pass, 5 = không được phép (ACL / node bị thu hồi)
  if (sAuthFails < 255) sAuthFails++;
  if (sAuthFails != PROV_AUTH_FAIL_MAX) return false;
  setErr("Broker tu choi tai khoan MQTT (rc=%d) %u lan: node bi thu hoi hoac mat khau da doi. "
         "Cap claim token moi tren web roi nhap vao cong cau hinh / \"claim <token>\"", rc, sAuthFails);
  return true;
}

bool provAuthBlocked() { return sAuthFails >= PROV_AUTH_FAIL_MAX; }

// ---------------------------------------------------------------------------
// Áp dụng kết quả claim thành công. false = dữ liệu Backend không dùng được (đã halt).
static bool applyClaim(JsonDocument& doc, const char* api) {
  const char* nodeCode = doc["nodeCode"] | "";
  JsonObjectConst m = doc["mqttCredentials"];
  const char* user = m["username"] | "";
  const char* pass = m["password"] | "";
  const char* hostIn = m["host"] | "";
  long port = m["port"] | 0L;
  bool tls = m["tls"] | false;
  const char* prefix = m["topicPrefix"] | "";

  if (!nodeCode[0] || strlen(nodeCode) >= sizeof(gConfig.deviceId) ||
      !user[0] || strlen(user) >= sizeof(gConfig.mqttUser) ||
      !pass[0] || strlen(pass) >= sizeof(gConfig.mqttPass)) {
    setErr("Phan hoi claim thieu/qua dai nodeCode, username hoac password");
    halt();
    return false;
  }
  if (!hostIn[0] || port < 1 || port > 65535) {
    setErr("Backend khong phan tich duoc dia chi broker (kiem tra MQTT_DEVICE_URL trong .env Backend). "
           "Sua xong go \"claim retry\" trong 10 phut (cung token van dung duoc)");
    halt();
    return false;
  }
  char host[sizeof(gConfig.mqttHost)];
  if (strlen(hostIn) >= sizeof(host)) {
    setErr("Ten may broker qua dai (%u ky tu)", (unsigned)strlen(hostIn));
    halt();
    return false;
  }
  strlcpy(host, hostIn, sizeof(host));
  if (isLoopback(host)) {
    // Backend chưa đặt MQTT_DEVICE_URL -> trả "localhost": với ESP32 phải là máy chạy broker trong LAN
    urlHost(api, host, sizeof(host));
    Serial.printf("[PROV] CANH BAO: Backend tra broker '%s' -> dung host cua Backend '%s'. "
                  "Nen dat MQTT_DEVICE_URL trong .env Backend.\n", hostIn, host);
  }
  if (prefix[0] && strcmp(prefix, MQTT_TOPIC_ROOT))
    Serial.printf("[PROV] CANH BAO: Backend dung topic '%s/...', firmware dung '%s/...'\n", prefix, MQTT_TOPIC_ROOT);

  char oldId[sizeof(gConfig.deviceId)];
  stateLock();
  strlcpy(oldId, gConfig.deviceId, sizeof(oldId));
  strlcpy(gConfig.deviceId, nodeCode, sizeof(gConfig.deviceId));
  strlcpy(gConfig.mqttHost, host, sizeof(gConfig.mqttHost));
  gConfig.mqttPort = (uint16_t)port;
  strlcpy(gConfig.mqttUser, user, sizeof(gConfig.mqttUser));
  strlcpy(gConfig.mqttPass, pass, sizeof(gConfig.mqttPass));
  if (gConfig.lifecycle == LC_REGISTERED || gConfig.lifecycle == LC_DECOMMISSIONED)
    gConfig.lifecycle = LC_PROVISIONED;   // Admin vừa cấp token -> node được dùng lại, chờ kích hoạt
  gProv.mqttTls = tls ? 1 : 0;
  gProv.claimToken[0] = 0;
  stateUnlock();

  // Bảng thiết bị: node khác -> bỏ mã cũ; rồi gán theo danh sách Backend (giống resolveSlot ở control.cpp)
  if (strcmp(oldId, nodeCode)) devClear(DEV_NONE);
  int mapped = 0;
  for (JsonVariantConst d : doc["devices"].as<JsonArrayConst>()) {
    const char* code = d["deviceCode"] | "";
    const char* type = d["type"] | "";
    int gpio = d["gpioPin"].is<int>() ? d["gpioPin"].as<int>() : -1;
    JsonVariantConst mv = d["config"]["metrics"][0];
    const char* metricHint = mv.is<const char*>() ? mv.as<const char*>() : "";
    char err[96] = "";
    if (!code[0]) continue;
    int slot = devResolve(code, type, gpio, metricHint, err, sizeof(err));
    if (slot == DEV_NONE) { Serial.printf("[PROV] Bo qua thiet bi %s: %s\n", code, err); continue; }
    if (gpio >= 0 && gpio != devGpio(slot)) {
      Serial.printf("[PROV] Bo qua thiet bi %s: gpioPin %d khong khop %s (GPIO%d)\n", code, gpio, devSlotName(slot), devGpio(slot));
      continue;
    }
    devAssign(slot, code);
    int lc = lifecycleFromName(d["lifecycle"] | "");
    if (lc >= 0) devSetLifecycle(slot, (uint8_t)lc);
    mapped++;
  }

  configSave();
  provSave();
  sAuthFails = 0;
  sHalted = sWaiting = false;
  sBackoff = PROV_RETRY_MIN_MS;
  setErr("");
  Serial.printf("[PROV] CLAIM THANH CONG%s: node %s, broker %s:%ld%s, user %s, %d thiet bi\n",
                (doc["replay"] | false) ? " (cap lai mat khau)" : "", nodeCode, host, port,
                tls ? " TLS" : "", user, mapped);
  return true;
}

// 1 lần gọi claim. true = đã nhận credentials mới.
static bool claimOnce(const char* api, const char* token) {
  char url[sizeof(gProv.apiUrl) + 32];
  if (!buildClaimUrl(api, url, sizeof(url))) {
    setErr("URL Backend khong hop le: %s", api);
    halt();
    return false;
  }
  bool https = !strncasecmp(url, "https://", 8);
  if (https && !provConfigureTls(sHttps)) { halt(); return false; }

  JsonDocument req;
  req["macAddress"] = WiFi.macAddress();
  req["claimToken"] = token;
  char body[160];
  size_t bodyLen = serializeJson(req, body, sizeof(body));

  Serial.printf("[PROV] Claim -> %s (MAC %s)\n", url, WiFi.macAddress().c_str());
  HTTPClient http;
  if (!(https ? http.begin(sHttps, url) : http.begin(sHttp, url))) {
    setErr("Khong mo duoc URL %s", url);
    halt();
    return false;
  }
  http.setConnectTimeout(PROV_HTTP_TIMEOUT_MS);
  http.setTimeout(PROV_HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  const char* keep[] = { "Retry-After" };
  http.collectHeaders(keep, 1);

  wdtFeed();
  int status = http.POST((uint8_t*)body, bodyLen);
  wdtFeed();
  if (status <= 0) {
    setErr("Khong goi duoc Backend (%s) - kiem tra URL / Backend dang chay / cung mang LAN",
           http.errorToString(status).c_str());
    http.end();
    scheduleBackoff();
    return false;
  }
  String resp = http.getString();
  long retryAfter = http.header("Retry-After").toInt();
  http.end();
  wdtFeed();

  JsonDocument filter;
  filter["nodeCode"] = true;
  filter["replay"] = true;
  filter["mqttCredentials"] = true;
  JsonObject fd = filter["devices"].add<JsonObject>();
  fd["deviceCode"] = true;
  fd["type"] = true;
  fd["gpioPin"] = true;
  fd["config"]["metrics"] = true;
  fd["lifecycle"] = true;
  filter["error"]["code"] = true;
  filter["error"]["message"] = true;
  filter["error"]["details"]["retryAfterSec"] = true;
  filter["error"]["details"]["problems"] = true;
  JsonDocument doc;
  bool isJson = !deserializeJson(doc, resp, DeserializationOption::Filter(filter));

  if (status >= 200 && status < 300) {
    if (!isJson) { setErr("Phan hoi claim khong phai JSON (HTTP %d)", status); scheduleBackoff(); return false; }
    return applyClaim(doc, api);
  }

  const char* code = isJson ? (doc["error"]["code"] | "") : "";
  const char* msg  = isJson ? (doc["error"]["message"] | "") : "";
  char raw[81];
  if (!msg[0]) { strlcpy(raw, resp.c_str(), sizeof(raw)); msg = raw; }   // vd 429 của rate limit là text thường
  setErr("HTTP %d %s: %s", status, code[0] ? code : "-", msg);

  if (status == 429) {
    scheduleIn(retryAfter > 0 ? (uint32_t)retryAfter * 1000UL : PROV_RETRY_MAX_MS);
  } else if (!strcmp(code, "CLAIM_IN_PROGRESS")) {
    long s = doc["error"]["details"]["retryAfterSec"] | 5L;
    scheduleIn((uint32_t)(s > 0 ? s : 5) * 1000UL);
  } else if (!strcmp(code, "INVENTORY_MISMATCH")) {
    JsonArrayConst problems = doc["error"]["details"]["problems"];
    for (JsonVariantConst p : problems)
      Serial.printf("[PROV]   - %s\n", p | "");
    Serial.println(F("[PROV] Sua danh sach thiet bi cua Node tren web cho khop phan cung (type + gpioPin)."));
    scheduleIn(PROV_INVENTORY_RETRY_MS);
  } else if (!strcmp(code, "CLAIM_TOKEN_USED") || !strcmp(code, "CLAIM_TOKEN_EXPIRED") ||
             !strcmp(code, "CLAIM_SUPERSEDED") || !strcmp(code, "NODE_ALREADY_CLAIMED") ||
             !strcmp(code, "NODE_REVOKED")) {
    dropToken();
  } else if (!strcmp(code, "CLAIM_INVALID")) {
    Serial.printf("[PROV] Kiem tra: token copy du 43 ky tu, va Node tren web khai bao dung MAC %s\n",
                  WiFi.macAddress().c_str());
    halt();
  } else if (!strcmp(code, "INSECURE_TRANSPORT")) {
    Serial.println(F("[PROV] Backend bat CLAIM_REQUIRE_TLS: doi URL sang https:// va dan CA vao tls_ca.h."));
    halt();
  } else if (!strcmp(code, "BROKER_TLS_REQUIRED")) {
    Serial.println(F("[PROV] Loi cau hinh Backend: MQTT_DEVICE_URL phai la mqtts:// khi bat TLS."));
    halt();
  } else if (status == 404) {
    Serial.println(F("[PROV] Khong thay /api/provisioning/claim - kiem tra URL Backend (cong 3000?)."));
    halt();
  } else if (status >= 500) {
    scheduleBackoff();   // BROKER_UNAVAILABLE, CLAIM_FAILED... : tạm thời, dùng lại cùng token
  } else {
    halt();              // CLAIM_BAD_REQUEST và 4xx khác
  }
  return false;
}

bool provTick() {
  if (sKick) {
    sKick = false;
    sHalted = sWaiting = sWarnedNoApi = false;
    sBackoff = PROV_RETRY_MIN_MS;
    sAuthFails = 0;
  }
  char api[sizeof(gProv.apiUrl)], token[sizeof(gProv.claimToken)];
  stateLock();
  strlcpy(api, gProv.apiUrl, sizeof(api));
  strlcpy(token, gProv.claimToken, sizeof(token));
  stateUnlock();
  if (!token[0] || sHalted) return false;
  if (!api[0]) {
    if (!sWarnedNoApi) setErr("Co claim token nhung chua co URL Backend: nhap o cong cau hinh hoac go \"api http://<ip>:3000\"");
    sWarnedNoApi = true;
    return false;
  }
  if (sWaiting && (int32_t)(millis() - sNextTry) < 0) return false;
  sWaiting = false;
  return claimOnce(api, token);
}
