module.exports = (sequelize, DataTypes) =>
    sequelize.define('CameraMedia', {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        eventId: { type: DataTypes.STRING(120), allowNull: false, unique: true },
        cameraId: { type: DataTypes.STRING(60), allowNull: false },
        requestId: { type: DataTypes.STRING(120), allowNull: true },
        mediaType: { type: DataTypes.ENUM('image', 'video'), allowNull: false, defaultValue: 'image' },
        mimeType: { type: DataTypes.STRING(60), allowNull: false },
        filename: { type: DataTypes.STRING(255), allowNull: false },
        sizeBytes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        sha256: { type: DataTypes.CHAR(64), allowNull: false },
        capturedAt: { type: DataTypes.DATE(3), allowNull: true },
        receivedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'camera_media',
        timestamps: false,
    });
