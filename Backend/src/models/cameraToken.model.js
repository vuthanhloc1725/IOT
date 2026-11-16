module.exports = (sequelize, DataTypes) =>
    sequelize.define('CameraToken', {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        cameraId: { type: DataTypes.STRING(60), allowNull: false, unique: true },
        tokenHash: { type: DataTypes.CHAR(64), allowNull: false },
        label: { type: DataTypes.STRING(120), allowNull: true },
        isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    }, {
        tableName: 'camera_tokens',
        timestamps: true,
        defaultScope: { attributes: { exclude: ['tokenHash'] } },
    });
