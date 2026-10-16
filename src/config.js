'use strict';

/**
 * Central environment configuration.
 *
 * Everything the app needs at runtime is read once, validated once, and then
 * treated as immutable. Production misconfiguration fails loudly at boot
 * instead of silently degrading later.
 */

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseSize(value, fallback) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? size : fallback;
}

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

const config = {
  env,
  isProd,

  port: parseSize(process.env.PORT, 3000),

  /** MongoDB Atlas connection string. Empty means "memory-only chat". */
  mongoUri: (process.env.MONGODB_URI || '').trim(),

  /** Extra browser origins allowed to open a websocket (comma separated). */
  allowedOrigins: parseList(process.env.ALLOWED_ORIGINS),

  /** Render/most PaaS sit behind one proxy hop - needed for real client IPs. */
  trustProxy: parseBool(process.env.TRUST_PROXY, isProd),

  socket: {
    maxHttpBufferSize: parseSize(process.env.SOCKET_MAX_BUFFER, 64 * 1024),
    pingInterval: 20000,
    pingTimeout: 25000,
    maxConnectionsPerRoom: parseSize(process.env.MAX_ROOM_CONNECTIONS, 12),
    /** Concurrent sockets one address may hold open. */
    maxConnectionsPerIp: parseSize(process.env.MAX_IP_CONNECTIONS, 20),
  },

  rooms: {
    /** Hard ceiling so a flood cannot exhaust memory. */
    maxRooms: parseSize(process.env.MAX_ROOMS, 500),
    maxPlayers: 4,
    minPlayers: 2,
    idleTtlMs: 1000 * 60 * 60 * 2,
  },

  limits: {
    http: { windowMs: 60_000, max: 300 },
    roomCreate: { windowMs: 60_000, max: 6 },
    roomJoin: { windowMs: 60_000, max: 30 },
    chat: { windowMs: 5_000, max: 8 },
    // A human cannot comfortably exceed ~3 actions/second; 20/s still leaves
    // plenty of headroom while capping a scripted flood.
    gameAction: { windowMs: 5_000, max: 100 },
    messageLength: 300,
    nameLength: 18,
  },
};

/**
 * Validate the combination of settings.
 * @returns {string[]} fatal problems
 */
function validate() {
  const problems = [];

  if (config.mongoUri && !/^mongodb(\+srv)?:\/\//.test(config.mongoUri)) {
    problems.push('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  }

  if (isProd && !config.mongoUri && !parseBool(process.env.ALLOW_MEMORY_CHAT, false)) {
    problems.push(
      'MONGODB_URI is required in production (chat would not be persisted). ' +
        'Set ALLOW_MEMORY_CHAT=true to run without a database on purpose.'
    );
  }

  if (isProd && config.allowedOrigins.some((origin) => origin === '*')) {
    problems.push('ALLOWED_ORIGINS must not contain "*" in production.');
  }

  return problems;
}

/** Origins the Socket.IO server should accept. */
function corsOrigin() {
  if (config.allowedOrigins.length) return config.allowedOrigins;
  // Same-origin only in production: the client is served by this very process,
  // so no cross-origin browser request is legitimate.
  return isProd ? false : true;
}

module.exports = { config, validate, corsOrigin };
