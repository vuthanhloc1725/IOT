// Camera API token: token thô chỉ trả cho Admin đúng một lần; DB chỉ lưu SHA-256.
module.exports = (sequelize, DataTypes) => sequelize.define('CameraToken', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  deviceId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
  expiresAt: { type: DataTypes.DATE(3), allowNull: true },
  revokedAt: { type: DataTypes.DATE(3), allowNull: true },
  createdAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  lastUsedAt: { type: DataTypes.DATE(3), allowNull: true },
}, { tableName: 'cameraTokens', timestamps: false });
