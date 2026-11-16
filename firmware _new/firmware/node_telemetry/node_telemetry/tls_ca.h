/*
 * tls_ca.h - v1.5: chứng chỉ CA gốc để kiểm tra server khi gọi https:// (claim) và mqtts:// (broker).
 *
 *  Để trống ("") khi Backend/broker chạy http:// và mqtt:// trong mạng LAN (thử nghiệm).
 *  Chạy thật (CLAIM_REQUIRE_TLS=true, MQTT_DEVICE_URL=mqtts://...): dán CA dạng PEM vào giữa,
 *  giữ nguyên "\n" cuối mỗi dòng, ví dụ:
 *
 *    static const char kTlsRootCa[] =
 *      "-----BEGIN CERTIFICATE-----\n"
 *      "MIIDdzCCAl+gAwIBAgIE...\n"
 *      "-----END CERTIFICATE-----\n";
 *
 *  Một CA dùng chung cho cả Backend và broker (vd: CA nội bộ tự ký, hoặc ISRG Root X1 nếu dùng
 *  Let's Encrypt). Không có CA và TLS_ALLOW_INSECURE = 0 -> firmware từ chối kết nối TLS.
 */
#pragma once

// CA nội bộ của broker Mosquitto 192.168.0.103:8883 (/etc/mosquitto/certs/ca.crt, CN "IoT Local MQTT CA 2026", hết hạn 07/11/2036)
static const char kTlsRootCa[] =
  "-----BEGIN CERTIFICATE-----\n"
  "MIIEMzCCApugAwIBAgIUaqVpCx0sPVU99KxLYHwh2bbjPWwwDQYJKoZIhvcNAQEL\n"
  "BQAwITEfMB0GA1UEAwwWSW9UIExvY2FsIE1RVFQgQ0EgMjAyNjAeFw0yNjExMTAx\n"
  "NjI1MjNaFw0zNjExMDcxNjI1MjNaMCExHzAdBgNVBAMMFklvVCBMb2NhbCBNUVRU\n"
  "IENBIDIwMjYwggGiMA0GCSqGSIb3DQEBAQUAA4IBjwAwggGKAoIBgQDVdIh1Htyn\n"
  "npgk6soQcasNY6Bqedc1jscyRvjpJtattbhp0STObbZk56b3kcjNwnE02Mw7bh77\n"
  "U7OkNWtEATV44Z8RZVqvdUgTcuTegdbvWW1d1Ggt+bv9WVMJs5+mBzT+6FWU+iq6\n"
  "NXvIgvZyaU6B0aidEx9/DEIXP83rNIeJ0bAda6cggaTl1CVkVbfDOcV18pjfJHvk\n"
  "DE8+3JQpI7g/z85gpNZ4AkOdcsrVKUcjbXdjK1RLtcN77P26iFBp/3SwVIpM+r23\n"
  "8v9cTq2JDpHElGc9vmawnpTng4jDd9X/DQmY3JaoqJiEvQNPi92ZOB3nOUY1YieE\n"
  "QTwdsalxUVbQ1qnqN4ybFlAiOTvvHXDD0IHMwzwwMMsvvQad8Ik4yPARK7L/7Wx3\n"
  "i0Dak7mpWHfTITekQrbzio8d6xmMK1gaWmnSpaubwWjeQQGbSUmDXfXXVJB9GBJm\n"
  "tfkJd8PoE/sCLxPgA3X6hORbGsVyCGyNeGazw7o2CWQP1mIg6q0AzdUCAwEAAaNj\n"
  "MGEwHQYDVR0OBBYEFCsqUr2rv4WiZPdKW7VT7vQgxjEGMB8GA1UdIwQYMBaAFCsq\n"
  "Ur2rv4WiZPdKW7VT7vQgxjEGMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQD\n"
  "AgEGMA0GCSqGSIb3DQEBCwUAA4IBgQAdzMJp4e6xPBRADqQKO6vAzakduSIlZgrD\n"
  "UdXbfzaYSuCsTtFrMkPs0l7LCeM/F8Kjenq9bVeTLv9+aoZqw0zchFl9zxkMqQ8k\n"
  "tjSJVk0LajTK3I0EkJfcThPwmQSiD9qxkEptbRqz/PoSXaLBFkotUC6XJ/zVjn/u\n"
  "an+8QIdI2p9RJZkIa+dhM1L0byzByTQCAGxTTL8NscskPCKLfWR5hhrFNjB+KFwp\n"
  "RD35xm+Zl1HxYEjMUNUZJB2sqyhki7xl0yjz6buIygrozH3t0GfMtJgERYh13aJ0\n"
  "13knwSrSCuTUi6bvpAzO183TTX8lv9MjqK7H5PalH+lwYrejac5uSaNA8ekMV7op\n"
  "/V0qWjV+r4NZn00Qzw4Q1cEdd3EEl8jvUCe51J3VibEk+y5pZGVyaia+zV8FoBXC\n"
  "yB645eG90QwQabzs6rEqNBQh83GfbtQPRul6VCtojtLv5fO4VV73zrylGPdmBD3X\n"
  "cla6it9GgeuWPyuzMZ+7qnafWKDReDQ=\n"
  "-----END CERTIFICATE-----\n";
