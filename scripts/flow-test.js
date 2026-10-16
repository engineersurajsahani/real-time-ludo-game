'use strict';

/**
 * End-to-end check for the realtime Ludo server.
 *
 * Boots `server.js` on a spare port, then drives real socket.io clients
 * through: lobby rules -> 2-player minimum -> chat fan-out -> a full match
 * -> chat wipe on game over. Reports PASS/FAIL per assertion.
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { io } = require('socket.io-client');

// Pick up .env so the database checks run automatically once Atlas is set up.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = Number(process.env.TEST_PORT || 4319);
const BASE = `http://127.0.0.1:${PORT}`;
const HAS_DB = Boolean(process.env.MONGODB_URI);

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll an async predicate until it returns a truthy value. */
async function pollAsync(fn, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(120);
  }
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    http
      .get(`${BASE}${pathname}`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

function connect(name) {
  const socket = io(BASE, { transports: ['websocket'], forceNew: true });
  const client = {
    name,
    socket,
    id: null,
    color: null,
    room: null,
    messages: [],
    rolled: [],
    moved: [],
    chatCleared: 0,
    notices: [],
    gameOver: null,
    /** Emit expecting an ack from the server. */
    emit(event, payload) {
      return new Promise((resolve) => {
        if (payload === undefined) socket.emit(event, resolve);
        else socket.emit(event, payload, resolve);
      });
    },
    /** Fire-and-forget emit (game actions have no ack). */
    fire(event, payload) {
      if (payload === undefined) socket.emit(event);
      else socket.emit(event, payload);
    },
  };

  socket.on('room:update', (room) => {
    client.room = room;
    const self = room.players.find((p) => p.id === client.id);
    if (self) client.color = self.color;
  });
  socket.on('chat:message', (message) => client.messages.push(message));
  socket.on('chat:sync', (payload) => { client.messages = payload.messages || []; });
  socket.on('chat:cleared', () => { client.chatCleared += 1; client.messages = []; });
  socket.on('game:rolled', (event) => client.rolled.push(event));
  socket.on('game:moved', (event) => client.moved.push(event));
  socket.on('game:over', (event) => { client.gameOver = event; });
  socket.on('notice', (event) => client.notices.push(event));

  return client;
}

function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try { value = fn(); } catch (_) { value = false; }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

/**
 * Auto-player: rolls on its turn and always takes a legal move.
 *
 * Paced deliberately: the server rate-limits game actions to 100 per 5s, and
 * the point of the bots is to play like impatient humans, not to flood.
 */
const BOT_PACE_MS = Number(process.env.BOT_PACE_MS || 80);

function autoplay(client, stats) {
  let rollQueued = false;

  client.socket.on('room:update', (room) => {
    if (room.status !== 'playing' || !room.game) return;
    if (room.game.turnPlayerId !== client.id) return;
    if (room.game.awaitingMove) return;
    if (rollQueued) return;
    rollQueued = true;
    setTimeout(() => {
      rollQueued = false;
      client.fire('game:roll');
    }, BOT_PACE_MS);
  });

  client.socket.on('game:rolled', (event) => {
    if (event.color !== client.color) return;
    stats.rolls += 1;
    if (!event.moves || !event.moves.length) return;
    const pick = event.moves[Math.floor(Math.random() * event.moves.length)];
    setTimeout(() => client.fire('game:move', { tokenIndex: pick }), BOT_PACE_MS);
  });

  // Surface throttling instead of silently stalling the match.
  client.socket.on('notice', (notice) => {
    if (/slow down/i.test(notice.message || '')) stats.throttled += 1;
  });
}

async function boot() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await get('/health');
      if (res.status === 200) return { child, logs, health: JSON.parse(res.body) };
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }

  child.kill();
  throw new Error(`server did not boot:\n${logs.join('')}`);
}

async function main() {
  console.log('\nBooting server on port', PORT, '...');
  const { child, logs, health } = await boot();
  console.log('Server up. Database:', health.database, '\n');

  const clients = [];

  try {
    /* ---------------------------------------------------------------- */
    console.log('HTTP layer');
    const page = await get('/');
    check('GET / serves the game shell', page.status === 200 && /Ludo Royale/.test(page.body), `status ${page.status}`);
    const boardJs = await get('/js/board.js');
    check('GET /js/board.js is served', boardJs.status === 200 && /LudoBoard/.test(boardJs.body));
    const css = await get('/css/style.css');
    check('GET /css/style.css is served', css.status === 200 && /perspective/.test(css.body));
    check('/health reports a database mode', ['connected', 'memory-only'].includes(health.database), health.database);

    /* ---------------------------------------------------------------- */
    console.log('\nLobby rules');
    const alice = connect('Alice');
    const bob = connect('Bob');
    clients.push(alice, bob);

    const created = await alice.emit('room:create', { name: 'Alice' });
    check('a room can be created', created.ok === true, JSON.stringify(created));
    check('the server issues the identity (id + secret token)',
      typeof created.playerId === 'string' && typeof created.token === 'string' && created.token.length >= 40,
      `id=${created.playerId} tokenLen=${created.token && created.token.length}`);
    alice.id = created.playerId;
    const roomId = created.roomId;
    check('room code is 5 characters', typeof roomId === 'string' && roomId.length === 5, roomId);

    await sleep(150);
    const soloStart = await alice.emit('room:start');
    check('a solo player cannot start (needs 2)', soloStart.ok === false, JSON.stringify(soloStart));

    const joined = await bob.emit('room:join', { roomId, name: 'Bob' });
    check('a second player can join with the code', joined.ok === true, JSON.stringify(joined));
    bob.id = joined.playerId;

    const ghost = connect('Ghost');
    clients.push(ghost);
    const badJoin = await ghost.emit('room:join', { roomId: 'ZZZZZ', name: 'Ghost' });
    check('joining a missing room is rejected', badJoin.ok === false, JSON.stringify(badJoin));

    await sleep(200);
    check('both players are seated', alice.room.players.filter((p) => !p.spectator).length === 2);
    check('seats get distinct colours',
      alice.room.players[0].color === 'red' && alice.room.players[1].color === 'green',
      alice.room.players.map((p) => p.color).join(','));

    /* ---------------------------------------------------------------- */
    console.log('\nChat while the game runs');
    const sent = await alice.emit('chat:send', { text: 'hello from Alice 👋' });
    check('a chat message is accepted', sent.ok === true, JSON.stringify(sent));
    await waitFor(() => bob.messages.some((m) => m.text === 'hello from Alice 👋'), 2000, 'chat fan-out');
    check('the message reaches the other player', true);
    const emojiMsg = await bob.emit('chat:send', { text: '🎲🎲' });
    check('an emoji-only message is accepted', emojiMsg.ok === true);
    await waitFor(() => alice.messages.some((m) => m.text === '🎲🎲'), 2000, 'emoji fan-out');
    check('emoji chat fans out', true);

    const bomb = 'x'.repeat(900);
    const longSend = await alice.emit('chat:send', { text: bomb });
    check('oversized messages are truncated, not rejected', longSend.ok === true);
    await waitFor(() => bob.messages.some((m) => m.text.length === 300), 2000, 'truncation');
    check('message body is capped at 300 characters', true);

    /* ---------------------------------------------------------------- */
    console.log('\nTurn enforcement');
    bob.fire('game:roll');
    await sleep(180);
    check('rolling before the game starts is refused',
      bob.notices.some((n) => /not running/i.test(n.message)), JSON.stringify(bob.notices));

    const started = await alice.emit('room:start');
    check('the host can start with 2 players', started.ok === true, JSON.stringify(started));
    await waitFor(() => alice.room.status === 'playing', 2000, 'game start');
    check('status flips to playing', alice.room.status === 'playing');

    bob.notices.length = 0;
    bob.fire('game:roll');
    await sleep(180);
    check('the non-active player cannot roll', bob.notices.some((n) => /not your turn/i.test(n.message)),
      JSON.stringify(bob.notices));

    /* ---------------------------------------------------------------- */
    console.log('\nChat stored in the database while the match runs');
    const midGame = await alice.emit('chat:send', { text: 'good luck everyone 🍀' });
    check('a mid-match message is accepted', midGame.ok === true, JSON.stringify(midGame));

    let db = null;
    if (HAS_DB) {
      const mongoose = require('mongoose');
      try {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
        db = mongoose.connection.collection('chatmessages');
      } catch (err) {
        check('the test can open its own connection to inspect Atlas', false,
          String(err.message).split('\n')[0]);
        console.log('  ! is your current IP allowed under Atlas -> Network Access?');
      }
    }

    if (db) {
      const stored = await pollAsync(
        () => db.countDocuments({ room: roomId }),
        10000,
        'mid-match message stored'
      );
      check('the mid-match message is written to MongoDB', stored >= 1, `found ${stored}`);

      const doc = await db.findOne({ room: roomId });
      check('the stored document carries the room, author and text',
        !!doc && doc.room === roomId && doc.name === 'Alice' && doc.text === 'good luck everyone 🍀',
        JSON.stringify(doc));
    } else if (!HAS_DB) {
      console.log('  ! MONGODB_URI not set - database checks skipped for this run.');
    }

    /* ---------------------------------------------------------------- */
    console.log('\nFull match');
    const stats = { rolls: 0, throttled: 0 };
    autoplay(alice, stats);
    autoplay(bob, stats);

    alice.fire('game:roll');
    await waitFor(() => alice.gameOver || bob.gameOver, 120000, 'match completion');

    const over = alice.gameOver;
    check('the game reports a winner', !!over && !!over.winner, JSON.stringify(over));
    check('the winner is one of the players', over && ['Alice', 'Bob'].includes(over.winner.name));
    check('tokens really moved during the match', stats.rolls > 10, `rolls: ${stats.rolls}`);
    check('normal play never trips the anti-flood limiter', stats.throttled === 0,
      `${stats.throttled} throttled actions`);
    check('both clients saw every move broadcast',
      alice.moved.length > 5 && alice.moved.length === bob.moved.length,
      `${alice.moved.length} vs ${bob.moved.length}`);
    check('tokens left the yard during the match',
      alice.moved.some((m) => m.from === -1), 'no token was ever released');

    const winnerTokens = over && alice.room.game.tokens[over.winner.color];
    check('the winning colour has all four tokens home',
      !!winnerTokens && winnerTokens.every((t) => t === 57), JSON.stringify(winnerTokens));

    /* ---------------------------------------------------------------- */
    console.log('\nChat wiped on game over');
    await waitFor(() => alice.chatCleared > 0 && bob.chatCleared > 0, 3000, 'chat:cleared broadcast');
    check('every client is told the history was deleted', alice.chatCleared > 0 && bob.chatCleared > 0);
    check('the client-side history is empty afterwards', alice.messages.length === 0 && bob.messages.length === 0);

    await sleep(300);
    const afterSend = await alice.emit('chat:send', { text: 'post-game message' });
    check('chat still works after the wipe', afterSend.ok === true);
    check('post-game chat is not stored while status != playing',
      alice.room.status === 'over', alice.room.status);

    if (db) {
      await pollAsync(async () => (await db.countDocuments({ room: roomId })) === 0, 10000,
        'room documents deleted');
      const remaining = await db.countDocuments({ room: roomId });
      check('every chat document for the finished game is deleted from MongoDB', remaining === 0,
        `found ${remaining}`);
    }

    /* ---------------------------------------------------------------- */
    console.log('\nSeating: 4 players max, extras spectate');
    const carol = connect('Carol');
    const dave = connect('Dave');
    const erin = connect('Erin');
    clients.push(carol, dave, erin);

    const r2 = await carol.emit('room:create', { name: 'Carol' });
    carol.id = r2.playerId;
    for (const client of [dave, erin]) {
      const res = await client.emit('room:join', { roomId: r2.roomId, name: client.name });
      client.id = res.playerId;
    }
    await sleep(250);
    check('three players are seated', carol.room.players.filter((p) => !p.spectator).length === 3,
      JSON.stringify(carol.room.players.map((p) => [p.name, p.color, p.spectator])));
    check('colours follow seat order', carol.room.players.map((p) => p.color).join(',') === 'red,green,yellow',
      carol.room.players.map((p) => p.color).join(','));

    const started3 = await carol.emit('room:start');
    check('a 3-player game can start', started3.ok === true, JSON.stringify(started3));
    await waitFor(() => carol.room.status === 'playing', 2000, '3p start');

    const frank = connect('Frank');
    clients.push(frank);
    const late = await frank.emit('room:join', { roomId: r2.roomId, name: 'Frank' });
    frank.id = late.playerId;
    await sleep(250);
    check('a late joiner becomes a spectator', late.seated === false, JSON.stringify(late));
    const frankSeat = carol.room.players.find((p) => p.name === 'Frank');
    check('the spectator has no colour', frankSeat && frankSeat.spectator === true && !frankSeat.color);
    check('seated players are unchanged', carol.room.players.filter((p) => !p.spectator).length === 3);

    frank.fire('game:roll');
    await sleep(180);
    check('a spectator cannot roll the dice', frank.notices.some((n) => /not your turn/i.test(n.message)),
      JSON.stringify(frank.notices));

    /* ---------------------------------------------------------------- */
    console.log('\nFour-player table');
    const four = [connect('P1'), connect('P2'), connect('P3'), connect('P4')];
    clients.push(...four);

    const r4 = await four[0].emit('room:create', { name: 'P1' });
    four[0].id = r4.playerId;
    for (let i = 1; i < four.length; i += 1) {
      const res = await four[i].emit('room:join', {
        roomId: r4.roomId,
        name: `P${i + 1}`,
      });
      four[i].id = res.playerId;
    }
    await sleep(350);

    check('all four players are seated',
      four[0].room.players.filter((p) => !p.spectator).length === 4,
      JSON.stringify(four[0].room.players.map((p) => [p.name, p.color, p.spectator])));
    check('all four colours are dealt out',
      four[0].room.players.map((p) => p.color).join(',') === 'red,green,yellow,blue',
      four[0].room.players.map((p) => p.color).join(','));

    const started4 = await four[0].emit('room:start');
    check('a 4-player game can start', started4.ok === true, JSON.stringify(started4));
    await waitFor(() => four[0].room.status === 'playing', 2000, '4p start');

    const gameTokens = four[0].room.game.tokens;
    check('the engine tracks 4 tokens for each of the 4 colours',
      Object.keys(gameTokens).length === 4 &&
      Object.values(gameTokens).every((t) => Array.isArray(t) && t.length === 4),
      JSON.stringify(gameTokens));

    four.forEach((client) => {
      client.turnColors = new Set();
      client.socket.on('room:update', (room) => {
        if (room.game && room.status === 'playing') client.turnColors.add(room.game.turnColor);
      });
    });

    const stats4 = { rolls: 0, throttled: 0 };
    four.forEach((client) => autoplay(client, stats4));
    four[0].fire('game:roll');

    await waitFor(() => four[0].turnColors.size === 4, 40000, 'turn rotation across four colours');
    check('the turn rotates through all four colours',
      four[0].turnColors.size === 4, [...four[0].turnColors].join(','));
    check('the four-player match keeps running',
      four[0].room.status === 'playing' && !four[0].gameOver, four[0].room.status);
    check('every player is still at a distinct colour after play started',
      new Set(four[0].room.players.filter((p) => !p.spectator).map((p) => p.color)).size === 4);

    /* ---------------------------------------------------------------- */
    if (db) {
      await require('mongoose').disconnect();
      console.log('\nMongoDB Atlas persistence + wipe verified.');
    }
  } finally {
    clients.forEach((client) => client.socket.close());
    await sleep(200);
    child.kill();
  }

  console.log(`\n${failed === 0 ? 'ALL PASSED' : 'FAILURES'}: ${passed} passed, ${failed} failed\n`);
  if (failed) {
    console.log('server log tail:\n' + logs.slice(-12).join(''));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
