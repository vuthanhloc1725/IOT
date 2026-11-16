# ESP32 firmware for Arduino IDE

Open [`SoilPumpNode/SoilPumpNode.ino`](SoilPumpNode/SoilPumpNode.ino) with Arduino IDE.
This is a separate implementation of the same Backend MQTT contract as the
ESP-IDF application in `firmware/main/`. **Do not rename an ESP-IDF `.c` file to
`.ino`, or use `firmware/tools/provision.py` with this Arduino sketch.** The
Arduino build takes per-board identity/credentials from `device_config.h` and
uses Arduino `Preferences` only for runtime state. New boards use
[`claim_and_flash.py`](claim_and_flash.py) to create this private file after
one-time MAC + token claim. The [lifecycle guide](../../Backend/docs/DEVICE_CLAIM_LIFECYCLE.md)
describes registration through revocation.

## 1. Prepare the Backend and board

Use an ESP32-WROOM-32 development board (at least 4 MB flash), a **2.4 GHz**
Wi-Fi network, and a broker reachable over TLS on port 8883. `localhost` on
the Backend is not the address the ESP32 should use. The MQTT certificate must
match the hostname set in `MQTT_HOST`; obtain the PEM of the issuing CA. The
sketch never uses `setInsecure()`.

As Admin, create a Node with the board's Wi-Fi STA MAC read from USB; Backend
generates a `NODE-<16 hex>` code and shows a one-time 30-minute claim token.
Create three child Devices on that Node; Backend generates their different
`DEV-<16 hex>` codes:

| Device | Backend type / metric | GPIO |
| --- | --- | --- |
| Soil moisture | `SENSOR` / `SOIL_MOISTURE` | 34 (analog AO, ADC1) |
| DHT11 | `SENSOR` / `AIR_TEMPERATURE`, `AIR_HUMIDITY` | 4 |
| 12 V pump relay | `PUMP` | 26 |

After claim, upload, and hardware checks, set Devices to `PROVISIONED`.
Wire the sensors at 3.3 V with common GND. Use a
regulated 5 V buck for ESP32 VIN and relay supply; **never feed raw 12 V into
ESP32 VIN**. The pump must have its own fused 12 V supply. Check relay voltage,
trigger polarity, DC contact/startup current, flyback protection and an
external relay-input pull-up (active LOW) or pull-down (active HIGH) while
the ESP32 resets. Keep the pump power disconnected for initial tests. See
[`../README.md`](../README.md) for a wiring table and electrical checks.

## 2. Prepare Arduino IDE

1. Install the ESP32 board package **esp32 by Espressif Systems** using Boards
   Manager. Select your actual ESP32 board, USB port, and a partition scheme
   with an `nvs` partition (the default 4 MB scheme works). Install these
   libraries with Library Manager: **ArduinoJson 7**, **MQTT by Joel Gaehwiler
   (256dpi)**, **DHT sensor library by Adafruit**, and its dependency
   **Adafruit Unified Sensor**. The code uses the Arduino-ESP32 3.x APIs.
2. Install `esptool` (`python3 -m pip install esptool`) on the USB workstation.
   Run the tool below. It reads the MAC from the board, prompts privately for
   the token and Wi-Fi password, claims over verified HTTPS by default, checks child
   GPIO/metrics, and writes `device_config.h` with permissions 0600. Add
   `--upload` to compile/upload using `arduino-cli` (with the same core and
   libraries installed), or omit it and Upload in Arduino IDE.

   ```sh
   python3 firmware/arduino/claim_and_flash.py \
     --port /dev/ttyUSB0 --api https://api.example.org \
     --wifi-ssid YOUR_2G_SSID --broker-ca /path/to/broker-ca.pem \
     --dry-adc 3000 --wet-adc 1000
   ```

   For a Backend running on the USB workstation, use
   `--api http://127.0.0.1:3000 --allow-local-http` (or the literal IPv6
   loopback `http://[::1]:3000`). This explicit option permits HTTP only to
   these loopback addresses; LAN addresses and hostnames such as `localhost`
   are rejected. Local HTTP bypasses proxies, and claim requests reject
   redirects. Supply the origin without `/api`. MQTT still requires
   `mqtts://` and a valid broker CA.

   The ADC numbers above are **examples**, not measurements. Set `--ntp` to
   a reachable server when the default is unavailable; TLS needs a correct
   clock. Use `--relay-active-high` only after checking relay polarity with
   motor power disconnected. The tool refuses to overwrite an existing
   `device_config.h`; archive it privately before provisioning another board.
   The file is gitignored but contains secrets, as does the compiled image.
   Claim reserves and consumes the token before broker provisioning completes,
   including when a broker error follows. If cleanup fails or its outcome is
   unknown, Admin must inspect/remove the broker client and role, then use
   `/api/nodes/:id/claim-reconcile` before reissuing a token. A successful
   claim also consumes the token even if Upload subsequently fails. See the
   lifecycle guide for recovery; never turn off TLS validation.
3. Open `SoilPumpNode.ino`, choose **Sketch > Verify/Compile**, then **Upload**.
   If replacing the ESP-IDF image, choose an all-flash erase once in the
   ESP32 Tools menu (if your board package provides that option) to clear
   old partition/runtime state, then restore the normal upload setting.
   **Erasing flash deletes all saved runtime policy and requires Backend
   configuration/activation again.** A normal sketch upload should retain
   `Preferences` data when partition layout is unchanged.
4. Open Serial Monitor at 115200 baud. Check Wi-Fi, NTP and verified MQTT/TLS
   connection. You should see `soil adc=... percent=...`; calibrate and upload
   again. A placeholder or missing configuration keeps the relay OFF. The
   sketch does not need an ESP-IDF NVS provisioning step. It prints MAC and
   Node code on boot and refuses MQTT on MAC mismatch. This is an operational
   guard, not cryptographic proof of board identity.

Do **not** activate the pump merely because the Node is Online. Send the pump
policy configuration from Backend, confirm `config/ack`, then activate soil
SENSOR, DHT11 SENSOR, and lastly PUMP through Backend. The activation of each
child must receive its correlated `cmd/ack` before it is considered ACTIVE.
After any reboot, loss of Wi-Fi/MQTT, or firmware replacement, the relay is
OFF and child activation flags are cleared. The Backend may still display an
old ACTIVE lifecycle; an Admin must move each affected Device to a permitted
inactive state, then reactivate in the same order.

## MQTT topics and payloads

With `MQTT_TOPIC_PREFIX=sf`, the board subscribes QoS 1 to
`sf/{nodeCode}/cmd` and publishes QoS 1, non-retained messages to:

| Suffix | Payload |
| --- | --- |
| `telemetry` | `{seq,bc,up,ts,pumpOn,readings:[{deviceCode,metric,value}]}` |
| `telemetry/backfill` | Same sample JSON, replayed from a 32-entry RAM queue |
| `heartbeat` | `{firmwareVersion,bc,up,dropped,faults}` |
| `status` | `online`, `offline` LWT, or `{event,sensor,message}` |
| `cmd/ack` | `{commandUuid,deviceCode,success,message}` |
| `config/ack` | `{deviceCode,version,success}` |

`ts` is Unix milliseconds after NTP sync, otherwise `0`; `up` is milliseconds
since boot. The `readings` metrics are `SOIL_MOISTURE`, `AIR_TEMPERATURE` and
`AIR_HUMIDITY`, tied to their bound child codes. No sensor reading is emitted
for a failed sensor; heartbeat lists `soil`/`dht11` faults. The Backend may
have older topic aliases, but the sketch intentionally uses the current `/cmd`
and ACK topics. The phone camera/MQTT image publisher is **a separate Node
application**, not part of the ESP32 sketch.

For pump commands, `action:"pump"` requires the bound pump code, `type:"PUMP"`,
`gpioPin:26`, a 36-character `commandUuid` (or `commandId`) and Boolean `on`.
An optional integer `seconds` defaults to 10; ON is rejected without an active
soil sensor and pump, valid soil reading, online MQTT, or if max-run/cooldown
rules fail. OFF remains available for a correctly addressed pump. Config
accepts `action:"config"` with the bound pump identity, positive `version`,
and five typed fields in `config`: `pumpAutoEnabled`, `soilOnPct`, `soilOffPct`,
`pumpMaxRunSec`, `pumpCooldownSec`. Policy bounds are `0 <= on < off <= 100`,
`1..30` seconds maximum run and `60..3600` seconds cooldown. It is stored in
NVS before a successful ACK. Automatic watering uses hysteresis only while
both soil and pump are active and MQTT stays connected.

Lifecycle `action:"lifecycle"`, `lifecycle:"ACTIVE"` checks code/type/GPIO,
current sensor health and (for pump) an applied configuration and active soil
sensor. Inactive states turn affected outputs OFF. Duplicated pump command
UUIDs are not executed twice (16 recent results in RAM, most recent also in
NVS). When a repeated ON is no longer running, the board ACKs failure rather
than claiming the pump is still ON.

## Physical checks before connecting the pump

1. Boot without valid configuration and verify the relay is OFF. Correct the
   configuration, assign a manager and set Devices to `PROVISIONED`; then
   confirm `online`, heartbeat and expected stored telemetry in Backend and
   the serial monitor. Ingest skips readings from REGISTERED Devices.
2. Verify config ACK and the soil/DHT11/pump activation order. Test ON/OFF
   with a lamp or meter, including command UUID ACKs, time limit and cooldown.
3. Remove the soil sensor, unplug Wi-Fi, and restart the ESP32 separately;
   verify the relay turns OFF in each case. Test delayed backfill and that it
   does not trigger historical automation. Reconcile Backend lifecycle.
4. Revoke the Node account and verify the broker rejects it. Only after these
   tests should you connect the fused 12 V motor supply for supervised trials.

There is no OTA, persistent offline queue, water-level/flow interlock or
dry-run protection. A soil reading cannot prove the pump has water available.
Keep the motor supervised until physical interlocks are added. Secrets in a
normal ESP32 firmware image/NVS are readable with physical access; production
requires secure boot/flash encryption and board-specific key management.
