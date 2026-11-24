# Quy trinh vong doi Node ESP32 (MAC + claim token)

## 0. Ranh gioi danh tinh

- `macAddress`: MAC Wi-Fi STA doc tu bo ESP32, ghi nhan de doi chieu bo vat ly. MAC co the bi gia mao, **khong phai mat khau**.
- `nodeCode`: `NODE-<16 HEX>` do Backend sinh, xac dinh namespace MQTT `sf/{nodeCode}/...`.
- `deviceCode`: `DEV-<16 HEX>` cho moi linh kien vat ly, duoc gan vao Node qua `nodeId`.
- `claimToken`: 32 byte ngau nhien, chi hien mot lan, het han sau 30 phut; DB chi luu SHA-256. Dung **mot lan** tai tram nap co ESP32 cam USB.
- MQTT username/password: chi cap sau claim thanh cong; mot tai khoan/ACL gioi han topic cho mot Node. Khong co credential rieng cho tung cam bien.

Node tao khong co `macAddress` van dung flow cu (cap MQTT ngay) de tuong thich; Web Admin moi bat buoc MAC. Khong co API de tu y thay MAC cua Node da tao. Doi bo: thu hoi Node cu, cap Node va token moi, cap nhat Device theo quy trinh bao tri; khong sao chep credential sang bo moi.

## 1. Lap rap va kiem tra

Lap ESP32, soil AO GPIO34, DHT11 GPIO4, relay GPIO26. Do MAC Wi-Fi STA cua bo qua USB/Serial; khong lay MAC BLE. Ghi tem `MAC / vi tri / hardware version`. Kiem tra nguon 5 V va relay khi **chua noi nguon 12 V cua bom**.

## 2. Dang ky (REGISTERED)

Admin tao Node trong Web Admin voi MAC; `POST /api/nodes` sinh `nodeCode` va token, **chua co MQTT account**. Token chi hien thi mot lan; khong ghi vao Git/chat/log. Node chua online. Tao ba Device cung `nodeId` qua `POST /api/devices`:

| Loai | GPIO | Metrics |
| --- | ---: | --- |
| SENSOR dat | 34 | SOIL_MOISTURE |
| SENSOR DHT11 | 4 | AIR_TEMPERATURE, AIR_HUMIDITY |
| PUMP relay | 26 | - |

Backend sinh `deviceCode` va Device bat dau o `REGISTERED`. Cap token moi: `POST /api/nodes/:id/claim-token` (token cu vo hieu). Chap nhan Node o trang thai chua co token, token het han, claim ket (`CLAIM_STUCK`) va **da thu hoi**. Node da claim can body `{"reprovision": true}` (neu thieu -> 409 `REPROVISION_CONFIRM_REQUIRED`): Backend xoa tai khoan MQTT cu va dua Node ve `AWAITING_CLAIM`. Phan hoi: `{data, claimToken, previousState, brokerPurged}`. Loi khac: 409 `CLAIM_IN_PROGRESS`, 409 `NODE_HAS_NO_MAC`, 503 `BROKER_UNAVAILABLE`.

## 3. Claim (Node CLAIMED, Device van REGISTERED)

Co hai cach claim, cung goi `POST /api/provisioning/claim` voi `{macAddress, claimToken}`:

1. **ESP32 tu claim (firmware node_telemetry >= v1.5.0, khuyen dung).** Nap firmware mot lan. Luc boot Serial in `MAC (khai bao khi tao Node tren web)`; MAC nay phai trung MAC da khai bao. Nhap `Backend URL` + `Claim token` o cong cau hinh WiFi (AP `SF-TELE-xxxx`) hoac go `api http://<ip>:3000` va `claim <token>` tren Serial. Task mang goi API, luu nodeCode + MQTT user/pass vao NVS, xoa token va ket noi broker. Khong can sua code, khong can xoa Flash.
2. **Tram nap USB** `firmware/arduino/claim_and_flash.py` (sinh `device_config.h` roi nap). HTTPS theo mac dinh; `--api http://127.0.0.1:3000 --allow-local-http` chi cho loopback.

Backend kiem tra MAC, token con han, Node chua thu hoi va du ba Device (SOIL GPIO34, DHT GPIO4, PUMP GPIO26), khoa dong Node, tao client/role Dynamic Security va tra `{nodeCode, macAddress, mqttCredentials:{brokerUrl,host,port,tls,topicPrefix,nodeCode,username,password}, devices, replay}`. Backend khong luu plaintext MQTT password.

**Replay an toan:** gui lai **cung token** trong 10 phut sau claim thanh cong (vi du ESP32 mat response) -> Backend xoay mat khau va tra credential moi voi `replay: true`, khong bao 409. Qua 10 phut -> `CLAIM_TOKEN_USED`, cap token moi.

**Claim ket giua chung:** neu claim dang xu ly qua 60 giay (`CLAIM_STUCK`), Admin cap token moi duoc ngay; Backend tu xoa client/role cu tren broker (idempotent, "khong ton tai" coi la da sach). Khong con buoc doi soat thu cong 5 phut. `POST /api/nodes/:id/claim-reconcile` van con (idempotent) cho truong hop muon don broker ma chua cap token.

| Ma loi | HTTP | Y nghia / cach xu ly |
| --- | ---: | --- |
| `CLAIM_BAD_REQUEST` | 400 | Body sai dinh dang (MAC/token) |
| `CLAIM_INVALID` | 403 | MAC hoac token khong khop -> kiem tra MAC in luc boot, token copy du 43 ky tu |
| `CLAIM_TOKEN_EXPIRED` | 403 | Token qua 30 phut -> cap token moi |
| `NODE_REVOKED` | 403 | Node da thu hoi -> cap token moi (tu dong mo lai) hoac Khoi phuc |
| `INSECURE_TRANSPORT` | 403 | `CLAIM_REQUIRE_TLS=true` nhung request khong qua HTTPS |
| `CLAIM_IN_PROGRESS` | 409 | Claim khac dang chay; `details.retryAfterSec` cho biet thoi gian cho |
| `NODE_ALREADY_CLAIMED` | 409 | Da claim bang token khac -> web "Cap lai claim token" (reprovision) |
| `CLAIM_TOKEN_USED` | 409 | Token da dung va het cua so replay -> cap token moi |
| `INVENTORY_MISMATCH` | 409 | Thieu/sai Device; `details.problems` liet ke |
| `CLAIM_SUPERSEDED` | 409 | Trang thai Node doi trong luc claim (bi thu hoi/cap token khac) |
| `BROKER_TLS_REQUIRED` | 503 | `CLAIM_REQUIRE_TLS=true` nhung `MQTT_DEVICE_URL` khong phai `mqtts://` |
| `BROKER_UNAVAILABLE` | 503 | Broker/Dynamic Security loi -> sua broker, thu lai (token van giu) |

Rate limit 10 request/15 phut/IP; 429 kem `Retry-After`.

**Bien moi truong:** `MQTT_DEVICE_URL` (URL broker tra cho ESP32, mac dinh = `MQTT_URL`; dat IP LAN thay vi `localhost`), `CLAIM_REQUIRE_TLS` (mac dinh `true` khi production, `false` khi dev), `CLAIM_TRUSTED_PROXY_IPS`.

Tai Serial Monitor 115200, so MAC/Node in ra voi Web Admin; firmware khong ket noi MQTT neu MAC khong khop config. Sau khi Backend nhan mot tin MQTT duoc chap nhan (vi du `status: online` hoac heartbeat), Node moi online; heartbeat het han se chuyen offline. Admin gan nguoi quan ly va chuyen Device sang `PROVISIONED` theo quy tac lifecycle, **truoc khi doi telemetry duoc luu** (Backend bo qua so do cua Device con REGISTERED). Kiem tra telemetry va ACK sau do. `claimedAt`, firmware da nap, Node online va Device PROVISIONED/ACTIVE la nhung su kien khac nhau.

## 4. Kich hoat va van hanh (ACTIVE)

Day config bom qua Backend, doi `config/ack`, kiem tra cam bien va kich hoat soil, DHT11, cuoi cung la pump bang lifecycle command; moi ACTIVE can `cmd/ack` tu firmware. Test relay voi tai gia truoc khi noi bom 12 V. Telemetry va backfill van dung **nguyen** `sf/{nodeCode}/telemetry` va `sf/{nodeCode}/telemetry/backfill`, envelope `{seq,bc,up,ts,pumpOn,readings:[{deviceCode,metric,value}]}`. Heartbeat, status/LWT, `cmd/ack`, `config/ack` van theo hop dong hien co trong Arduino README. Dien thoai gui anh la producer rieng, khong tham gia claim ESP32 nay.

## 5. Bao tri, loi va thu hoi

- Mang mat/ESP32 reboot: relay fail-closed OFF, Device activation tren firmware bi xoa; Admin doi soat lifecycle va kich hoat lai. Heartbeat het han thi Node offline; khong dung MAC de ket luan online.
- Bao tri/FAULT: vo hieu dieu khien bom, chan chap nhan thiet bi loi, kiem tra nguon, sensor, relay, calib ADC va MQTT ACL. Doi firmware bang Arduino IDE/CLI qua USB; OTA **chua trien khai**.
- Doi password MQTT: `POST /api/nodes/:id/mqtt-credentials` xoay mat khau; ESP32 phai nhap mat khau moi. Cach gon hon cho firmware v1.5: "Cap lai claim token" (reprovision) roi nhap token vao ESP32 - Node tu nhan credential moi. Sau khi broker tu choi user/pass lien tiep, firmware tu mo cong cau hinh (khong xoa cau hinh).
- Thu hoi: `POST /api/nodes/:id/revoke` tat va ngat MQTT client, huy token chua dung (idempotent, broker bao "Client not found" van coi la thanh cong). Khong tai su dung NodeCode/DeviceCode cho bo khac.
- Sau thu hoi co hai lua chon:
  - **Cap claim token moi** (khuyen dung, nhat la khi nghi credential lo): xoa sach tai khoan cu tren broker, ESP32 claim lai bang token moi.
  - **Khoi phuc** `POST /api/nodes/:id/restore`: Node con tai khoan -> bat lai credential cu; Node co MAC nhung chua co tai khoan -> tra claim token moi; Node legacy khong MAC -> cap credential moi.

**Gioi han an ninh:** Claim token xac minh quyen claim tren tram nap, khong phai attestation cua silicon. Neu ai sao chep duoc firmware/config chua ma hoa, ho co the lay MQTT credential. MAC-check trong sketch la chot van hanh, khong ngan duoc nguoi tan cong sua firmware. San pham that can secure boot + flash encryption, identity khoa rieng/certificate per device, quyen ACL chi theo topic, TLS va quy trinh rotate/revoke. Token khong duoc gui qua MQTT topic.

**Chua nghiem thu production:** Phan hoi Dynamic Security den muon/chong lenh, race claim voi revoke va doi soat broker can test voi Mosquitto that; test mock khong chung minh duoc cac tinh huong nay. OTA va hardware attestation chua co. Khong dung ket qua claim/Serial nhu chung nhan firmware da nap dung hoac board khong bi gia mao.
