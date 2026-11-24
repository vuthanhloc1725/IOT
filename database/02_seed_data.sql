-- ============================================================================
-- IoT Smart Agriculture - du lieu demo idempotent cho schema 01
-- Mat khau tai khoan demo: xem deployment/README.md (BCrypt cost 12).
-- Node + Device demo CHUA duoc claim/online; MAC cua Node la placeholder.
-- Reading duoc danh dau isBackfilled=1, khong phat sinh automation/canh bao nguong.
-- ============================================================================

USE `iot`;
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

START TRANSACTION;

-- 1. Tai khoan Admin / Operator / Viewer. INSERT IGNORE khong ghi de mat khau
-- neu nguoi dung da doi password hoac thay doi thong tin tai khoan.
INSERT IGNORE INTO `users`
  (`username`, `email`, `passwordHash`, `fullName`, `role`, `isActive`, `createdAt`)
VALUES
  ('admin', 'admin@iot.local', '$2b$12$08ccDKkYe6ImheKRpaCJSO7JVJ.caSgGvQIJpHwoWzkCl84voG16m', 'System Administrator', 'admin', 1, CURRENT_TIMESTAMP(3)),
  ('operator', 'operator@iot.local', '$2b$12$I4xYMtYYFut5DyAryaLmTei/jyfz3wIzykCy/sJwhrdayIrTNTwkG', 'Demo Operator', 'operator', 1, CURRENT_TIMESTAMP(3)),
  ('viewer', 'viewer@iot.local', '$2b$12$9EAJmuujPxvcZWrBOmnWXu82n3JpfxKO8/MErQwu23u8LClXv/7.6', 'Demo Viewer', 'viewer', 1, CURRENT_TIMESTAMP(3));

SET @demo_admin_id := (SELECT `id` FROM `users` WHERE `username` = 'admin' LIMIT 1);
SET @demo_operator_id := (SELECT `id` FROM `users` WHERE `username` = 'operator' LIMIT 1);
SET @demo_viewer_id := (SELECT `id` FROM `users` WHERE `username` = 'viewer' LIMIT 1);

-- 2. Node demo o trang thai NO_TOKEN: chua co hash/expiry, MQTT account, heartbeat
-- hoac trang thai ONLINE. MAC 02:00:00:00:00:01 chi la MAC mau, KHONG phai ESP32 that.
INSERT IGNORE INTO `nodes`
  (`nodeCode`, `name`, `firmwareVersion`, `hardwareVersion`, `isOnline`, `onlineSince`, `lastHeartbeatAt`,
   `heartbeatTimeoutSec`, `isRevoked`, `mqttUsername`, `mqttRoleName`, `mqttProvisionedAt`,
   `mqttAccountEnabled`, `macAddress`, `claimTokenHash`, `claimTokenExpiresAt`, `claimConsumedAt`,
   `claimFailedAt`, `claimedAt`, `revokedAt`, `createdAt`)
VALUES
  ('NODE-DEMO-001', 'Node demo - chua claim', NULL, NULL, 0, NULL, NULL,
   60, 0, NULL, NULL, NULL, 0, '02:00:00:00:00:01', NULL, NULL, NULL,
   NULL, NULL, NULL, CURRENT_TIMESTAMP(3));

SET @demo_node_id := (SELECT `id` FROM `nodes` WHERE `nodeCode` = 'NODE-DEMO-001' LIMIT 1);

-- 3. Inventory demo khop firmware node_telemetry: soil GPIO34, DHT GPIO4,
-- pump GPIO26 va fan GPIO27 (FAN la slot tuy chon). Cac thiet bi deu REGISTERED va chua duoc
-- xac minh phan cung/claim; config.metrics duoc dung boi validate inventory khi claim.
INSERT IGNORE INTO `devices`
  (`deviceCode`, `name`, `type`, `location`, `nodeId`, `gpioPin`,
   `presenceVerifiedAt`, `readinessVerifiedAt`, `readinessType`, `lifecycleChangedAt`,
   `pendingLifecycleCommandUuid`, `pendingLifecycleCommandTo`, `pendingLifecycleCommandSentAt`,
   `lifecycle`, `isOn`, `stateChangedAt`, `config`, `configVersion`, `configAppliedVersion`, `createdAt`)
VALUES
  ('DEV-DEMO-SOIL-001', 'Cam bien do am dat (demo)', 'SENSOR', 'Khu demo', @demo_node_id, 34,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   'REGISTERED', 0, NULL, JSON_OBJECT('metrics', JSON_ARRAY('SOIL_MOISTURE')), 0, 0, CURRENT_TIMESTAMP(3)),
  ('DEV-DEMO-DHT-001', 'Cam bien DHT11 (demo)', 'SENSOR', 'Khu demo', @demo_node_id, 4,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   'REGISTERED', 0, NULL, JSON_OBJECT('metrics', JSON_ARRAY('AIR_TEMPERATURE', 'AIR_HUMIDITY')), 0, 0, CURRENT_TIMESTAMP(3)),
  ('DEV-DEMO-PUMP-001', 'May bom (demo)', 'PUMP', 'Khu demo', @demo_node_id, 26,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   'REGISTERED', 0, NULL, CAST('{"localAutomation":true,"auto":{"enabled":true,"metric":"SOIL_MOISTURE","onOp":"lt","onValue":35,"offOp":"gte","offValue":60}}' AS JSON), 0, 0, CURRENT_TIMESTAMP(3)),
  ('DEV-DEMO-FAN-001', 'Quat thong gio (demo)', 'FAN', 'Khu demo', @demo_node_id, 27,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   'REGISTERED', 0, NULL, CAST('{"localAutomation":true,"fanThresholds":{"onTempC":32,"offTempC":30,"onHumidityPct":85,"offHumidityPct":80},"auto":{"enabled":true,"preset":"FAN_HYSTERESIS"}}' AS JSON), 0, 0, CURRENT_TIMESTAMP(3)),
  ('CAM-001', 'Camera dien thoai (demo)', 'CAMERA', 'Khu demo', NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL,
   'REGISTERED', 0, NULL, JSON_OBJECT(), 0, 0, CURRENT_TIMESTAMP(3));

SET @demo_soil_id := (SELECT `id` FROM `devices` WHERE `deviceCode` = 'DEV-DEMO-SOIL-001' LIMIT 1);
SET @demo_dht_id := (SELECT `id` FROM `devices` WHERE `deviceCode` = 'DEV-DEMO-DHT-001' LIMIT 1);
SET @demo_pump_id := (SELECT `id` FROM `devices` WHERE `deviceCode` = 'DEV-DEMO-PUMP-001' LIMIT 1);

-- 4. Gan pham vi quyen cho Operator va Viewer. Admin co quyen toan cuc theo RBAC.
INSERT IGNORE INTO `userDevices` (`userId`, `deviceId`, `assignedAt`)
SELECT @demo_operator_id, d.`id`, CURRENT_TIMESTAMP(3)
FROM `devices` d
WHERE d.`deviceCode` IN ('DEV-DEMO-SOIL-001', 'DEV-DEMO-DHT-001', 'DEV-DEMO-PUMP-001', 'DEV-DEMO-FAN-001', 'CAM-001');

INSERT IGNORE INTO `userDevices` (`userId`, `deviceId`, `assignedAt`)
SELECT @demo_viewer_id, d.`id`, CURRENT_TIMESTAMP(3)
FROM `devices` d
WHERE d.`deviceCode` IN ('DEV-DEMO-SOIL-001', 'DEV-DEMO-DHT-001', 'CAM-001');

-- 5. Mot snapshot demo cho tung metric. Chi chen neu metric chua co row backfill
-- demo nao tren thiet bi do, nen chay lai file se khong tao them ban ghi.
-- Gia tri deu nam trong nguong mac dinh: dat 25-85%, nhiet do 5-38C, am khong khi 25-90%.
INSERT INTO `sensorReadings`
  (`deviceId`, `metric`, `recordedAt`, `value`, `sourceBootCount`, `sourceSeq`, `isBackfilled`, `receivedAt`)
SELECT @demo_soil_id, 'SOIL_MOISTURE', DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 20 MINUTE), 48.50,
       NULL, NULL, 1, CURRENT_TIMESTAMP(3)
WHERE @demo_soil_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `sensorReadings`
    WHERE `deviceId` = @demo_soil_id AND `metric` = 'SOIL_MOISTURE'
      AND `isBackfilled` = 1 AND `sourceBootCount` IS NULL AND `sourceSeq` IS NULL
  );

INSERT INTO `sensorReadings`
  (`deviceId`, `metric`, `recordedAt`, `value`, `sourceBootCount`, `sourceSeq`, `isBackfilled`, `receivedAt`)
SELECT @demo_dht_id, 'AIR_TEMPERATURE', DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 18 MINUTE), 28.40,
       NULL, NULL, 1, CURRENT_TIMESTAMP(3)
WHERE @demo_dht_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `sensorReadings`
    WHERE `deviceId` = @demo_dht_id AND `metric` = 'AIR_TEMPERATURE'
      AND `isBackfilled` = 1 AND `sourceBootCount` IS NULL AND `sourceSeq` IS NULL
  );

INSERT INTO `sensorReadings`
  (`deviceId`, `metric`, `recordedAt`, `value`, `sourceBootCount`, `sourceSeq`, `isBackfilled`, `receivedAt`)
SELECT @demo_dht_id, 'AIR_HUMIDITY', DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 18 MINUTE), 64.00,
       NULL, NULL, 1, CURRENT_TIMESTAMP(3)
WHERE @demo_dht_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `sensorReadings`
    WHERE `deviceId` = @demo_dht_id AND `metric` = 'AIR_HUMIDITY'
      AND `isBackfilled` = 1 AND `sourceBootCount` IS NULL AND `sourceSeq` IS NULL
  );

-- 6. Mot alert INFO ve viec day la moi truong demo. Khong tao threshold alert.
INSERT INTO `alerts`
  (`type`, `severity`, `status`, `title`, `message`, `deviceId`, `analysisId`, `createdAt`)
SELECT 'system', 'INFO', 'NEW',
       'Du lieu demo - Node chua duoc claim',
       'Ban ghi khoi tao tu 02_seed_data.sql. Node va cac Device chua duoc claim/xac minh phan cung; reading la du lieu backfill mau.',
       NULL, NULL, CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (
  SELECT 1 FROM `alerts`
  WHERE `type` = 'system' AND `title` = 'Du lieu demo - Node chua duoc claim'
    AND `message` LIKE 'Ban ghi khoi tao tu 02_seed_data.sql.%'
);

-- 7. Mot command history mau FAILED: phu hop voi command.service khi Node chua
-- online/chua co MQTT account. Khong co sentAt/ackedAt va khong co lenh nao duoc gui.
INSERT IGNORE INTO `deviceCommands`
  (`commandUuid`, `deviceId`, `turnOn`, `source`, `issuedBy`, `alertId`, `sensorValue`,
   `status`, `resultMessage`, `createdAt`, `sentAt`, `ackedAt`)
SELECT '00000000-0000-4000-8000-000000000001', @demo_pump_id, 0, 'MANUAL', @demo_operator_id,
       NULL, NULL, 'FAILED',
       'Demo seed: Node offline, chua co tai khoan MQTT dang bat; khong gui lenh xuong phan cung.',
       CURRENT_TIMESTAMP(3), NULL, NULL
WHERE @demo_pump_id IS NOT NULL AND @demo_operator_id IS NOT NULL;

-- 8. Audit log ghi ro day la du lieu khoi tao demo; khong gia lap heartbeat/ACK.
INSERT INTO `auditLogs` (`userId`, `action`, `entityType`, `entityId`, `detail`, `success`, `createdAt`)
SELECT @demo_admin_id, 'seed.demo.initialized', 'system', NULL,
       JSON_OBJECT('source', 'database/02_seed_data.sql',
                   'nodeCode', 'NODE-DEMO-001',
                   'note', 'Demo records only; no MQTT account, claim token, heartbeat or physical ACK.'),
       1, CURRENT_TIMESTAMP(3)
WHERE @demo_admin_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM `auditLogs`
    WHERE `action` = 'seed.demo.initialized' AND `entityType` = 'system'
      AND JSON_UNQUOTE(JSON_EXTRACT(`detail`, '$.nodeCode')) = 'NODE-DEMO-001'
  );

COMMIT;

-- Khong tao CameraToken, claim token, MQTT credentials, LeafAnalysis hay media gia.
-- Token Camera/claim va ket qua AI chi duoc tao qua luong xac thuc/thuc te cua Backend.
