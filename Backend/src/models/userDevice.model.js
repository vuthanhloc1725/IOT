// Bảng user_devices: phạm vi truy cập (người dùng nào được xem/điều khiển thiết bị nào)
module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'UserDevice',
        {
            userId: { type: DataTypes.INTEGER, primaryKey: true },
            deviceId: { type: DataTypes.INTEGER, primaryKey: true },
            assignedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
        },
        { tableName: 'userDevices', timestamps: false }
    );
