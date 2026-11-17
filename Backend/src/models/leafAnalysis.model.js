// Lịch sử nhận diện từ dịch vụ AI bên ngoài. deviceId là tùy chọn vì kết quả không nhất thiết thuộc một thiết bị IoT.
// eventId giúp chống lưu trùng khi MQTT QoS 1 gửi lại cùng một bản tin.
module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'LeafAnalysis',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      eventId: { type: DataTypes.STRING(100), allowNull: true },
      deviceId: { type: DataTypes.INTEGER, allowNull: true },
      uploadedBy: { type: DataTypes.INTEGER, allowNull: true },
      capturedAt: { type: DataTypes.DATE(3), allowNull: false },
      diseaseId: { type: DataTypes.INTEGER, allowNull: false },
      confidence: {
        type: DataTypes.DECIMAL(5, 4),
        allowNull: false,
        validate: { min: 0, max: 1 },
        get() {
          const v = this.getDataValue('confidence');
          return v === null ? null : Number(v);
        },
      },
      boundingBoxes: { type: DataTypes.JSON, allowNull: true },
      // Xác suất của toàn bộ lớp AI (label, label_vi, confidence, class_id).
      predictions: { type: DataTypes.JSON, allowNull: true },
      aiResult: { type: DataTypes.JSON, allowNull: true },
      // Chỉ lưu tên file ngẫu nhiên do Backend tạo, không nhận đường dẫn từ request.
      imagePath: { type: DataTypes.STRING(500), allowNull: true },
      imageUrl: { type: DataTypes.STRING(1000), allowNull: true },
      cloudinaryPublicId: { type: DataTypes.STRING(255), allowNull: true },
      imageSha256: { type: DataTypes.CHAR(64), allowNull: true },
      modelVersion: { type: DataTypes.STRING(50), allowNull: false },
      inferenceMs: { type: DataTypes.INTEGER, allowNull: true },
      receivedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: 'leafAnalyses',
      timestamps: false,
      indexes: [
        { unique: true, fields: ['eventId'], name: 'leafAnalyses_eventId_unique' },
        { fields: ['uploadedBy'], name: 'idx_leafAnalyses_uploadedBy' },
      ],
    }
  );
