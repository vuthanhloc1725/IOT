const fs = require('node:fs');
const path = require('node:path');

// Resolve relative paths from Backend, independently of the process working directory.
module.exports = function mqttTlsOptions(caFile) {
    const options = { rejectUnauthorized: true };
    if (caFile) {
        const absolutePath = path.resolve(__dirname, '../..', caFile);
        try {
            options.ca = fs.readFileSync(absolutePath);
        } catch (error) {
            throw new Error(`Không đọc được MQTT_CA_FILE (${absolutePath}): ${error.message}`);
        }
    }
    return options;
};
