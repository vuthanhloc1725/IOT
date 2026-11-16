// Bảng sensor_readings: dữ liệu đo. Khóa chính (deviceId, metric, recordedAt) chống lưu trùng khi gửi bù.
// Ghi bù an toàn: SensorReading.bulkCreate(rows, { ignoreDuplicates: true })
module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'SensorReading',
    {
      deviceId: { type: DataTypes.INTEGER, primaryKey: true },
      metric: { type: DataTypes.ENUM('SOIL_MOISTURE', 'AIR_TEMPERATURE', 'AIR_HUMIDITY'), primaryKey: true },
      recordedAt: { type: DataTypes.DATE(3), primaryKey: true },
      value: {
        type: DataTypes.DECIMAL(8, 2),
        allowNull: false,
        get() {
          const v = this.getDataValue('value');
          return v === null ? null : Number(v);
        },
      },
      sourceBootCount: { type: DataTypes.INTEGER, allowNull: true },
      sourceSeq: { type: DataTypes.BIGINT, allowNull: true },
      isBackfilled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      receivedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    },
    { tableName: 'sensorReadings', timestamps: false }
  );
