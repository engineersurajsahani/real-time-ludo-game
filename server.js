'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { config, validate, corsOrigin } = require('./src/config');
const { securityHeaders, RateLimiter, httpRateLimit } = require('./src/security');
const { connectDB, disconnectDB, isReady } = require('./src/db');
const RoomManager = require('./src/game/roomManager');
const registerSocketHandlers = require('./src/socketHandlers');

const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------------------------------------------------------------- config */

const problems = validate();
if (problems.length) {
  console.error('\n[server] Refusing to start - configuration problems:');
  problems.forEach((problem) => console.error(`  - ${problem}`));
  console.error('');
  process.exit(1);
}

/* ------------------------------------------------------------------- app */

const app = express();

app.disable('x-powered-by');
// Render (and most PaaS) terminate TLS one hop in front of us, so the client
// IP in X-Forwarded-For is only trustworthy when this is enabled.
app.set('trust proxy', config.trustProxy ? 1 : false);
app.set('etag', 'strong');

app.use(securityHeaders);
app.use(express.json({ limit: '32kb' }));

const httpLimiter = new RateLimiter({ ...config.limits.http, name: 'http' });

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin(),
    methods: ['GET', 'POST'],
    credentials: false,
  },
  pingInterval: config.socket.pingInterval,
  pingTimeout: config.socket.pingTimeout,
  maxHttpBufferSize: config.socket.maxHttpBufferSize,
  transports: ['websocket', 'polling'],
  allowEIO3: false,
});

const rooms = new RoomManager(io);
const sockets = registerSocketHandlers(io, rooms);

/* ----------------------------------------------------------------- static */

app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders(res, filePath) {
      // HTML revalidates every load so a deploy is picked up immediately;
      // css/js carry strong ETags, so revalidation is a cheap 304.
      res.setHeader(
        'Cache-Control',
        filePath.endsWith('.html')
          ? 'no-cache, must-revalidate'
          : 'public, max-age=0, must-revalidate'
      );
    },
  })
);

/* ----------------------------------------------------------------- routes */

/** Liveness probe - answers whenever the process is up. */
app.get('/health', httpRateLimit(httpLimiter), (req, res) => {
  const stats = rooms.stats();
  res.json({
    status: 'ok',
    env: config.env,
    uptime: Math.round(process.uptime()),
    database: isReady() ? 'connected' : 'memory-only',
    rooms: stats,
  });
});

// Anything else is a genuine 404 rather than a blanket 200.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Express identifies error handlers by their four-argument signature.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  console.error('[http] unhandled error:', (err && err.message) || err);
  return res.status(500).json({ error: 'Internal server error' });
});

/* ---------------------------------------------------------------- startup */

function start() {
  server.listen(config.port, () => {
    console.log(
      [
        '',
        '  🎲  Real-Time Ludo',
        `  ➜  Env:     ${config.env}`,
        `  ➜  Local:   http://localhost:${config.port}`,
        '',
      ].join('\n')
    );
  });

  connectDB(config.mongoUri)
    .then((connected) => {
      console.log(
        connected
          ? '[db] Chat storage: MongoDB Atlas (wiped when a match ends)\n'
          : '[db] Chat storage: memory only - chat will not be persisted\n'
      );
    })
    .catch((err) => console.error('[db] Unexpected connection error:', err.message));
}

/* --------------------------------------------------------------- shutdown */

let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${reason} received - draining connections.`);

  const done = async () => {
    try {
      sockets.stop();
      rooms.shutdown();
      await disconnectDB();
    } catch (err) {
      console.error('[server] shutdown error:', err.message);
    }
    process.exit(0);
  };

  io.close(() => console.log('[server] realtime connections closed.'));
  server.close(() => {});
  done();

  // Never hang a deploy: hard exit if draining takes too long.
  setTimeout(() => process.exit(0), 8000).unref();
}

['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  // Leaving the process alive after an unknown failure is worse than letting
  // the platform restart a clean one.
  console.error('[server] uncaught exception:', err);
  shutdown('uncaughtException');
});

try {
  start();
} catch (err) {
  console.error('[server] Failed to start:', err);
  process.exit(1);
}

module.exports = { app, server, io, rooms };
