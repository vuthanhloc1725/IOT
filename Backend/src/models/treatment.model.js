// Một bệnh có thể có nhiều phương pháp điều trị.
module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'Treatment',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      diseaseId: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING(150), allowNull: false },
      type: { type: DataTypes.ENUM('BIOLOGICAL', 'CHEMICAL'), allowNull: false },
      instructions: { type: DataTypes.TEXT, allowNull: false },
      activeIngredient: { type: DataTypes.STRING(120), allowNull: true },
      dosageText: { type: DataTypes.STRING(150), allowNull: true },
      intervalDays: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: { min: 1 },
      },
      sourceReference: { type: DataTypes.TEXT, allowNull: false },
    },
    {
      tableName: 'treatments',
      timestamps: false,
      validate: {
        nameNotBlank() {
          if (!String(this.name || '').trim()) throw new Error('Tên phương pháp điều trị không được để trống');
        },
        instructionsNotBlank() {
          if (!String(this.instructions || '').trim()) throw new Error('Hướng dẫn điều trị không được để trống');
        },
        sourceReferenceNotBlank() {
          if (!String(this.sourceReference || '').trim()) throw new Error('Nguồn tham khảo không được để trống');
        },
        chemicalNeedsIngredient() {
          if (this.type === 'CHEMICAL' && !String(this.activeIngredient || '').trim()) {
            throw new Error('Phương pháp hóa học phải có hoạt chất');
          }
        },
      },
    }
  );
