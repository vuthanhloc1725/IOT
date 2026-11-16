
// Không dùng sequelize.sync(): bảng được tạo bằng database/smart_agri_mysql_demo.sql (có kèm seed demo) hoặc scripts/seed-admin.js trên database mới.
// Biến môi trường (xem .env.example): DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_LOGGING
//
// SƠ ĐỒ QUAN HỆ (1 --< nhiều)
//   User   1--< AuditLog                  (userId)
//   User   >--< Device                    (qua UserDevice: phạm vi truy cập)
//   Node   1--< Device                    (nodeId)
//   Device 1--< SensorReading             (deviceId)
//   Device 1--< DeviceCommand             (deviceId)
//   User   1--< DeviceCommand             (issuedBy)
//   Alert  1--< DeviceCommand             (alertId)
//   Device 1--< Alert                     (deviceId)
//   User   1--< Alert                     (acknowledgedBy, resolvedBy)
//   Device 1--< LeafAnalysis              (deviceId tùy chọn; AI bên ngoài có thể không gắn thiết bị)
//   LeafAnalysis 1--< Alert               (analysisId)
//   Disease 1--< LeafAnalysis             (diseaseId)
//   Disease 1--< Treatment                (diseaseId)
// =====================================================================
const { Sequelize, DataTypes } = require('sequelize');
const sequelize = require('../config/db');

// ---------- Nạp model ----------
const User = require('./user.model')(sequelize, DataTypes);
const AuditLog = require('./auditLog.model')(sequelize, DataTypes);
const Node = require('./node.model')(sequelize, DataTypes);
const Device = require('./device.model')(sequelize, DataTypes);
const UserDevice = require('./userDevice.model')(sequelize, DataTypes);
const SensorReading = require('./sensorReading.model')(sequelize, DataTypes);
const Disease = require('./disease.model')(sequelize, DataTypes);
const Treatment = require('./treatment.model')(sequelize, DataTypes);
const LeafAnalysis = require('./leafAnalysis.model')(sequelize, DataTypes);
const Alert = require('./alert.model')(sequelize, DataTypes);
const DeviceCommand = require('./deviceCommand.model')(sequelize, DataTypes);
const CameraToken = require('./cameraToken.model')(sequelize, DataTypes);
const CameraMedia = require('./cameraMedia.model')(sequelize, DataTypes);

// ---------- Quan hệ: người dùng ----------
// Nhật ký thao tác (xóa user thì giữ log, userId = NULL)
User.hasMany(AuditLog, { foreignKey: 'userId', as: 'auditLogs', onDelete: 'SET NULL' });
AuditLog.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Phạm vi truy cập: người dùng <-> thiết bị (nhiều-nhiều qua user_devices)
User.belongsToMany(Device, { through: UserDevice, foreignKey: 'userId', otherKey: 'deviceId', as: 'devices' });
Device.belongsToMany(User, { through: UserDevice, foreignKey: 'deviceId', otherKey: 'userId', as: 'users' });
User.hasMany(UserDevice, { foreignKey: 'userId', as: 'assignments', onDelete: 'CASCADE' });
Device.hasMany(UserDevice, { foreignKey: 'deviceId', as: 'assignments', onDelete: 'CASCADE' });
UserDevice.belongsTo(User, { foreignKey: 'userId', as: 'user' });
UserDevice.belongsTo(Device, { foreignKey: 'deviceId', as: 'device' });

// ---------- Quan hệ: thiết bị ----------
// Một node (ESP32) điều khiển nhiều thiết bị
Node.hasMany(Device, { foreignKey: 'nodeId', as: 'devices', onDelete: 'RESTRICT' });
Device.belongsTo(Node, { foreignKey: 'nodeId', as: 'node' });
Device.hasOne(CameraToken, { foreignKey: 'deviceId', as: 'cameraToken', onDelete: 'CASCADE' });
CameraToken.belongsTo(Device, { foreignKey: 'deviceId', as: 'camera', onDelete: 'CASCADE' });

// Dữ liệu cảm biến
Device.hasMany(SensorReading, { foreignKey: 'deviceId', as: 'readings', onDelete: 'CASCADE' });
SensorReading.belongsTo(Device, { foreignKey: 'deviceId', as: 'device' });

// Lệnh điều khiển
Device.hasMany(DeviceCommand, { foreignKey: 'deviceId', as: 'commands', onDelete: 'CASCADE' });
DeviceCommand.belongsTo(Device, { foreignKey: 'deviceId', as: 'device' });
User.hasMany(DeviceCommand, { foreignKey: 'issuedBy', as: 'issuedCommands', onDelete: 'SET NULL' });
DeviceCommand.belongsTo(User, { foreignKey: 'issuedBy', as: 'issuer' });
Alert.hasMany(DeviceCommand, { foreignKey: 'alertId', as: 'commands', onDelete: 'SET NULL' });
DeviceCommand.belongsTo(Alert, { foreignKey: 'alertId', as: 'alert' });

// ---------- Quan hệ: cảnh báo ----------
Device.hasMany(Alert, { foreignKey: 'deviceId', as: 'alerts', onDelete: 'SET NULL' });
Alert.belongsTo(Device, { foreignKey: 'deviceId', as: 'device' });
User.hasMany(Alert, { foreignKey: 'acknowledgedBy', as: 'acknowledgedAlerts', onDelete: 'SET NULL' });
Alert.belongsTo(User, { foreignKey: 'acknowledgedBy', as: 'acknowledger' });
User.hasMany(Alert, { foreignKey: 'resolvedBy', as: 'resolvedAlerts', onDelete: 'SET NULL' });
Alert.belongsTo(User, { foreignKey: 'resolvedBy', as: 'resolver' });
LeafAnalysis.hasMany(Alert, { foreignKey: 'analysisId', as: 'alerts', onDelete: 'SET NULL' });
Alert.belongsTo(LeafAnalysis, { foreignKey: 'analysisId', as: 'analysis' });

// ---------- Quan hệ: AI nhận diện bệnh ----------
// Kết quả AI có thể gắn thiết bị cũ hoặc deviceId = NULL cho nguồn ngoài không quản lý như IoT device.
Device.hasMany(LeafAnalysis, { foreignKey: 'deviceId', as: 'analyses', onDelete: 'CASCADE' });
LeafAnalysis.belongsTo(Device, { foreignKey: 'deviceId', as: 'device' });

// Kết quả AI -> bệnh / thiếu dinh dưỡng
Disease.hasMany(LeafAnalysis, { foreignKey: 'diseaseId', as: 'analyses' });
LeafAnalysis.belongsTo(Disease, { foreignKey: 'diseaseId', as: 'disease' });

// Phác đồ điều trị: của bệnh hoặc của loại thiếu chất
Disease.hasMany(Treatment, { foreignKey: 'diseaseId', as: 'treatments' });
Treatment.belongsTo(Disease, { foreignKey: 'diseaseId', as: 'disease' });

// ---------- Quan hệ: camera phone ----------
// Camera là Device type CAMERA; ảnh lưu đĩa (fallback khi chưa cấu hình AI/Cloudinary) gắn theo deviceCode.
Device.hasMany(CameraMedia, { foreignKey: 'cameraId', sourceKey: 'deviceCode', as: 'cameraMedia', constraints: false });
CameraMedia.belongsTo(Device, { foreignKey: 'cameraId', targetKey: 'deviceCode', as: 'camera', constraints: false });

// ---------- Hàm tiện ích ----------
async function connect() {
  await sequelize.authenticate();
  console.log('Đã kết nối MySQL');
}

module.exports = {
  sequelize,
  Sequelize,
  connect,
  User,
  AuditLog,
  Node,
  Device,
  UserDevice,
  SensorReading,
  Disease,
  Treatment,
  LeafAnalysis,
  Alert,
  DeviceCommand,
  CameraToken,
  CameraMedia,
};
