const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mqttTlsOptions = require('../src/config/mqtt-tls');

test('MQTT uses certificate verification with system trust by default', () => {
    assert.deepEqual(mqttTlsOptions(), { rejectUnauthorized: true });
    assert.deepEqual(mqttTlsOptions(''), { rejectUnauthorized: true });
});

test('MQTT private CA resolves relative to Backend, independently of cwd', () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-mqtt-ca-'));
    const certificate = path.join(temporary, 'ca.pem');
    try {
        fs.writeFileSync(certificate, 'test CA contents');
        const backendRoot = path.resolve(__dirname, '..');
        const options = mqttTlsOptions(path.relative(backendRoot, certificate));
        assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.ca.toString(), 'test CA contents');
        assert.deepEqual(mqttTlsOptions(certificate), options);
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('An unreadable CA fails instead of silently dropping certificate verification', () => {
    assert.throws(() => mqttTlsOptions('nonexistent-ca-directory/ca.pem'), /Không đọc được MQTT_CA_FILE/);
});
