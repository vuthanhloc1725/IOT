const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');
const exampleEnv = fs.readFileSync(path.join(backendRoot, '.env.example'), 'utf8');
const dynsecDocs = fs.readFileSync(path.join(backendRoot, 'docs/mosquitto-acl.example'), 'utf8');
const mqttClient = fs.readFileSync(path.join(backendRoot, 'src/services/mqtt.client.js'), 'utf8');
const dynsecService = fs.readFileSync(path.join(backendRoot, 'src/services/mqtt-dynsec.service.js'), 'utf8');
// Vòng đời tài khoản Broker của Node nằm ở controller + node-provisioning.service.
const nodeController = ['src/controllers/node.controller.js', 'src/services/node-provisioning.service.js']
  .map((file) => fs.readFileSync(path.join(backendRoot, file), 'utf8')).join('\n');

test('Firmware MQTT prefix and per-Node Dynamic Security configuration are consistent', () => {
  assert.match(exampleEnv, /^MQTT_TOPIC_PREFIX=iot$/m);
  assert.match(exampleEnv, /^MQTT_FIRMWARE_TOPIC_PREFIX=sf$/m);
  assert.match(exampleEnv, /^MQTT_DYNSEC_ENABLED=false$/m); // bật true sau khi cài plugin và khởi tạo Dynamic Security
  assert.match(exampleEnv, /^MQTT_DYNSEC_ADMIN_USERNAME=/m);
  assert.match(exampleEnv, /^MQTT_DYNSEC_ADMIN_PASSWORD=/m);
  assert.match(dynsecDocs, /plugin .*mosquitto_dynamic_security/);
  assert.match(dynsecDocs, /one MQTT username\/password \+ one least-privilege ACL role per Node/);
  assert.match(dynsecDocs, /setDefaultACLAccess publishClientReceive deny/);
  assert.match(dynsecDocs, /setDefaultACLAccess unsubscribe deny/);
  assert.match(dynsecDocs, /disableClient/);
  assert.match(dynsecDocs, /enableClient/);
  assert.match(dynsecService, /publishClientSend/);
  assert.match(dynsecService, /publishClientReceive/);
  assert.match(dynsecService, /subscribeLiteral/);
  assert.match(dynsecService, /createClient/);
  assert.match(dynsecService, /disableClient/);
  assert.match(dynsecService, /enableClient/);
  assert.match(nodeController, /mqttDynsec\.createAccount/);
  assert.match(nodeController, /mqttDynsec\.disableAccount/);
  assert.match(nodeController, /mqttDynsec\.enableAccount/);
  assert.match(mqttClient, /\$\{P\}\/\+\/device\/probe\/ack/);
  assert.match(mqttClient, /'device\/probe\/ack'/);
});
