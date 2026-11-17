const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { LeafAnalysis, Disease } = require('../models');
const ApiError = require('../utils/apiError');
const { dateRange } = require('../utils/helpers');
const { paging, meta } = require('../utils/pagination');
const analysisService = require('../services/analysis.service');
const aiPrediction = require('../services/ai-prediction.service');
const imageStorage = require('../services/analysis-image.storage');
const { accessibleDeviceIds, getDeviceForUser } = require('../services/access.service');
const socket = require('../services/socket.service');
const audit = require('../services/audit.service');

exports.predict = async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Thiếu file trong multipart field "file"');
    const { actualMime, result } = await aiPrediction.predictImage({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
    });

    const disease = await Disease.findOne({ where: { modelLabel: result.label.trim() } });
    if (!disease) {
        throw ApiError.unprocessable(`Nhãn AI "${result.label}" chưa có trong danh mục diseases; hãy chạy migration thêm nhãn Malabar`);
    }
    if (Boolean(disease.isHealthy) !== result.is_healthy) {
        throw ApiError.unprocessable('is_healthy của AI không khớp danh mục diseases');
    }

    const eventId = crypto.randomUUID();
    const imageSha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const imagePath = await imageStorage.save(req.file.buffer, actualMime);
    let created;
    try {
        created = await LeafAnalysis.create({
            eventId,
            deviceId: null,
            uploadedBy: req.user.id,
            capturedAt: new Date(),
            diseaseId: disease.id,
            confidence: result.confidence,
            predictions: result.predictions,
            aiResult: result,
            boundingBoxes: null,
            imagePath,
            imageUrl: null,
            cloudinaryPublicId: null,
            imageSha256,
            modelVersion: typeof result.model_version === 'string' ? result.model_version.slice(0, 50) : 'external-ai-api',
            inferenceMs: Number.isFinite(result.inference_ms) ? Math.round(result.inference_ms) : null,
        });
    } catch (error) {
        try {
            await imageStorage.remove(imagePath);
        } catch (cleanupError) {
            console.error('[analysis] image cleanup failed:', cleanupError.message);
        }
        throw error;
    }

    const analysis = await LeafAnalysis.findByPk(created.id, { include: analysisService.fullInclude });
    socket.emitAuthenticated('analysis:new', analysis);
    await audit.log(req, {
        action: 'analysis.user_upload',
        entityType: 'leafAnalysis',
        entityId: created.id,
        detail: { eventId, diseaseId: disease.id, confidence: result.confidence, imageSha256 },
    });
    res.status(201).json({ data: result, analysisId: created.id });
};

// Kết quả AI không gắn thiết bị vẫn được hiển thị cho người dùng đã đăng nhập.
// Kết quả cũ có deviceId tiếp tục tuân theo phạm vi phân quyền từng thiết bị.
function analysisScope(ids, userId) {
    if (ids === null) return {};
    return {
        [Op.or]: [
            { deviceId: { [Op.in]: ids } },
            { deviceId: null, [Op.or]: [{ uploadedBy: userId }, { uploadedBy: null }] },
        ],
    };
}

async function assertAnalysisAccess(user, analysis) {
    if (analysis.deviceId) {
        await getDeviceForUser(user, analysis.deviceId);
        return;
    }
    if (user.role !== 'admin' && analysis.uploadedBy != null
        && Number(analysis.uploadedBy) !== Number(user.id)) {
        throw ApiError.notFound('Không tìm thấy kết quả phân tích');
    }
}

exports.list = async (req, res) => {
    const { page, limit, offset } = paging(req, 20);
    const deviceIds = await accessibleDeviceIds(req.user);
    const where = {
        ...analysisScope(deviceIds, req.user.id),
        ...dateRange(req.query, 'capturedAt'),
    };

    if (req.query.deviceId !== undefined && req.query.deviceId !== '') {
        const requestedDeviceId = Number(req.query.deviceId);
        if (!Number.isInteger(requestedDeviceId) || requestedDeviceId <= 0) {
            throw ApiError.badRequest('deviceId không hợp lệ');
        }
        await getDeviceForUser(req.user, requestedDeviceId);
        where.deviceId = requestedDeviceId;
    }

    if (req.query.diseaseId) {
        const diseaseId = Number(req.query.diseaseId);
        if (!Number.isInteger(diseaseId) || diseaseId <= 0) throw ApiError.badRequest('diseaseId không hợp lệ');
        where.diseaseId = diseaseId;
    }

    const { rows, count } = await LeafAnalysis.findAndCountAll({
        where,
        limit,
        offset,
        order: [['capturedAt', 'DESC']],
        include: [
            { association: 'device', attributes: ['id', 'deviceCode', 'name'] },
            { association: 'disease', attributes: ['id', 'nameVi', 'nameEn', 'isHealthy'] },
        ],
    });

    const data = rows.map((row) => {
        const item = row.toJSON();
        return { ...item, imageUrl: item.imageUrl || (item.imagePath ? `/api/analyses/${item.id}/image` : null) };
    });
    res.json({ data, meta: meta(page, limit, count) });
};

// Chi tiết kết quả + phác đồ điều trị theo bệnh trong danh mục.
exports.get = async (req, res) => {
    const analysis = await LeafAnalysis.findByPk(req.params.id, {
        include: analysisService.fullInclude,
    });
    if (!analysis) throw ApiError.notFound('Không tìm thấy kết quả phân tích');

    await assertAnalysisAccess(req.user, analysis);

    const treatments = [...(analysis.disease?.treatments || [])];
    res.json({
        data: analysis,
        imageUrl: analysis.imageUrl || (analysis.imagePath ? `/api/analyses/${analysis.id}/image` : null),
        recommendations: {
            biological: treatments.filter((treatment) => treatment.type === 'BIOLOGICAL'),
            chemical: treatments.filter((treatment) => treatment.type === 'CHEMICAL'),
        },
    });
};

// Ảnh không được public static: yêu cầu JWT và áp dụng cùng phạm vi quyền của kết quả nhận diện.
exports.image = async (req, res) => {
    const analysis = await LeafAnalysis.findByPk(req.params.id, {
        attributes: ['id', 'deviceId', 'uploadedBy', 'imagePath', 'imageUrl'],
    });
    if (!analysis) throw ApiError.notFound('Không tìm thấy kết quả phân tích');
    await assertAnalysisAccess(req.user, analysis);
    if (analysis.imageUrl) return res.redirect(302, analysis.imageUrl);
    if (!analysis.imagePath) throw ApiError.notFound('Kết quả này chưa có ảnh nhận diện');

    const image = await imageStorage.read(analysis.imagePath);
    res.set({
        'Content-Type': image.mimeType,
        'Content-Length': String(image.buffer.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    res.send(image.buffer);
};

