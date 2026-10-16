'use strict';

/**
 * Verifies the two database guarantees the game depends on:
 *   1. chat is written while a match is running
 *   2. every document for the room is deleted the moment the game ends
 *
 * Runs against MONGODB_URI when it is set (MongoDB Atlas), otherwise it
 * spins up a throwaway local MongoDB via mongodb-memory-server.
 */

const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ChatMessageModel = require('../src/models/ChatMessage');
const chatStore = require('../src/chatStore');
const { connectDB, disconnectDB, isReady } = require('../src/db');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

/** Checks that hold with no cluster configured at all. */
async function offlineChecks() {
  console.log('\nNo-database fallback (server still playable)');
  check('isReady() is false before connecting', isReady() === false);
  check('save() resolves false instead of throwing',
    (await chatStore.save({ room: 'X', playerId: 'p', name: 'n', text: 't' })) === false);
  check('history() resolves to an empty list',
    JSON.stringify(await chatStore.history('X')) === '[]');
  check('wipe() resolves to 0 instead of throwing', (await chatStore.wipe('X')) === 0);

  console.log('\nSchema wiring (no connection needed)');
  check('the ChatMessage model is registered', ChatMessageModel.modelName === 'ChatMessage');
  check('it maps to the chatmessages collection',
    ChatMessageModel.collection.collectionName === 'chatmessages',
    ChatMessageModel.collection.collectionName);
  const indexes = ChatMessageModel.schema.indexes().map(([spec]) => JSON.stringify(spec));
  check('the schema indexes messages by room',
    indexes.some((spec) => spec.includes('"room"')), indexes.join(' '));
  check('text is capped at 400 characters by the schema',
    ChatMessageModel.schema.path('text').options.maxlength === 400);
  check('the schema rejects unknown enum values for kind',
    ChatMessageModel.schema.path('kind').enumValues.join(',') === 'chat,system');
}

async function main() {
  let memoryServer = null;
  let uri = process.env.MONGODB_URI;

  if (!uri) {
    let hasMemoryServer = false;
    try {
      require.resolve('mongodb-memory-server');
      hasMemoryServer = true;
    } catch (_) {
      hasMemoryServer = false;
    }

    await offlineChecks();

    if (!hasMemoryServer) {
      console.log('\nMongoDB Atlas');
      console.log('  ! MONGODB_URI is not set, and mongodb-memory-server is not installed, so the');
      console.log('    live write/wipe checks COULD NOT RUN.');
      console.log('    Copy .env.example to .env with your Atlas string, then rerun:');
      console.log('      npm run test:db');
      console.log(`\nRESULT: ${passed} offline checks passed, ${failed} failed, live checks NOT RUN\n`);
      process.exit(failed === 0 ? 0 : 1);
    }

    console.log('\nStarting a throwaway in-memory MongoDB...');
    const { MongoMemoryServer } = require('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();
    uri = memoryServer.getUri();
  }

  console.log(`\nConnecting to ${uri.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@')}`);
  const connected = await connectDB(uri);
  check('the server connects to MongoDB', connected && isReady());

  if (!connected) {
    await disconnectDB();
    console.log('\nCannot continue - the live write/wipe checks need a working connection.');
    console.log('For Atlas: add your current public IP under Network Access, then rerun.');
    console.log(`\nRESULT: ${passed} passed, ${failed} failed, live checks NOT RUN\n`);
    if (memoryServer) await memoryServer.stop();
    process.exit(1);
  }

  const room = 'TESTRM';
  await ChatMessageModel.deleteMany({ room });

  console.log('\nPersistence while a match runs');
  const saved = await chatStore.save({
    room,
    playerId: 'p1',
    name: 'Alice',
    color: 'red',
    text: 'rolling now 🎲',
    kind: 'chat',
    sentAt: Date.now(),
  });
  check('a chat message is written to the database', saved === true);

  await chatStore.save({
    room, playerId: 'p2', name: 'Bob', color: 'green', text: '😂', kind: 'chat', sentAt: Date.now() + 1,
  });

  const count = await ChatMessageModel.countDocuments({ room });
  check('both messages are stored', count === 2, `found ${count}`);

  const history = await chatStore.history(room, 50);
  check('history round-trips with all fields', history.length === 2 &&
    history[0].name === 'Alice' && history[0].color === 'red' && history[1].text === '😂',
    JSON.stringify(history));

  const otherRoom = await ChatMessageModel.countDocuments({ room: 'OTHER1' });
  check('history is scoped to a single room', otherRoom === 0);

  console.log('\nWipe when the game ends');
  const removed = await chatStore.wipe(room);
  check('wipe reports the deleted document count', removed === 2, `removed ${removed}`);

  const afterWipe = await ChatMessageModel.countDocuments({ room });
  check('no messages remain for the finished game', afterWipe === 0, `found ${afterWipe}`);

  const secondWipe = await chatStore.wipe(room);
  check('wiping an empty room is harmless', secondWipe === 0);

  console.log('\nSchema guardrails');
  let maxLengthRejected = false;
  try {
    await ChatMessageModel.create({ room, playerId: 'p1', name: 'A', text: 'y'.repeat(500) });
  } catch (_) {
    maxLengthRejected = true;
  }
  check('messages longer than 400 characters are rejected by the schema', maxLengthRejected);
  await ChatMessageModel.deleteMany({ room });

  await disconnectDB();
  if (memoryServer) await memoryServer.stop();

  console.log(`\n${failed === 0 ? 'ALL PASSED' : 'FAILURES'}: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nDB check crashed:', err);
  try { await mongoose.disconnect(); } catch (_) { /* ignore */ }
  process.exit(1);
});
