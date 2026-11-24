/*
 * TEST 06 - Kết nối WiFi + MQTT broker (Mosquitto) và đo độ trễ khứ hồi (round-trip)
 * Board: ESP32 Dev Module | Thư viện: PubSubClient
 * Sửa WIFI_*, MQTT_HOST bên dưới. Trên máy tính có thể theo dõi bằng:
 *     mosquitto_sub -h <broker> -t "sf/test/#" -v
 *     (broker dùng tools/mosquitto.conf -> phải thêm -u admin -P <mật khẩu>)
 * Gửi lệnh thử từ máy tính:
 *     mosquitto_pub -h <broker> -u admin -P <mật khẩu> -t "sf/test/cmd" -m "hello"
 * v1.1: thêm MQTT_USER/MQTT_PASS - broker mẫu đặt allow_anonymous false nên kết nối ẩn
 *       danh (bản 1.0) luôn bị từ chối rc=5. Dùng tài khoản admin (ACL cho phép sf/#).
 * Đạt khi: kết nối thành công, độ trễ khứ hồi trung bình < 100 ms trong mạng LAN,
 *          rút điện router 30s rồi cắm lại -> ESP32 tự kết nối lại (không cần reset).
 */
#include <WiFi.h>
#include <PubSubClient.h>

const char* WIFI_SSID = "TEN_WIFI";
const char* WIFI_PASS = "MAT_KHAU";
const char* MQTT_HOST = "192.168.1.100";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USER = "admin";      // để "" nếu broker cho phép ẩn danh
const char* MQTT_PASS = "MAT_KHAU_MQTT";

WiFiClient net;
PubSubClient mqtt(net);
uint32_t sent = 0, recv = 0, sumRtt = 0, maxRtt = 0;

void onMsg(char* topic, byte* p, unsigned int len) {
  String t(topic), s; for (unsigned i = 0; i < len; i++) s += (char)p[i];
  if (t == "sf/test/echo") {
    uint32_t rtt = millis() - s.toInt();
    recv++; sumRtt += rtt; maxRtt = max(maxRtt, rtt);
    Serial.printf("RTT = %lu ms | TB = %lu ms | max = %lu ms | mat goi = %lu/%lu\n",
                  rtt, sumRtt / recv, maxRtt, sent - recv, sent);
  } else {
    Serial.printf("Nhan [%s]: %s\n", topic, s.c_str());
  }
}

void reconnect() {
  while (!mqtt.connected()) {
    Serial.print("Ket noi MQTT... ");
    bool hasUser = MQTT_USER[0] != 0;
    if (mqtt.connect("esp32-test06", hasUser ? MQTT_USER : nullptr, hasUser ? MQTT_PASS : nullptr,
                     "sf/test/status", 1, true, "offline")) {
      Serial.println("OK");
      mqtt.publish("sf/test/status", "online", true);
      mqtt.subscribe("sf/test/echo");
      mqtt.subscribe("sf/test/cmd");
    } else {
      Serial.printf("loi rc=%d (5 = sai user/pass/ACL, -2 = sai IP hoac firewall), thu lai sau 2s\n", mqtt.state());
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.printf("\nWiFi OK, IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMsg);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { Serial.println("Mat WiFi, cho ket noi lai..."); WiFi.reconnect(); delay(3000); return; }
  if (!mqtt.connected()) reconnect();
  mqtt.loop();
  static uint32_t last = 0;
  if (millis() - last > 2000) {
    last = millis();
    char buf[16]; snprintf(buf, sizeof(buf), "%lu", millis());
    mqtt.publish("sf/test/echo", buf);   // tự gửi cho chính mình qua broker -> đo khứ hồi
    sent++;
  }
}
