const { Sequelize } = require('sequelize');
const env = require('./env');

const sequelize = new Sequelize(
    env.db.name,
    env.db.user,
    env.db.pass,
    {
        host: env.db.host,
        port: env.db.port,
        dialect: 'mysql',
        timezone: '+07:00',
        logging: false,

        define: {
            timestamps: false,
            freezeTableName: true,
        },

        dialectOptions: {
            supportBigNumbers: true,
            bigNumberStrings: false,
        },
    }
);

module.exports = sequelize;
// xem lại sau để sửa