# ESP32 soil/DHT11/pump node

**Arduino IDE users:** use the separate sketch and upload instructions in
[`arduino/README.md`](arduino/README.md). This page documents the original
ESP-IDF build; its `idf.py`/`tools/provision.py` commands do not apply to the
Arduino sketch. Both implementations use the same Backend MQTT topics and
payload schema.

**New Node registration:** the MAC + one-time token claim workflow and full
device lifecycle are in [`../Backend/docs/DEVICE_CLAIM_LIFECYCLE.md`](../Backend/docs/DEVICE_CLAIM_LIFECYCLE.md).
The claim tool targets Arduino only; the ESP-IDF workflow below retains its
manual provisioning and is not a token-claim client.

This ESP-IDF application targets an **ESP32-WROOM-32 development board with at least
4 MB flash**, a DHT11, an analog soil sensor, and a 5 V relay controlling a 12 V DC
pump. It implements the backend's `sf/{nodeCode}` contract. The phone/AI publisher
is a separate application, not firmware running on this ESP32.

## 1. Wiring and electrical checks

| Part | ESP32 / supply |
| --- | --- |
| DHT11 module DATA, VCC, GND | GPIO4, 3V3, GND |
| Soil module AO, VCC, GND | GPIO34 (ADC1), 3V3, GND |
| Soil module DO | Optional GPIO35 input; this firmware does **not** read DO |
| 5 V relay module IN, DC+, DC- | GPIO26, regulated 5 V, common GND |
| Pump 12 V negative | 12 V supply negative |
| Pump 12 V positive | Relay NO; relay COM from fused 12 V positive |
| ESP32 VIN/5V | Regulated 5 V from a buck converter, **not raw 12 V** |

**Before connecting the board:** measure the buck's 5 V output, check the
development board's VIN/5V rating and relay coil/trigger rating, use a fuse
appropriate for the motor, and add a flyback diode across the DC motor
(cathode on motor positive). Use a relay whose *DC* contact rating exceeds the
motor's startup current. Disconnect the pump for initial testing. Most relay
modules are active LOW; `PUMP_ON_LEVEL` in `main/main.c` defaults to `0`.
Add an external pull-up on the relay input for an active-LOW relay (or a
pull-down for active-HIGH) so it cannot turn on while GPIO26 is high impedance
during ESP32 reset. Verify that the relay is OFF at power-on and at both output levels before
connecting the pump. A resistive soil probe corrodes in wet soil; calibrate it
at the actual supply voltage and consider a capacitive probe for long use.

## 2. Backend inventory and broker

1. Set up Backend/MySQL/Mosquitto Dynamic Security and a **TLS listener**
   accessible from the ESP32. Mosquitto's account/ACL setup is in
   `Backend/docs/mosquitto-acl.example`. The default `mqtt://localhost:1883`
   cannot be used from the ESP32; configure a reachable `mqtts://HOST:8883`
   broker URL with a certificate whose hostname matches `HOST`. A public CA is
   covered by the ESP-IDF bundle; for a private CA, supply its PEM certificate
   at provision time. Do not disable TLS verification.
2. As Admin create **one Node**. Record the returned `NODE-...`, its one-time
   username/password, and the exact MQTT topic prefix (usually `sf`).
3. Create three child Devices assigned to that Node: soil `SENSOR`, GPIO34,
   metric `SOIL_MOISTURE`; DHT11 `SENSOR`, GPIO4, metrics `AIR_TEMPERATURE` and
   `AIR_HUMIDITY`; pump `PUMP`, GPIO26. Record each backend-generated `DEV-...`.
   Assign a user to each and transition each to `PROVISIONED`. Sensor metrics
   are configured on the backend; the ESP32 binds their actual `deviceCode`
   in its NVS partition.
4. The backend account is distinct from each Node's MQTT account. Each Node
   should only publish its own topics and subscribe to its own `/cmd` topic.

## 3. Compile, flash, provision

Install ESP-IDF **5.3 or newer** with ESP32 support and a USB serial driver.
The project uses ESP-IDF's own MQTT, JSON, NVS, ADC and TLS components; it does
not require Arduino or third-party firmware libraries. From the repository root:

```sh
. "$HOME/esp/esp-idf/export.sh"       # replace with the actual ESP-IDF path
cd firmware
idf.py set-target esp32
idf.py build
idf.py -p /dev/ttyUSB0 flash
python3 tools/provision.py --port /dev/ttyUSB0 \
  --node-code NODE-0123456789ABCDEF \
  --soil-code DEV-0000000000000001 \
  --dht-code DEV-0000000000000002 \
  --pump-code DEV-0000000000000003 \
  --wifi-ssid 'YOUR_2G_WIFI' \
  --broker mqtts://broker.example.org:8883 --mqtt-user node_example \
  --soil-dry 3000 --soil-wet 1000 --ca-cert /path/to/broker-ca.pem
idf.py -p /dev/ttyUSB0 monitor
```

Replace **all** example codes, host, account, ADC values and CA path with real
ones. Omit `--ca-cert` only if the broker uses a public trusted CA. The script
prompts separately for Wi-Fi and MQTT passwords: do **not** pass them in shell
arguments, paste them into a tracked file, or share the generated NVS image.
Provisioning flashes the NVS partition at `0x9000`, erasing prior runtime state
and credentials; it does not overwrite the app. Keep the board disconnected
from the 12 V motor power when flashing. The temporary plaintext CSV/image
is stored in a private temp directory and removed when the script exits.
For a deliberate export, `--generate-only /secure/path/node-nvs.bin` produces
an image containing plaintext secrets; protect/delete it after use. Re-running
`idf.py flash` updates the app without replacing NVS; `idf.py erase-flash`
**does** delete its credentials and requires reprovisioning. Reprovision after
revoking/reissuing the Node password.

### Calibration

Read `soil adc=<raw> percent=<value>` in `idf.py monitor` with the probe in
known dry and wet conditions; re-run provisioning with those raw values as
`--soil-dry`/`--soil-wet`. The formula clamps to 0-100%; thresholds are only
useful after field calibration. Neither the diagram nor this repo supplies
valid calibration values. Provisioning overwrites runtime NVS, so Admin must
reconcile and re-activate the Devices afterward.

## 4. Topic/payload contract

The board publishes QoS 1, non-retained messages to `sf/{nodeCode}/telemetry`,
`telemetry/backfill`, `heartbeat`, `status`, `cmd/ack`, `config/ack`; subscribes
to `sf/{nodeCode}/cmd` at QoS 1. `status` has `online` and LWT `offline`.
Heartbeat every 20 seconds includes `firmwareVersion`, boot counter `bc`,
uptime `up` (milliseconds), `faults`, and RAM-backlog `dropped` count. Telemetry
every 20 seconds uses root `seq` and `bc`, timestamp `ts` (Unix milliseconds
when SNTP synchronized; `0` otherwise), `up`, `pumpOn`, plus `readings[]` with
the exact child `deviceCode`, `metric` and `value`:

```json
{"seq":105,"bc":3,"up":120000,"ts":1793600000000,"pumpOn":false,"readings":[{"deviceCode":"DEV-0000000000000001","metric":"SOIL_MOISTURE","value":28},{"deviceCode":"DEV-0000000000000002","metric":"AIR_TEMPERATURE","value":32},{"deviceCode":"DEV-0000000000000002","metric":"AIR_HUMIDITY","value":86}]}
```

The board accepts only commands for bound codes and matching `type`/`gpioPin`.
`action:config` for PUMP must contain version, `pumpAutoEnabled`, `soilOnPct`,
`soilOffPct`, `pumpMaxRunSec`, `pumpCooldownSec`; valid config is saved to NVS
before `config/ack` with `success:true`. Defaults cap pump runtime at 30 seconds
and enforce >=60 seconds cooldown. `action:lifecycle` `ACTIVE` requires fresh
valid sensor readings (and active soil sensor for pump); it returns a UUID
`cmd/ack`. Other lifecycle notifications turn affected outputs OFF. `action:pump`
requires `on` Boolean and optionally `seconds` (defaults to 10); turning OFF
always works for a correctly addressed pump, even when inactive. Every valid
UUID gets a Boolean ACK; a replay of the most recent UUID returns its recorded
result without performing the action twice. Local automatic watering uses
soil hysteresis only while soil + pump are active and MQTT is connected.

On boot or Wi-Fi/MQTT disconnect, the relay is OFF and **all child Devices start
inactive**. This is a fail-closed choice: after a reboot/outage an Admin must
transition the backend's Device lifecycle through a permitted inactive state,
then re-activate sensors and pump. The backend does not automatically re-send
`ACTIVE` on reconnect. The Backend may still show `ACTIVE` until an Admin
reconciles the lifecycle, so its displayed state is not proof of physical
activation. During an MQTT/Wi-Fi outage the relay turns OFF;
up to 32 recent telemetry samples are queued in RAM, sent on `/backfill` after
reconnect, and lost on power loss. Backend automation does not act on backfill.
This deliberately differs from the older v1.2 note about offline watering:
without a water-level/flow sensor, offline pumping is not fail-safe.

## 5. Physical acceptance tests

1. With motor power disconnected, boot without provisioning: relay stays OFF.
   Provision, then verify Node Online and `firmwareVersion` on the backend.
2. Register/PROVISION three Devices. Verify soil and DHT11 readings, units
   (`%`, `deg C`, `%`), timestamp, and invalid-sensor `faults`/status events.
3. Verify backend config version ACK. Activate **soil SENSOR first**, DHT11
   next, pump last. Test pump ON/OFF from UI with a lamp or meter in place of
   the motor, confirming UUID ACK and history. If auto mode is enabled, test
   35% ON / 60% OFF hysteresis and max runtime/cooldown.
4. Disconnect Wi-Fi and power cycle: relay stays OFF. Reconnect and verify
   backfill doesn't trigger historical alerts. Test duplicate QoS command and
   rejected wrong-device command against a test broker/ACL.
5. Revoke Node in Admin; broker must reject it. Verify OFF on disconnect and
   no accepted telemetry. Restore, reprovision credentials if rotated, and
   complete Admin re-activation. Only then connect the 12 V motor and repeat
   tests with a supervised water source, fuse and dry-run precautions.

Unit checks without a board:

```sh
gcc -std=c11 -Wall -Wextra -Werror -I main main/logic.c tests/logic_test.c -o /tmp/iot-firmware-test
/tmp/iot-firmware-test
python3 -m unittest discover -s tests -v
```

**Limits:** No OTA pipeline, camera/phone MQTT node, persistent offline queue,
flow/current sensor or proven dry-run detection is included. The pump is
stopped if soil readings fail, but a valid soil reading does **not** prove water
is available; do not run unattended without a physical water/flow interlock.
Credentials in ordinary NVS can be read by someone with physical flash access;
for a production device, enable flash/NVS encryption and secure boot with a
board-specific key management process. Firmware must be built and tested on
your actual board before it can be claimed as a working hardware demo.
