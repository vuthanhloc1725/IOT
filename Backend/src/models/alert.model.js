// Bảng alerts: lịch sử cảnh báo (bệnh cây, vượt ngưỡng, thiết bị offline/lỗi, thông tin hệ thống)
module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'Alert',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      type: {
        type: DataTypes.ENUM('offline', 'fault', 'system', 'sensor_threshold'),
        allowNull: false,
      },
      severity: { type: DataTypes.ENUM('CRITICAL', 'WARNING', 'INFO'), allowNull: false, defaultValue: 'WARNING' },
      status: { type: DataTypes.ENUM('NEW', 'ACKNOWLEDGED', 'RESOLVED'), allowNull: false, defaultValue: 'NEW' },
      title: { type: DataTypes.STRING(200), allowNull: false },
      message: { type: DataTypes.TEXT, allowNull: true },
      deviceId: { type: DataTypes.INTEGER, allowNull: true },
      analysisId: { type: DataTypes.INTEGER, allowNull: true },
      createdAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
      acknowledgedBy: { type: DataTypes.INTEGER, allowNull: true },
      acknowledgedAt: { type: DataTypes.DATE(3), allowNull: true },
      resolvedBy: { type: DataTypes.INTEGER, allowNull: true },
      resolvedAt: { type: DataTypes.DATE(3), allowNull: true },
      resolutionNote: { type: DataTypes.TEXT, allowNull: true },
    },
    {
      tableName: 'alerts',
      timestamps: false,
      validate: {
        acknowledgedNeedsUser() {
          if (this.status === 'ACKNOWLEDGED' && (!this.acknowledgedBy || !this.acknowledgedAt)) {
            throw new Error('Cảnh báo đã xác nhận phải có người xác nhận và thời điểm');
          }
        },
        resolvedNeedsTime() {
          // resolvedBy có thể NULL: hệ thống tự đóng
          if (this.status === 'RESOLVED' && !this.resolvedAt) {
            throw new Error('Cảnh báo đã xử lý phải có thời điểm xử lý');
          }
        },
      },
    },

  );
