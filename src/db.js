'use strict';

const mongoose = require('mongoose');

/** True once MongoDB Atlas has accepted the connection. */
let ready = false;

/**
 * Connect to MongoDB Atlas.
 *
 * The game stays fully playable without a database: chat simply stops being
 * persisted and a warning is logged, which keeps local development unblocked.
 *
 * @param {string|undefined} uri
 * @returns {Promise<boolean>} whether the connection succeeded
 */
async function connectDB(uri) {
  if (!uri) {
    console.warn(
      '[db] MONGODB_URI is not set - running with in-memory chat only.\n' +
        '     Add it to .env to persist chat to MongoDB Atlas.'
    );
    return false;
  }

  mongoose.connection.on('connected', () => {
    ready = true;
  });
  mongoose.connection.on('disconnected', () => {
    ready = false;
    console.warn('[db] MongoDB disconnected.');
  });
  mongoose.connection.on('error', (err) => {
    console.error('[db] MongoDB error:', err.message);
  });

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      // Nice-to-have for small dev clusters.
      maxPoolSize: 10,
    });
    ready = true;
    console.log('[db] Connected to MongoDB Atlas.');
    return true;
  } catch (err) {
    ready = false;
    console.error('[db] Could not connect to MongoDB Atlas:', err.message);
    console.error('[db] Continuing in in-memory chat mode.');
    return false;
  }
}

function isReady() {
  return ready && mongoose.connection.readyState === 1;
}

async function disconnectDB() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  ready = false;
}

module.exports = { connectDB, disconnectDB, isReady };
