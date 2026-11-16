const { v2: cloudinary } = require('cloudinary');
const env = require('../config/env');
const ApiError = require('../utils/apiError');

let configured = false;
function configure() {
  if (configured) return;
  if (!env.cloudinary.cloudName || !env.cloudinary.apiKey || !env.cloudinary.apiSecret) {
    throw new ApiError(503, 'Chưa cấu hình CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY và CLOUDINARY_API_SECRET');
  }
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  });
  configured = true;
}

exports.uploadImage = async ({ buffer, mimeType, cameraId, eventId }) => {
  configure();
  const resourceType = 'image';
  const folder = env.cloudinary.folder;
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      resource_type: resourceType,
      folder,
      public_id: `${String(cameraId).replace(/[^a-zA-Z0-9_-]/g, '_')}_${String(eventId).replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      overwrite: false,
      unique_filename: false,
      use_filename: false,
      tags: ['smart-agri', `camera:${cameraId}`],
      context: { cameraId: String(cameraId), eventId: String(eventId), mimeType },
    }, (error, result) => {
      if (error) return reject(new ApiError(502, `Cloudinary upload thất bại: ${String(error.message || error).slice(0, 180)}`));
      resolve({
        url: result.secure_url,
        publicId: result.public_id,
        format: result.format,
        bytes: result.bytes,
      });
    });
    stream.end(buffer);
  });
};

exports.deleteImage = async (publicId) => {
  if (!publicId) return;
  configure();
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
};
