#!/usr/bin/env python3
"""Flash a per-node NVS partition without putting secrets in source or argv."""

import argparse
import csv
import getpass
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


PARTITION_OFFSET = "0x9000"
PARTITION_SIZE = "0x6000"
NODE_RE = re.compile(r"NODE-[A-F0-9]{16}\Z")
DEVICE_RE = re.compile(r"DEV-[A-F0-9]{16}\Z")
PREFIX_RE = re.compile(r"[A-Za-z0-9._-]{1,30}\Z")


def arguments(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--port", required=True, help="ESP32 USB serial port, e.g. /dev/ttyUSB0")
    p.add_argument("--node-code", required=True)
    p.add_argument("--soil-code", required=True)
    p.add_argument("--dht-code", required=True)
    p.add_argument("--pump-code", required=True)
    p.add_argument("--wifi-ssid", required=True)
    p.add_argument("--broker", required=True, help="mqtts://host:8883, not localhost")
    p.add_argument("--mqtt-user", required=True)
    p.add_argument("--prefix", default="sf")
    p.add_argument("--soil-dry", type=int, required=True, help="raw 12-bit ADC in dry soil")
    p.add_argument("--soil-wet", type=int, required=True, help="raw 12-bit ADC in wet soil")
    p.add_argument("--ca-cert", type=Path, help="PEM CA for a private broker; public CA uses ESP-IDF bundle")
    p.add_argument("--generate-only", type=Path,
                   help="write NVS image instead of flashing; image contains plaintext secrets")
    return p.parse_args(argv)


def validate(a, wifi_pass, mqtt_pass, ca):
    if not NODE_RE.fullmatch(a.node_code):
        raise ValueError("nodeCode must be NODE- followed by 16 uppercase hex digits")
    codes = [a.soil_code, a.dht_code, a.pump_code]
    if any(not DEVICE_RE.fullmatch(code) for code in codes) or len(set(codes)) != 3:
        raise ValueError("provide three distinct backend-generated DEV-<16 hex> codes")
    if not PREFIX_RE.fullmatch(a.prefix):
        raise ValueError("invalid topic prefix")
    if not a.broker.startswith("mqtts://") or len(a.broker) > 159:
        raise ValueError("broker must be mqtts://host:port (TLS required)")
    if not 1 <= len(a.wifi_ssid.encode()) <= 32 or not 8 <= len(wifi_pass) <= 63:
        raise ValueError("Wi-Fi SSID/password length invalid (WPA2-PSK required)")
    if not 1 <= len(a.mqtt_user) < 80 or not 1 <= len(mqtt_pass) < 128:
        raise ValueError("MQTT credential length invalid")
    if not 0 <= a.soil_dry <= 4095 or not 0 <= a.soil_wet <= 4095 or a.soil_dry == a.soil_wet:
        raise ValueError("soil ADC calibration must be two distinct values from 0 to 4095")
    if len(ca.encode()) > 3900:
        raise ValueError("CA PEM too large for NVS string (3900-byte limit)")
    if ca and ("-----BEGIN CERTIFICATE-----" not in ca or "-----END CERTIFICATE-----" not in ca):
        raise ValueError("CA certificate must be PEM")
    for text in (a.wifi_ssid, wifi_pass, a.mqtt_user, mqtt_pass, a.broker):
        if "\x00" in text or "\n" in text or "\r" in text:
            raise ValueError("credentials cannot contain NUL or newline")


def csv_rows(a, wifi_pass, mqtt_pass, ca):
    return [
        ("key", "type", "encoding", "value"),
        ("nodecfg", "namespace", "", ""),
        ("ssid", "data", "string", a.wifi_ssid),
        ("wifi_pass", "data", "string", wifi_pass),
        ("broker", "data", "string", a.broker),
        ("user", "data", "string", a.mqtt_user),
        ("pass", "data", "string", mqtt_pass),
        ("prefix", "data", "string", a.prefix),
        ("node", "data", "string", a.node_code),
        ("soil", "data", "string", a.soil_code),
        ("dht", "data", "string", a.dht_code),
        ("pump", "data", "string", a.pump_code),
        ("dry", "data", "i32", str(a.soil_dry)),
        ("wet", "data", "i32", str(a.soil_wet)),
        *([("ca_pem", "data", "string", ca)] if ca else []),
    ]


def main(argv=None):
    a = arguments(argv)
    wifi_pass = getpass.getpass("Wi-Fi password: ")
    mqtt_pass = getpass.getpass("Node MQTT password (shown only once by Admin): ")
    ca = a.ca_cert.read_text(encoding="ascii") if a.ca_cert else ""
    validate(a, wifi_pass, mqtt_pass, ca)
    idf = os.environ.get("IDF_PATH")
    if not idf:
        raise RuntimeError("source ESP-IDF export.sh before running provision.py")
    generator = Path(idf) / "components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py"
    if not generator.is_file():
        raise RuntimeError(f"NVS generator missing: {generator}")
    with tempfile.TemporaryDirectory(prefix="esp32-node-") as folder:
        os.chmod(folder, 0o700)
        source = Path(folder) / "secrets.csv"
        image = Path(folder) / "node-nvs.bin"
        with source.open("w", encoding="utf-8", newline="") as stream:
            csv.writer(stream).writerows(csv_rows(a, wifi_pass, mqtt_pass, ca))
        source.chmod(0o600)
        subprocess.run([sys.executable, str(generator), "generate", str(source),
                        str(image), PARTITION_SIZE], check=True)
        if a.generate_only:
            if a.generate_only.exists():
                raise FileExistsError(a.generate_only)
            a.generate_only.write_bytes(image.read_bytes())
            a.generate_only.chmod(0o600)
            print(f"Wrote secret NVS image to {a.generate_only}; do not commit or share it")
        else:
            subprocess.run([sys.executable, "-m", "esptool", "--chip", "esp32",
                            "--port", a.port, "write_flash", PARTITION_OFFSET, str(image)], check=True)
            print(f"Provisioned {a.node_code}. Reset the board and monitor its serial output.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, FileNotFoundError, subprocess.CalledProcessError) as exc:
        print(f"Provisioning failed: {exc}", file=sys.stderr)
        sys.exit(1)
