const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const MAC_RE = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_TTL_MS = 30 * 60 * 1000;

function normalizeMac(value) {
    if (typeof value !== 'string') return null;
    const mac = value.trim().replace(/-/g, ':').toUpperCase();
    if (!MAC_RE.test(mac) || (parseInt(mac.slice(0, 2), 16) & 1) || mac === '00:00:00:00:00:00') return null;
    return mac;
}

function tokenHash(token) {
    return createHash('sha256').update(token).digest('hex');
}

function issueToken() {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: tokenHash(token), expiresAt: new Date(Date.now() + TOKEN_TTL_MS) };
}

function matchesToken(token, expectedHash) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token) || !/^[a-f0-9]{64}$/.test(expectedHash || '')) return false;
    return timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(expectedHash, 'hex'));
}

module.exports = { normalizeMac, issueToken, matchesToken };
