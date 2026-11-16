import argparse
import io
import json
import urllib.error
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.request

import claim_and_flash as tool


class ClaimTests(unittest.TestCase):
    def setUp(self):
        self.args = argparse.Namespace(wifi_ssid="Garden", dry_adc=3000, wet_adc=1000,
                                        ntp="pool.ntp.org", relay_active_high=False)
        self.devices = [
            {"deviceCode": "DEV-0000000000000001", "type": "SENSOR", "gpioPin": 34,
             "config": {"metrics": ["SOIL_MOISTURE"]}},
            {"deviceCode": "DEV-0000000000000002", "type": "SENSOR", "gpioPin": 4,
             "config": {"metrics": ["AIR_TEMPERATURE", "AIR_HUMIDITY"]}},
            {"deviceCode": "DEV-0000000000000003", "type": "PUMP", "gpioPin": 26},
        ]
        self.response = {"nodeCode": "NODE-0123456789ABCDEF", "devices": self.devices,
                         "mqttCredentials": {"brokerUrl": "mqtts://broker.example.org:8883",
                                             "nodeCode": "NODE-0123456789ABCDEF",
                                             "topicPrefix": "sf", "username": "node-1", "password": "secret"}}

    def test_maps_gpio_to_exact_existing_contract(self):
        text = tool.render_config(self.args, "24:6F:28:AA:BB:CC", 'hello"world', self.response,
                                  "-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n")
        self.assertIn('#define EXPECTED_WIFI_MAC "24:6F:28:AA:BB:CC"', text)
        self.assertIn('#define SOIL_DEVICE_CODE "DEV-0000000000000001"', text)
        self.assertIn('#define WIFI_PASSWORD "hello\\\"world"', text)
        self.assertIn('#define MQTT_TOPIC_PREFIX "sf"', text)

    def test_rejects_missing_device_or_wrong_metric(self):
        self.response["devices"] = self.devices[:2]
        with self.assertRaises(ValueError):
            tool.read_inventory(self.response)
        self.response["devices"] = self.devices
        self.devices[0]["config"]["metrics"] = ["AIR_HUMIDITY"]
        with self.assertRaises(ValueError):
            tool.read_inventory(self.response)

    def test_api_https_and_explicit_literal_loopback(self):
        cases = [("https://api.example.org", False),
                 ("https://api.example.org:443/", False),
                 ("http://127.0.0.1:3000", True),
                 ("http://[::1]:3000/", True)]
        for origin, local_mode in cases:
            with self.subTest(origin=origin):
                self.assertEqual(tool.claim_endpoint(origin, local_mode),
                                 origin.rstrip("/") + "/api/provisioning/claim")

    def test_rejects_nonlocal_http_and_invalid_api_origins(self):
        cases = [("http://127.0.0.1:3000", False),
                 ("http://localhost:3000", True),
                 ("http://192.168.0.103:3000", True),
                 ("http://127.0.0.1.example.org", True),
                 ("http://127.0.0.1@external.example", True),
                 ("https://user@example.org", False),
                 ("https://example.org/api", False),
                 ("https://example.org?target=external", False),
                 ("https://example.org/#fragment", False),
                 ("https://example.org:0", False),
                 ("https://example.org:65536", False),
                 ("file:///tmp/config", True)]
        for origin, local_mode in cases:
            with self.subTest(origin=origin):
                with self.assertRaises(ValueError):
                    tool.claim_endpoint(origin, local_mode)

    def test_local_claim_bypasses_proxy_and_rejects_redirects(self):
        proxy_env = {"http_proxy": "http://proxy.invalid:8888",
                     "HTTP_PROXY": "http://proxy.invalid:8888"}
        with patch.dict("os.environ", proxy_env):
            opener = tool.claim_opener("http://127.0.0.1:3000/api/provisioning/claim")
        self.assertFalse(any(isinstance(h, urllib.request.ProxyHandler) and h.proxies
                             for h in opener.handlers))
        handler = next(h for h in opener.handlers if isinstance(h, tool.NoClaimRedirect))
        request = urllib.request.Request("http://127.0.0.1:3000", data=b"fake-token")
        with self.assertRaises(ValueError):
            handler.redirect_request(request, None, 302, "Found", {}, "https://external.example")

    def test_claim_error_shows_backend_reason_without_other_fields(self):
        message = "Không thể claim: MAC/token sai, hết hạn hoặc đã sử dụng"
        payload = {"error": {"status": 403, "message": message,
                             "details": {"password": "do-not-print"}}}
        error = urllib.error.HTTPError("http://127.0.0.1:3000", 403, "Forbidden", {},
                                       io.BytesIO(json.dumps(payload).encode()))
        result = tool.claim_error_message(error)
        self.assertEqual(result, f"Claim rejected (HTTP 403): {message}")
        self.assertNotIn("do-not-print", result)

    def test_claim_error_includes_safe_error_code(self):
        payload = {"error": {"code": "CLAIM_TOKEN_USED", "message": "Token already used"}}
        error = urllib.error.HTTPError("http://127.0.0.1:3000", 409, "Conflict", {},
                                       io.BytesIO(json.dumps(payload).encode()))
        self.assertEqual(tool.claim_error_message(error),
                         "Claim rejected (HTTP 409 CLAIM_TOKEN_USED): Token already used")
        payload["error"]["code"] = "bad code\x1b"
        error = urllib.error.HTTPError("http://127.0.0.1:3000", 409, "Conflict", {},
                                       io.BytesIO(json.dumps(payload).encode()))
        self.assertEqual(tool.claim_error_message(error), "Claim rejected (HTTP 409): Token already used")

    def test_claim_error_redacts_submitted_secrets_and_control_characters(self):
        payload = {"error": {"message": "Bad fake-token\npass-example\x1b"}}
        error = urllib.error.HTTPError("http://127.0.0.1:3000", 403, "Forbidden", {},
                                       io.BytesIO(json.dumps(payload).encode()))
        result = tool.claim_error_message(error, ("fake-token", "pass-example"))
        self.assertEqual(result, "Claim rejected (HTTP 403): Bad [REDACTED] [REDACTED]")

    def test_claim_error_falls_back_for_non_json_or_unexpected_response(self):
        for payload in (b"<html>private server error</html>", b"[]", b'{"error":null}',
                        b'{"error":{"message":123}}', b"x" * 9000):
            with self.subTest(payload=payload[:25]):
                error = urllib.error.HTTPError("http://127.0.0.1:3000", 403, "Forbidden", {},
                                               io.BytesIO(payload))
                self.assertEqual(tool.claim_error_message(error),
                                 "Claim rejected (HTTP 403): Backend returned no error message; check Backend logs")

    def test_claim_error_explains_plaintext_rate_limit(self):
        error = urllib.error.HTTPError("http://127.0.0.1:3000", 429, "Too Many Requests", {},
                                       io.BytesIO(b"Too many requests, please try again later."))
        self.assertIn("wait for the rate limit", tool.claim_error_message(error))

    def test_rejects_plaintext_broker(self):
        self.response["mqttCredentials"]["brokerUrl"] = "mqtt://broker.example.org:1883"
        with self.assertRaises(ValueError):
            tool.read_inventory(self.response)


if __name__ == "__main__":
    unittest.main()
