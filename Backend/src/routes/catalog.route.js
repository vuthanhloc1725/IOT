const router = require('express').Router();
const wrap = require('../utils/wrap');
const catalog = require('../controllers/catalog.controller');
const { Disease, Treatment, LeafAnalysis } = require('../models');
const ApiError = require('../utils/apiError');
const { authenticate } = require('../middlewares/auth');
const { requireRole } = require('../middlewares/rbac');

async function validateTreatment({ values, row }) {
  const diseaseId = values.diseaseId ?? row?.diseaseId;
  if (!Number.isInteger(Number(diseaseId)) || Number(diseaseId) <= 0) {
    throw ApiError.badRequest('Mỗi phương pháp điều trị phải thuộc về một bệnh hợp lệ');
  }

  const disease = await Disease.findByPk(diseaseId);
  if (!disease) throw ApiError.badRequest('Bệnh được chọn không tồn tại');
  if (disease.isHealthy) {
    throw ApiError.badRequest('Không thể thêm phương pháp điều trị cho danh mục lá khỏe mạnh');
  }

  const name = values.name ?? row?.name;
  const instructions = values.instructions ?? row?.instructions;
  const sourceReference = values.sourceReference ?? row?.sourceReference;
  const type = values.type ?? row?.type;
  const activeIngredient = values.activeIngredient ?? row?.activeIngredient;

  if (!String(name || '').trim()) throw ApiError.badRequest('Tên phương pháp điều trị không được để trống');
  if (!String(instructions || '').trim()) throw ApiError.badRequest('Hướng dẫn điều trị không được để trống');
  if (!String(sourceReference || '').trim()) throw ApiError.badRequest('Nguồn tham khảo không được để trống');
  if (type === 'CHEMICAL' && !String(activeIngredient || '').trim()) {
    throw ApiError.badRequest('Phương pháp hóa học phải có hoạt chất');
  }
}

async function validateDisease({ values, row }) {
  const becomesHealthy = values.isHealthy !== undefined ? Boolean(values.isHealthy) : Boolean(row?.isHealthy);
  if (becomesHealthy && row) {
    const treatmentCount = await Treatment.count({ where: { diseaseId: row.id } });
    if (treatmentCount > 0) {
      throw ApiError.conflict('Hãy xóa các phương pháp điều trị trước khi chuyển bệnh này thành nhãn lá khỏe mạnh');
    }
  }
}

async function protectDiseaseRemoval({ row }) {
  const [analysisCount, treatmentCount] = await Promise.all([
    LeafAnalysis.count({ where: { diseaseId: row.id } }),
    Treatment.count({ where: { diseaseId: row.id } }),
  ]);
  if (analysisCount > 0) {
    throw ApiError.conflict('Không thể xóa bệnh đã được sử dụng trong lịch sử nhận diện AI');
  }
  if (treatmentCount > 0) {
    throw ApiError.conflict('Hãy xóa các phương pháp điều trị thuộc bệnh này trước khi xóa bệnh');
  }
}

// Người dùng đã đăng nhập được xem danh mục; chỉ Admin được tạo, sửa, xóa.
const resources = {
  diseases: catalog(Disease, {
    label: 'disease',
    fields: ['modelLabel', 'nameVi', 'nameEn', 'isHealthy'],
    filters: ['isHealthy'],
    include: [{ association: 'treatments' }],
    beforeWrite: validateDisease,
    beforeRemove: protectDiseaseRemoval,
  }),
  treatments: catalog(Treatment, {
    label: 'treatment',
    fields: ['diseaseId', 'name', 'type', 'instructions', 'activeIngredient', 'dosageText', 'intervalDays', 'sourceReference'],
    filters: ['diseaseId', 'type'],
    include: [{ association: 'disease', attributes: ['id', 'nameVi', 'nameEn', 'modelLabel'] }],
    beforeWrite: validateTreatment,
  }),
};

router.use(authenticate);

for (const [path, raw] of Object.entries(resources)) {
  const controller = wrap(raw);
  router.get(`/${path}`, controller.list);
  router.get(`/${path}/:id`, controller.get);
  router.post(`/${path}`, requireRole('admin'), controller.create);
  router.patch(`/${path}/:id`, requireRole('admin'), controller.update);
  router.delete(`/${path}/:id`, requireRole('admin'), controller.remove);
}

module.exports = router;
