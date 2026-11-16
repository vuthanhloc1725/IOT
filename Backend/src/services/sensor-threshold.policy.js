const DEFAULT_SENSOR_THRESHOLD_RULES = Object.freeze({
  SOIL_MOISTURE: Object.freeze({ low: 25, lowRecovery: 30, high: 85, highRecovery: 80 }),
  AIR_TEMPERATURE: Object.freeze({ low: 5, lowRecovery: 8, high: 38, highRecovery: 35 }),
  AIR_HUMIDITY: Object.freeze({ low: 25, lowRecovery: 30, high: 90, highRecovery: 85 }),
});

function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const normalized = { ...rule };
  for (const key of ['low', 'lowRecovery', 'high', 'highRecovery']) {
    if (normalized[key] !== undefined && !isFiniteNumber(normalized[key])) return null;
    if (normalized[key] !== undefined) normalized[key] = Number(normalized[key]);
  }
  if (normalized.low !== undefined && normalized.lowRecovery === undefined) normalized.lowRecovery = normalized.low;
  if (normalized.high !== undefined && normalized.highRecovery === undefined) normalized.highRecovery = normalized.high;
  if (normalized.low !== undefined && normalized.lowRecovery < normalized.low) return null;
  if (normalized.high !== undefined && normalized.highRecovery > normalized.high) return null;
  if (normalized.low !== undefined && normalized.high !== undefined && normalized.low >= normalized.high) return null;
  if (normalized.low === undefined && normalized.high === undefined) return null;
  return normalized;
}

// Hysteresis: existing LOW persists until lowRecovery; existing HIGH persists until highRecovery.
// Returns LOW, HIGH, or null (normal range). If a reading jumps across the whole range, switches side.
function desiredDirection(value, rule, activeDirections = []) {
  const numeric = Number(value);
  const normalized = normalizeRule(rule);
  if (!Number.isFinite(numeric) || !normalized) return null;
  const active = new Set(activeDirections);
  if (active.has('LOW') && normalized.low !== undefined && numeric < normalized.lowRecovery) return 'LOW';
  if (active.has('HIGH') && normalized.high !== undefined && numeric > normalized.highRecovery) return 'HIGH';
  if (normalized.low !== undefined && numeric < normalized.low) return 'LOW';
  if (normalized.high !== undefined && numeric > normalized.high) return 'HIGH';
  return null;
}

module.exports = { DEFAULT_SENSOR_THRESHOLD_RULES, normalizeRule, desiredDirection };
