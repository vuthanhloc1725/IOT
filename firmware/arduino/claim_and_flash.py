#!/usr/bin/env python3
"""Claim a registered ESP32 by its USB MAC, generate Arduino config and optionally upload."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from urllib.parse import urlparse

SKETCH = Path(__file__).resolve().parent / "SoilPumpNode"
MAC_PATTERN = re.compile(r"\b(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\b")
CODE_PATTERN = re.compile(r"^(?:NODE|DEV)-[0-9A-F]{16}$")
ERROR_CODE_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{1,47}$")


def args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="USB serial port, e.g. /dev/ttyUSB0")
    parser.add_argument("--api", required=True, help="Backend origin, e.g. https://api.example.org")
    parser.add_argument("--allow-local-http", action="store_true",
                        help="Allow HTTP only to literal 127.0.0.1 or [::1] on this workstation")
    parser.add_argument("--wifi-ssid", required=True)
    parser.add_argument("--broker-ca", type=Path, required=True, help="PEM issuing CA for the MQTT broker")
    parser.add_argument("--dry-adc", type=int, required=True)
    parser.add_argument("--wet-adc", type=int, required=True)
    parser.add_argument("--ntp", default="pool.ntp.org")
    parser.add_argument("--relay-active-high", action="store_true")
    parser.add_argument("--upload", action="store_true", help="Compile/upload with arduino-cli after claim")
    parser.add_argument("--fqbn", default="esp32:esp32:esp32", help="arduino-cli board identifier")
    return parser.parse_args(argv)


def claim_endpoint(api, allow_local_http=False):
    parsed = urlparse(api)
    local_http = (allow_local_http and parsed.scheme == "http"
                  and parsed.hostname in ("127.0.0.1", "::1"))
    invalid_origin = (not parsed.hostname or parsed.username is not None
                      or parsed.password is not None or parsed.path not in ("", "/")
                      or parsed.params or parsed.query or parsed.fragment)
    if (parsed.scheme != "https" and not local_http) or invalid_origin:
        raise ValueError("--api must be a HTTPS origin without credentials, path, query or fragment; "
                         "--allow-local-http permits only http://127.0.0.1 or http://[::1]")
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError("Invalid Backend port")
    return parsed.geturl().rstrip("/") + "/api/provisioning/claim"


class NoClaimRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Claim endpoint redirected; use its direct origin instead")


def claim_opener(endpoint):
    handlers = [NoClaimRedirect()]
    if urlparse(endpoint).scheme == "http":
        # Explicit local mode must stay on this machine even if a proxy is configured.
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)



def claim_error_message(error, secrets=()):
    # Show only the API's code and message fields, never dump its body or submitted secrets.
    message = None
    code = None
    try:
        body = json.loads(error.read(8192))
        detail = body.get("error") if isinstance(body, dict) else None
        if isinstance(detail, dict) and isinstance(detail.get("message"), str):
            message = detail["message"]
        if isinstance(detail, dict) and isinstance(detail.get("code"), str) and ERROR_CODE_PATTERN.match(detail["code"]):
            code = detail["code"]
    except (ValueError, UnicodeError, OSError):
        pass
    finally:
        error.close()
    if message:
        for secret in sorted((s for s in secrets if s), key=len, reverse=True):
            message = message.replace(secret, "[REDACTED]")
        message = " ".join("".join(c if c.isprintable() else " " for c in message).split())[:500]
    if not message:
        message = ("Too many claim attempts; wait for the rate limit to expire"
                   if error.code == 429 else "Backend returned no error message; check Backend logs")
    return f"Claim rejected (HTTP {error.code}{' ' + code if code else ''}): {message}"


def read_mac(port):
    result = subprocess.run([sys.executable, "-m", "esptool", "--port", port, "read_mac"],
                            check=True, text=True, capture_output=True)
    found = MAC_PATTERN.search(result.stdout)
    if not found:
        raise ValueError("Cannot read ESP32 MAC from USB; check port, driver and esptool")
    return found.group().upper()


def c_string(value):
    # JSON double-quoted UTF-8 strings are also valid C++ string literals here.
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError("Invalid string in claim response")
    return json.dumps(value, ensure_ascii=False)


def read_inventory(response):
    node = response.get("nodeCode")
    creds = response.get("mqttCredentials") or {}
    if not isinstance(node, str) or not CODE_PATTERN.fullmatch(node) or not node.startswith("NODE-"):
        raise ValueError("Invalid Node code from Backend")
    assignments = {}
    for item in response.get("devices", []):
        if not isinstance(item, dict):
            continue
        key = (item.get("type"), item.get("gpioPin"))
        if key in [("SENSOR", 34), ("SENSOR", 4), ("PUMP", 26)]:
            code = item.get("deviceCode")
            if key in assignments or not isinstance(code, str) or not CODE_PATTERN.fullmatch(code) or not code.startswith("DEV-"):
                raise ValueError("Ambiguous or invalid GPIO assignment from Backend")
            expected = {("SENSOR", 34): "SOIL_MOISTURE", ("SENSOR", 4): "AIR_TEMPERATURE"}.get(key)
            if expected and expected not in (item.get("config") or {}).get("metrics", []):
                raise ValueError("Sensor metric inventory does not match this firmware")
            assignments[key] = code
    if len(assignments) != 3 or len(set(assignments.values())) != 3:
        raise ValueError("Register soil GPIO34, DHT11 GPIO4 and pump GPIO26 before claim")
    broker = urlparse(creds.get("brokerUrl", ""))
    if broker.scheme != "mqtts" or not broker.hostname or not broker.port or broker.username or broker.password or broker.path:
        raise ValueError("Backend brokerUrl must be mqtts://host:port")
    if not creds.get("username") or not creds.get("password") or creds.get("nodeCode") != node or creds.get("topicPrefix") != "sf":
        raise ValueError("Incomplete MQTT credentials or unexpected topic prefix")
    return node, assignments, creds, broker


def render_config(a, mac, wifi_password, response, ca):
    node, devices, creds, broker = read_inventory(response)
    values = {
        "EXPECTED_WIFI_MAC": mac, "NODE_CODE": node,
        "SOIL_DEVICE_CODE": devices[("SENSOR", 34)],
        "DHT_DEVICE_CODE": devices[("SENSOR", 4)],
        "PUMP_DEVICE_CODE": devices[("PUMP", 26)],
        "WIFI_SSID": a.wifi_ssid, "WIFI_PASSWORD": wifi_password,
        "MQTT_HOST": broker.hostname, "MQTT_USERNAME": creds["username"],
        "MQTT_PASSWORD": creds["password"], "MQTT_TOPIC_PREFIX": creds["topicPrefix"],
        "NTP_SERVER": a.ntp, "MQTT_CA_PEM": ca,
    }
    lines = ["#pragma once", "// Generated locally after one-time claim. Never commit or share this file."]
    lines.extend(f"#define {key} {c_string(value)}" for key, value in values.items())
    lines.extend([f"#define MQTT_PORT {broker.port}", f"#define SOIL_DRY_ADC {a.dry_adc}",
                  f"#define SOIL_WET_ADC {a.wet_adc}",
                  f"#define PUMP_ACTIVE_LEVEL {'HIGH' if a.relay_active_high else 'LOW'}", ""])
    return "\n".join(lines)


def main(argv=None):
    a = args(argv)
    endpoint = claim_endpoint(a.api, a.allow_local_http)
    if not (0 <= a.wet_adc < a.dry_adc - 100 and a.dry_adc <= 4095):
        raise ValueError("ADC calibration must satisfy 0 <= wet < dry-100 <= 4095")
    if not 1 <= len(a.wifi_ssid.encode()) <= 32:
        raise ValueError("Invalid Wi-Fi SSID length")
    ca = a.broker_ca.read_text(encoding="ascii")
    if "-----BEGIN CERTIFICATE-----" not in ca or "-----END CERTIFICATE-----" not in ca:
        raise ValueError("--broker-ca must contain a PEM certificate")
    target = SKETCH / "device_config.h"
    if target.exists():
        raise FileExistsError(f"{target} exists; archive/remove it intentionally before a different claim")
    mac = read_mac(a.port)
    print(f"USB ESP32 Wi-Fi base MAC: {mac}")
    wifi_password = getpass.getpass("Wi-Fi password: ")
    token = getpass.getpass("One-time claim token from Admin: ").strip()
    if not 8 <= len(wifi_password) <= 63:
        raise ValueError("Wi-Fi password must have 8..63 characters")
    request = urllib.request.Request(endpoint,
        data=json.dumps({"macAddress": mac, "claimToken": token}).encode(),
        headers={"Content-Type": "application/json", "Cache-Control": "no-store"}, method="POST")
    try:
        with claim_opener(endpoint).open(request, timeout=35) as reply:
            response = json.load(reply)
    except urllib.error.HTTPError as exc:
        raise ValueError(claim_error_message(exc, (token, wifi_password))) from None
    config = render_config(a, mac, wifi_password, response, ca)
    descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(config)
    print(f"Claimed {response['nodeCode']} for {mac}; generated private {target}")
    if a.upload:
        with tempfile.TemporaryDirectory(prefix="arduino-claim-build-") as build:
            subprocess.run(["arduino-cli", "compile", "--fqbn", a.fqbn, "--build-path", build, str(SKETCH)], check=True)
            if read_mac(a.port) != mac:
                raise ValueError("USB board changed during build; refusing to upload")
            subprocess.run(["arduino-cli", "upload", "--fqbn", a.fqbn, "--port", a.port,
                            "--input-dir", build, str(SKETCH)], check=True)
        print("Uploaded. Open Serial Monitor at 115200 and verify MAC, Node and MQTT.")
    else:
        print("Open SoilPumpNode.ino in Arduino IDE and upload to the same USB board.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, FileNotFoundError, FileExistsError, subprocess.CalledProcessError,
            urllib.error.URLError, json.JSONDecodeError) as error:
        print(f"Provisioning failed: {error}", file=sys.stderr)
        sys.exit(1)
