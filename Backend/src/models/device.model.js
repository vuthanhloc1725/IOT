module.exports = (sequelize, DataTypes) =>
    sequelize.define(
        'Device',
        {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            deviceCode: { type: DataTypes.STRING(50), allowNull: false, unique: true },
            name: { type: DataTypes.STRING(100), allowNull: false },
            // CAMERA dùng cho Camera/Agent gửi ảnh trực tiếp qua HTTP, quản lý token riêng.
            type: { type: DataTypes.ENUM('PUMP', 'FAN', 'SENSOR', 'CAMERA'), allowNull: false },
            location: { type: DataTypes.STRING(150), allowNull: true },
            nodeId: { type: DataTypes.INTEGER, allowNull: true },
            gpioPin: { type: DataTypes.INTEGER, allowNull: true },
            // [MỚI] Chỉ ghi nhận khi Node trả lời probe hợp lệ; giúp phân biệt khai báo và phần cứng đã xác minh.
            presenceVerifiedAt: { type: DataTypes.DATE(3), allowNull: true },
            // Lưu loại readiness ngắn gọn; không lưu chuỗi evidence dài vào bảng devices.
            readinessVerifiedAt: { type: DataTypes.DATE(3), allowNull: true },
            readinessType: { type: DataTypes.ENUM('SENSOR_TELEMETRY', 'CURRENT_SENSOR', 'FLOW_SENSOR'), allowNull: true },
            // [MỚI] Thời điểm lifecycle đổi; tách khỏi stateChangedAt vốn dùng khi output bật/tắt.
            lifecycleChangedAt: { type: DataTypes.DATE(3), allowNull: true },
            // Lifecycle ACTIVE chỉ được xác nhận sau ACK của Firmware cho lệnh lifecycle.
            pendingLifecycleCommandUuid: { type: DataTypes.UUID, allowNull: true, unique: true },
            pendingLifecycleCommandTo: { type: DataTypes.STRING(30), allowNull: true },
            pendingLifecycleCommandSentAt: { type: DataTypes.DATE(3), allowNull: true },
            lifecycle: {
                type: DataTypes.ENUM('REGISTERED', 'PROVISIONED', 'ACTIVE', 'FAULT', 'MAINTENANCE', 'DECOMMISSIONED'),
                allowNull: false,
                defaultValue: 'REGISTERED',
            },
            isOn: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            // speedPercent: { type: DataTypes.INTEGER, allowNull: true, validate: { min: 0, max: 100 } },
            // Thời điểm trạng thái output (ví dụ isOn của PUMP) thay đổi gần nhất.
            stateChangedAt: { type: DataTypes.DATE(3), allowNull: true },
            config: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
            configVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            configAppliedVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            createdAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
        },
        {
            tableName: 'devices',
            timestamps: false,
            validate: {
                // Giống CHECK của DB, để báo lỗi sớm ở backend
                onOffOnlyForActuator() {
                    if (!['PUMP', 'FAN'].includes(this.type) && this.isOn) {
                        throw new Error('Chỉ PUMP/FAN mới có trạng thái bật/tắt trong hệ thống hiện tại');
                    }
                },
                nodeRequiredAfterRegistered() {
                    if (!['REGISTERED', 'DECOMMISSIONED'].includes(this.lifecycle) && !this.nodeId) {
                        throw new Error('Thiết bị từ PROVISIONED trở đi phải gắn vào một node');
                    }
                },
            },
        }
    );