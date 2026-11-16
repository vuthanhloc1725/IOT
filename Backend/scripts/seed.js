// Seed idempotent cho database đã tạo schema bằng database/smart_agri_mysql_demo.sql.
// Không gọi sequelize.sync() để tránh tự ý thay đổi cấu trúc hoặc phá dữ liệu production.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { sequelize, User, Disease, Device } = require('../src/models');

async function ensureAdmin() {
  const username = String(process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin').trim();
  const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@iot.local').trim();
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
  const fullName = String(process.env.BOOTSTRAP_ADMIN_FULL_NAME || 'System Administrator').trim();

  const admin = await User.findOne({ where: { role: 'admin' } });
  if (admin) {
    console.log(`[seed] Admin đã tồn tại: ${admin.username}; bỏ qua tạo Admin.`);
  } else {
    if (password.length < 12) {
      throw new Error('BOOTSTRAP_ADMIN_PASSWORD phải có ít nhất 12 ký tự. Hãy cấu hình trong Backend/.env');
    }
    const duplicate = await User.findOne({ where: { username } });
    if (duplicate) throw new Error(`Username "${username}" đã tồn tại nhưng không phải Admin.`);
    await User.create({
      username, email, fullName, role: 'admin', isActive: true,
      passwordHash: await bcrypt.hash(password, 12),
    });
    console.log(`[seed] Đã tạo Admin: ${username}`);
  }
}

async function ensureCatalog() {
  const diseases = [
    ['Tomato___Late_blight', 'Bệnh mốc sương', 'Tomato late blight', false],
    ['Tomato___Early_blight', 'Bệnh đốm vòng', 'Tomato early blight', false],
    ['Tomato___healthy', 'Lá cà chua khỏe mạnh', 'Healthy tomato leaf', true],
    ['Pepper,_bell___Bacterial_spot', 'Bệnh đốm vi khuẩn trên ớt', 'Bacterial spot', false],
  ];
  for (const [modelLabel, nameVi, nameEn, isHealthy] of diseases) {
    await Disease.findOrCreate({
      where: { modelLabel },
      defaults: { nameVi, nameEn, isHealthy },
    });
  }
  console.log('[seed] Đã kiểm tra danh mục diseases.');
}

async function ensureDemoCamera() {
  const [camera, created] = await Device.findOrCreate({
    where: { deviceCode: 'CAM-001' },
    defaults: {
      name: 'Camera điện thoại Nhà kính A',
      type: 'CAMERA',
      location: 'Nhà kính A',
      nodeId: null,
      lifecycle: 'REGISTERED',
      isOn: false,
      config: { captureIntervalSeconds: 60 },
      configVersion: 0,
      configAppliedVersion: 0,
    },
  });
  if (camera.type !== 'CAMERA') throw new Error('CAM-001 đã tồn tại nhưng không phải thiết bị CAMERA.');
  console.log(`[seed] Camera CAM-001 ${created ? 'đã được tạo' : 'đã tồn tại'}.`);
  console.log('[seed] Không tạo Camera token mặc định. Admin phải cấp token qua POST /api/camera/tokens/CAM-001.');
}

async function main() {
  await sequelize.authenticate();
  await ensureAdmin();
  await ensureCatalog();
  await ensureDemoCamera();
  console.log('[seed] Hoàn tất. Script không thay đổi schema database.');
}

main()
  .catch((error) => { console.error('[seed]', error.message); process.exitCode = 1; })
  .finally(async () => { await sequelize.close().catch(() => {}); });
