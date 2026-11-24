// Bảng nodes: bo mạch ESP32 (kết nối MQTT, firmware, online/offline, thu hồi kết nối)
module.exports = (sequelize, DataTypes) => {
    const Node = sequelize.define(
        'Node',
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            nodeCode: { type: DataTypes.STRING(50), allowNull: false, unique: true },
            name: { type: DataTypes.STRING(100), allowNull: false },
            firmwareVersion: { type: DataTypes.STRING(30), allowNull: true },
            hardwareVersion: { type: DataTypes.STRING(30), allowNull: true },
            isOnline: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            onlineSince: { type: DataTypes.DATE(3), allowNull: true },
            lastHeartbeatAt: { type: DataTypes.DATE(3), allowNull: true },
            firmwareBootCount: { type: DataTypes.INTEGER, allowNull: true },
            firmwareBootStartedAt: { type: DataTypes.DATE(3), allowNull: true },
            heartbeatTimeoutSec: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60, validate: { min: 1 } },
            isRevoked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            // Mỗi Node có một MQTT principal riêng trên Mosquitto Dynamic Security. Không lưu password dạng rõ trong DB.
            mqttUsername: { type: DataTypes.STRING(80), allowNull: true, unique: true },
            mqttRoleName: { type: DataTypes.STRING(100), allowNull: true, unique: true },
            mqttProvisionedAt: { type: DataTypes.DATE(3), allowNull: true },
            mqttAccountEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            macAddress: { type: DataTypes.STRING(17), allowNull: true, unique: true },
            claimTokenHash: { type: DataTypes.STRING(64), allowNull: true },
            claimTokenExpiresAt: { type: DataTypes.DATE(3), allowNull: true },
            claimConsumedAt: { type: DataTypes.DATE(3), allowNull: true },
            claimFailedAt: { type: DataTypes.DATE(3), allowNull: true },
            claimedAt: { type: DataTypes.DATE(3), allowNull: true },
            revokedAt: { type: DataTypes.DATE(3), allowNull: true },
            createdAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
        },
        {
            tableName: 'nodes',
            timestamps: false,
            defaultScope: { attributes: { exclude: ['claimTokenHash'] } },
        }
    );
    const toJSON = Node.prototype.toJSON;
    Node.prototype.toJSON = function () {
        const result = toJSON.call(this);
        delete result.claimTokenHash;
        return result;
    };
    return Node;
};
