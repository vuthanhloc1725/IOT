import unittest
from types import SimpleNamespace

from tools.provision import validate, csv_rows


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.args = SimpleNamespace(
            node_code="NODE-0123456789ABCDEF",
            soil_code="DEV-0000000000000001",
            dht_code="DEV-0000000000000002",
            pump_code="DEV-0000000000000003",
            prefix="sf", broker="mqtts://broker.example:8883", wifi_ssid="TestWiFi",
            mqtt_user="node_one", soil_dry=3000, soil_wet=1000)

    def test_valid_distinct_codes_and_nvs_keys(self):
        validate(self.args, "wifi-secret", "mqtt-secret", "")
        rows = csv_rows(self.args, "wifi-secret", "mqtt-secret", "")
        self.assertIn(("node", "data", "string", self.args.node_code), rows)
        self.assertIn(("pass", "data", "string", "mqtt-secret"), rows)

    def test_rejects_duplicate_child(self):
        self.args.pump_code = self.args.soil_code
        with self.assertRaises(ValueError):
            validate(self.args, "wifi-secret", "mqtt-secret", "")

    def test_rejects_plaintext_broker(self):
        self.args.broker = "mqtt://broker.example:1883"
        with self.assertRaises(ValueError):
            validate(self.args, "wifi-secret", "mqtt-secret", "")

    def test_rejects_equal_calibration(self):
        self.args.soil_wet = self.args.soil_dry
        with self.assertRaises(ValueError):
            validate(self.args, "wifi-secret", "mqtt-secret", "")


if __name__ == "__main__":
    unittest.main()
