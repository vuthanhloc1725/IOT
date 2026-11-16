const test = require('node:test');
const assert = require('node:assert/strict');
const { createWithGeneratedCode } = require('../src/services/code-generator');

test('generates a server-side Node code and persists it with other fields', async () => {
  let saved;
  const Model = {
    findOne: async () => null,
    create: async (values) => { saved = values; return values; },
  };
  const result = await createWithGeneratedCode({ prefix: 'NODE', Model, field: 'nodeCode', values: { name: 'Greenhouse A' } });
  assert.match(result.code, /^NODE-[A-F0-9]{16}$/);
  assert.equal(saved.nodeCode, result.code);
  assert.equal(saved.name, 'Greenhouse A');
});

test('retries when a concurrent insert wins the unique-code race', async () => {
  let attempts = 0;
  let firstCode;
  const Model = {
    findOne: async () => null,
    create: async (values) => {
      attempts += 1;
      if (attempts === 1) {
        firstCode = values.deviceCode;
        const error = new Error('unique conflict');
        error.name = 'SequelizeUniqueConstraintError';
        error.fields = { deviceCode: firstCode };
        throw error;
      }
      return values;
    },
  };
  const result = await createWithGeneratedCode({ prefix: 'DEV', Model, field: 'deviceCode', values: { name: 'Soil sensor' } });
  assert.equal(attempts, 2);
  assert.match(result.code, /^DEV-[A-F0-9]{16}$/);
  assert.notEqual(result.code, firstCode);
});
