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

// CA nội bộ của broker Mosquitto (/etc/mosquitto/certs/ca.crt, CN "IoT Local MQTT CA 2026-11", hạn 10 năm).
// Chứng chỉ broker hợp lệ cho: localhost, archlinux, archlinux.local, 127.0.0.1, 192.168.0.103, 10.255.3.252.
static const char kTlsRootCa[] =
  "-----BEGIN CERTIFICATE-----\n"
  "MIIDOTCCAiGgAwIBAgIUKorhB71TyUrZ5qibjDj51hh/O7swDQYJKoZIhvcNAQEL\n"
  "BQAwJDEiMCAGA1UEAwwZSW9UIExvY2FsIE1RVFQgQ0EgMjAyNi0xMTAeFw0yNjEx\n"
  "MTcwMTU0MjNaFw0zNjExMTQwMTU0MjNaMCQxIjAgBgNVBAMMGUlvVCBMb2NhbCBN\n"
  "UVRUIENBIDIwMjYtMTEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDk\n"
  "v8pDvw8iu/fYWKUYxraMgacA3EWtleJPH9JdyphZ9NShG/l/9vhiyNKqtfHqdczI\n"
  "HOMY6SHDv34ymaaYxry+6mSnEfIfdS+gHq1bLr0Ts4J2S/uFrCDOCqRWnywfG5R5\n"
  "3ZN8dOGgA2AMPl+Vj6DtZ/aXLPi5uo130wbwPtWP/iE/R5KS2a3/OMOHEdkjZ1b2\n"
  "3BJ7N4JT0l5PMDugZ38GbMCS27BeRXAlGThLnf5i3k6pSTxvt2W2ceUVOfcNDvy7\n"
  "M3Z/q2LQhLKQQIYm76hEfBYAxFGqgEckM9d5Y5yExKCFuiSyAfaXeejyxYXYDyzm\n"
  "+vyfz0Qli3vetU8mvSOFAgMBAAGjYzBhMB0GA1UdDgQWBBRR86NAl+V8hA6hcN+P\n"
  "pEaOco4bDzAfBgNVHSMEGDAWgBRR86NAl+V8hA6hcN+PpEaOco4bDzAPBgNVHRMB\n"
  "Af8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAQEAgzz5\n"
  "fEEi6y6TK4VQE9LpbBFUNDvs+NIG1Jiz/mlFfvo2SjRGbeXrwskU+hJV25VlPzga\n"
  "KsqGukcrzqBKhbkoa/IPS3JGTq5pr37EodtUQIdUoh/VSqTgJdt/K+lgEXrjtCii\n"
  "1LTQXE8DPCN3K9EVBE380g4Rf4NneWLQlWHexGI1HRlYPFxN9KmNkoywaD2fo4n8\n"
  "maQUgjY++olYc8nYARcKbAtLJIc+Kal2zAUd8EvXdeSGViFnwwh/hCqqnBgMK9WH\n"
  "SfpkkTJUtvR7CUVJKq6T4o1m8xVdfYpvVs25c95xuclHQCBAfbFySw6omb41EkiR\n"
  "2cKXCepCJCDuX18QKg==\n"
  "-----END CERTIFICATE-----\n";
