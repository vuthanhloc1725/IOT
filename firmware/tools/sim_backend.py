#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sim_backend.py (v1.4) - Giả lập Backend để TEST FIRMWARE khi chưa chạy được Backend thật.

v1.4: dùng ĐÚNG giao thức của Backend nhóm (bản 02/11/2026, Backend/docs/FIRMWARE_V12_INTEGRATION.md):
  Node -> Backend : sf/<node>/telemetry           {"seq","bc","up","ts","soilMoisture","temperature","humidity","pumpOn","fanOn"}
                    sf/<node>/telemetry/backfill  cùng dạng, "backfilled": true
                    sf/<node>/heartbeat, status (online/LWT + {"event":...} + {"deviceCode","deviceStatus"})
                    sf/<node>/cmd/ack             {"commandUuid","deviceCode","success",...}
                    sf/<node>/config/ack          {"deviceCode","version","success"}
  Backend -> Node : sf/<node>/cmd                 {"action":"pump"|"fan"|"config"|"lifecycle"|...}
  09/11: bỏ phần Node Camera (ESP32-CAM). Ảnh lá chụp bằng camera điện thoại, không qua firmware.

Làm được:
  * In gọn mọi bản tin sf/#, báo Online/Offline (heartbeat quá hạn)
  * Kiểm tra ACK giống Backend: commandUuid khớp, success là Boolean, deviceCode khớp, trả trong 15 s
  * --setup NODE-01 : gửi config bơm/quạt (PROVISIONED) rồi lifecycle ACTIVE cho 4 thiết bị
                      SOIL-01 (GPIO34), DHT-01 (GPIO4), PUMP-01 (GPIO26), FAN-01 (GPIO27)

Cài đặt:  pip install paho-mqtt
Chạy:     python sim_backend.py --host 192.168.1.100 -u admin -P <mat_khau> --setup NODE-01

Lệnh gõ (Enter):
  NODE-01 active SOIL-01|DHT-01|PUMP-01|FAN-01      lifecycle ACTIVE (có commandUuid, chờ ACK)
  NODE-01 lc <code> MAINTENANCE|FAULT|...           đổi lifecycle khác (không chờ ACK, như Backend)
  NODE-01 config PUMP-01|FAN-01                      gửi config (version tự tăng) -> config/ack
  NODE-01 pump PUMP-01 on|off                        bật/tắt bơm (on: seconds=10)
  NODE-01 fan FAN-01 on|off                          bật/tắt quạt
  NODE-01 cmd {"action":"pump_unlock"}               lệnh tùy ý trên sf/<node>/cmd
Lưu ý: KHÔNG dùng "mosquitto_sub ... > anh.jpg" trong PowerShell để lưu ảnh (hỏng dữ liệu nhị phân).
"""
import argparse
import json
import math
import os
import sys
import threading
import time
import uuid
import warnings
from datetime import datetime

warnings.filterwarnings("ignore", category=DeprecationWarning)

try:
    import paho.mqtt.client as mqtt
except ImportError:
    sys.exit("Chua cai thu vien: pip install paho-mqtt")

ROOT = "sf"            # = MQTT_FIRMWARE_TOPIC_PREFIX của Backend
# Thiết bị mẫu của node telemetry: code -> (type, gpio, config.metrics)
DEVICES = {"SOIL-01": ("SENSOR", 34, ["SOIL_MOISTURE"]),
           "DHT-01": ("SENSOR", 4, ["AIR_TEMPERATURE", "AIR_HUMIDITY"]),
           "PUMP-01": ("PUMP", 26, None),
           "FAN-01": ("FAN", 27, None)}
FLAT = {"soilMoisture": "SOIL_MOISTURE", "temperature": "AIR_TEMPERATURE", "humidity": "AIR_HUMIDITY"}
ACK_TIMEOUT = 15


def now_str():
    return datetime.now().strftime("%H:%M:%S")


class SimBackend:
    def __init__(self, args):
        self.a = args
        self.lock = threading.Lock()
        self.nodes = {}            # node -> {"online", "last_hb"}
        self.version = {}          # deviceCode -> config version đã gửi
        self.pending_cmd = {}      # commandUuid -> (node, code, action, t)
        self.seen = set()          # (node, bc, seq) chống trùng như Backend
        self.stats = {"readings": 0, "dup": 0, "backfilled": 0}
        try:   # paho-mqtt >= 2.0
            self.c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id=args.client_id)
        except AttributeError:  # paho-mqtt 1.x
            self.c = mqtt.Client(client_id=args.client_id)
        if args.user:
            self.c.username_pw_set(args.user, args.password)
        self.c.on_connect = self.on_connect
        self.c.on_message = self.on_message
        self.c.on_disconnect = lambda c, u, rc: print(f"{now_str()} [BROKER] mat ket noi rc={rc}")

    # ------------------------------------------------------------------ gửi xuống node (sf/<node>/cmd)
    def pub(self, node, obj):
        self.c.publish(f"{ROOT}/{node}/cmd", json.dumps(obj), qos=1, retain=False)
        print(f"{now_str()} [SIM] -> {node}/cmd {json.dumps(obj, ensure_ascii=False)}")

    def _dev(self, code):
        return DEVICES.get(code, ("PUMP" if "PUMP" in code.upper() else "FAN" if "FAN" in code.upper() else "SENSOR",
                                  None, None))

    def with_uuid(self, node, code, action, msg):
        cu = str(uuid.uuid4())
        with self.lock:
            self.pending_cmd[cu] = (node, code, action, time.time())
        msg.update({"commandUuid": cu, "commandId": cu})
        self.pub(node, msg)

    def lifecycle(self, node, code, state, need_ack):
        typ, gpio, _ = self._dev(code)
        msg = {"action": "lifecycle", "deviceCode": code, "type": typ, "gpioPin": gpio,
               "lifecycle": state.upper(), "state": state.upper()}
        if need_ack:
            self.with_uuid(node, code, "lifecycle", msg)
        else:
            self.pub(node, msg)

    def config(self, node, code, lifecycle="PROVISIONED"):
        typ, gpio, metrics = self._dev(code)
        with self.lock:
            self.version[code] = self.version.get(code, 0) + 1
            ver = self.version[code]
        if typ == "PUMP":
            cfg = {"pumpAutoEnabled": True, "soilOnPct": 35, "soilOffPct": 60, "pumpMaxRunSec": 30, "pumpCooldownSec": 60}
        elif typ == "FAN":
            cfg = {"fanAutoEnabled": True, "fanOnTempC": 32, "fanOffTempC": 30, "fanOnHumidityPct": 85, "fanOffHumidityPct": 80}
        else:
            cfg = {"metrics": metrics or []}
        self.pub(node, {"action": "config", "deviceCode": code, "type": typ, "gpioPin": gpio,
                        "lifecycle": lifecycle, "config": cfg, "version": ver})

    def actuator(self, node, code, on):
        typ, gpio, _ = self._dev(code)
        action = "fan" if typ == "FAN" else "pump"
        msg = {"deviceCode": code, "action": action, "type": typ, "gpioPin": gpio, "on": on, "turnOn": on}
        if action == "pump" and on:
            msg["seconds"] = 10
        self.with_uuid(node, code, action, msg)

    # ------------------------------------------------------------------ MQTT
    def on_connect(self, c, userdata, flags, rc):
        if rc != 0:
            print(f"{now_str()} [BROKER] ket noi THAT BAI rc={rc} (5 = sai user/pass hoac ACL)")
            return
        print(f"{now_str()} [BROKER] da ket noi {self.a.host}:{self.a.port}, subscribe {ROOT}/#")
        c.subscribe([(f"{ROOT}/#", 1)])
        if self.a.setup:
            threading.Thread(target=self.auto_setup, args=(self.a.setup,), daemon=True).start()

    def on_message(self, c, userdata, msg):
        parts = msg.topic.split("/")
        if len(parts) < 3:
            return
        root, node, sub = parts[0], parts[1], "/".join(parts[2:])
        if root == ROOT and sub == "cmd":
            return                                   # bản tin do chính "backend" gửi xuống
        try:
            text = msg.payload.decode("utf-8", errors="replace")
            data = json.loads(text) if text.strip().startswith(("{", "[")) else {"raw": text}
        except Exception as e:  # noqa
            print(f"{now_str()} [{node}] {sub}: payload loi ({e})")
            return

        if sub in ("telemetry", "telemetry/backfill"):
            self.handle_telemetry(node, data, sub.endswith("backfill"))
        elif sub == "heartbeat":
            self.touch(node)
            print(f"{now_str()} [{node}] HB fw={data.get('firmwareVersion')} bc={data.get('bc')} faults={data.get('faults')} "
                  f"bom={data.get('pumpOn')} quat={data.get('fanOn')} lc={data.get('nodeLifecycle')} "
                  f"backlog={data.get('backlogBytes')} rssi={data.get('rssi')}")
        elif sub == "status":
            self.handle_status(node, data)
        elif sub in ("cmd/ack", "command/ack"):
            self.handle_cmd_ack(node, data)
        elif sub == "config/ack":
            code = data.get("deviceCode")
            with self.lock:
                good = data.get("version") == self.version.get(code) and isinstance(data.get("success"), bool)
            print(f"{now_str()} [{node}] CONFIG-ACK {code} v{data.get('version')} success={data.get('success')} "
                  f"{data.get('message', '')}" + ("" if good else "  <-- version khong khop"))
        else:
            print(f"{now_str()} [{node}] {sub}: {text[:160]}  <-- topic NGOAI ACL Backend")

    # ------------------------------------------------------------------ xử lý giống Backend
    def handle_cmd_ack(self, node, data):
        cu = data.get("commandUuid") or data.get("commandId")
        if not cu:
            print(f"{now_str()} [{node}] ACK (Serial/test) {data.get('action')} ok={data.get('ok')} {data.get('message')}")
            return
        with self.lock:
            p = self.pending_cmd.pop(cu, None)
        problems = []
        if p is None:
            problems.append("UUID la/da het han")
        else:
            if p[0] != node:
                problems.append("sai node")
            if data.get("deviceCode") is not None and data.get("deviceCode") != p[1]:
                problems.append("deviceCode sai")
            if time.time() - p[3] > ACK_TIMEOUT:
                problems.append(f"qua {ACK_TIMEOUT}s")
        if not isinstance(data.get("success", data.get("ok")), bool):
            problems.append("success khong phai Boolean")
        print(f"{now_str()} [{node}] ACK {data.get('action')} {data.get('deviceCode')} success={data.get('success')} "
              f"msg={data.get('message')}" + (f"  <-- Backend se TU CHOI: {', '.join(problems)}" if problems else "  (hop le)"))

    def handle_telemetry(self, node, data, backfill_topic):
        vals, bad = [], []
        for k, metric in FLAT.items():
            if k not in data:
                continue
            v = data[k]
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
                bad.append(f"{k}={v}(khong phai so)")
            elif metric != "AIR_TEMPERATURE" and not 0 <= v <= 100:
                bad.append(f"{k}={v}(ngoai 0..100)")
            else:
                vals.append(f"{k}={v}")
        key = (node, data.get("bc"), data.get("seq"))
        dup = data.get("seq") is not None and key in self.seen
        with self.lock:
            if dup:
                self.stats["dup"] += 1
            else:
                self.seen.add(key)
                self.stats["readings"] += len(vals)
                if backfill_topic:
                    self.stats["backfilled"] += len(vals)
        tag = "BACKFILL" if backfill_topic else "TELE"
        warn = ""
        if backfill_topic != (data.get("backfilled") is True):
            warn += "  <-- co backfilled khong khop topic"
        if data.get("ts") is None and not backfill_topic:
            warn += "  (chua co gio NTP, Backend lay bc+up)"
        print(f"{now_str()} [{node}] {tag} seq={data.get('seq')} bc={data.get('bc')} ts={data.get('ts', '-')} "
              f"{', '.join(vals) or '(khong co so do)'}"
              + (f" bom={data.get('pumpOn')} quat={data.get('fanOn')}" if not backfill_topic else "")
              + (f" | TU CHOI: {', '.join(bad)}" if bad else "") + ("  <-- TRUNG (bo)" if dup else "") + warn)

    def handle_status(self, node, data):
        if "event" in data:
            print(f"{now_str()} [{node}] EVENT {data.get('event')} sensor={data.get('sensor', '-')} {data.get('message', '')}")
            return
        if "deviceCode" in data:
            print(f"{now_str()} [{node}] DEVICE {data.get('deviceCode')} -> {data.get('deviceStatus')} {data.get('message', '')}")
            return
        st = data.get("status", data.get("raw"))
        with self.lock:
            n = self.nodes.setdefault(node, {})
            n["online"] = (st == "online")
        print(f"{now_str()} [{node}] NODE -> {str(st).upper()}"
              + (" (LWT do broker phat)" if st == "offline" else
                 f" fw={data.get('firmwareVersion')} reset={data.get('resetReason')}"))

    def auto_setup(self, node):
        time.sleep(3)
        for code in ("PUMP-01", "FAN-01"):                 # Backend: config chỉ gửi cho PUMP/FAN
            self.config(node, code)
            time.sleep(1.5)
        for code in ("SOIL-01", "DHT-01"):                 # Backend gửi lifecycle PROVISIONED cho mọi thiết bị
            self.lifecycle(node, code, "PROVISIONED", need_ack=False)
            time.sleep(1)
        time.sleep(2)
        for code in DEVICES:                               # Admin bấm Kích hoạt từng thiết bị
            self.lifecycle(node, code, "ACTIVE", need_ack=True)
            time.sleep(1.5)
        print(f"{now_str()} [SIM] Da kich hoat 4 thiet bi. Thu: {node} pump PUMP-01 on | {node} fan FAN-01 on")

    # ------------------------------------------------------------------ vòng chạy
    def touch(self, node):
        with self.lock:
            n = self.nodes.setdefault(node, {})
            was = n.get("online")
            n["online"] = True
            n["last_hb"] = time.time()
        if was is not True:
            print(f"{now_str()} [{node}] -> ONLINE (nhan heartbeat)")

    def watchdog(self):
        while True:
            time.sleep(5)
            now = time.time()
            with self.lock:
                for node, n in self.nodes.items():
                    if n.get("online") and now - n.get("last_hb", now) > self.a.offline_after:
                        n["online"] = False
                        print(f"{now_str()} [{node}] -> OFFLINE (qua {self.a.offline_after}s khong co heartbeat)")
                for cu, (node, code, action, t) in list(self.pending_cmd.items()):
                    if now - t > ACK_TIMEOUT:
                        del self.pending_cmd[cu]
                        print(f"{now_str()} [{node}] {action} {code} HET HAN {ACK_TIMEOUT}s khong co ACK")

    def handle_line(self, line):
        p = line.split(maxsplit=3)
        if len(p) < 2:
            return
        node, verb = p[0], p[1].lower()
        try:
            if verb == "active" and len(p) == 3:
                self.lifecycle(node, p[2], "ACTIVE", need_ack=True)
            elif verb == "lc" and len(p) == 4:
                self.lifecycle(node, p[2], p[3], need_ack=False)
            elif verb == "config" and len(p) == 3:
                self.config(node, p[2])
            elif verb in ("pump", "fan") and len(p) == 4 and p[3].lower() in ("on", "off"):
                self.actuator(node, p[2], p[3].lower() == "on")
            elif verb == "cmd" and len(p) >= 3:
                self.pub(node, json.loads(line.split(maxsplit=2)[2]))
            else:
                print("Lenh: <node> active <code> | lc <code> <LIFECYCLE> | config <code> | "
                      "pump <code> on|off | fan <code> on|off | cmd <json>")
        except json.JSONDecodeError as e:
            print(f"JSON loi: {e}")

    def run(self):
        threading.Thread(target=self.watchdog, daemon=True).start()
        self.c.connect(self.a.host, self.a.port, keepalive=30)
        print("Ctrl+C de dung. Vi du: NODE-01 active PUMP-01 | NODE-01 pump PUMP-01 on | NODE-01 fan FAN-01 on")
        self.c.loop_start()
        try:
            for line in sys.stdin:
                if line.strip():
                    self.handle_line(line.strip())
        except KeyboardInterrupt:
            pass
        finally:
            s = self.stats
            print(f"\nTong ket: {s['readings']} so do hop le ({s['backfilled']} gui bu), "
                  f"{s['dup']} ban tin trung")
            self.c.loop_stop()


def main():
    p = argparse.ArgumentParser(description="Gia lap Backend (giao thuc sf/, Backend 02/11/2026) de test firmware")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("-u", "--user", default="admin")
    p.add_argument("-P", "--password", default="")
    p.add_argument("--client-id", default="sim-backend")
    p.add_argument("--setup", metavar="NODE", help="tu cau hinh + kich hoat 4 thiet bi cua node telemetry nay")
    p.add_argument("--offline-after", type=int, default=60, help="giay khong co heartbeat -> Offline (Backend: 60)")
    SimBackend(p.parse_args()).run()


if __name__ == "__main__":
    main()
