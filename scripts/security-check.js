'use strict';

/**
 * Security checks.
 *
 * Boots several isolated server instances in production mode and probes the
 * hardening: response headers, CSP, cross-origin access, rate limits, the
 * server-issued identity (seat hijacking), input validation and connection
 * caps. Nothing is asserted by reading the source - every check talks to a
 * running server.
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { io } = require('socket.io-client');

const SERVER = path.join(__dirname, '..', 'server.js');

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

function request(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(port, timeoutMs = 25000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await request(port, '/health');
      if (res.status === 200) return;
    } catch (_) { /* not up yet */ }
    if (Date.now() - started > timeoutMs) throw new Error(`server on ${port} never came up`);
    await sleep(200);
  }
}

/** Boot one server instance with an isolated environment. */
async function boot(port, env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  await waitForServer(port);
  return { child, port, logs, close: () => child.kill() };
}

/** Connect a socket and resolve once it is live. */
function connect(port) {
  const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
  const client = {
    socket,
    id: null,
    token: null,
    room: null,
    messages: [],
    connected: false,
    error: null,
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
    close() { socket.close(); },
  };
  socket.on('connect', () => { client.connected = true; });
  socket.on('connect_error', (err) => { client.error = err.message; });
  socket.on('room:update', (room) => { client.room = room; });
  socket.on('chat:message', (m) => client.messages.push(m));
  socket.on('chat:sync', (p) => { client.messages = p.messages || []; });
  return client;
}

async function waitConnected(client, timeoutMs = 8000) {
  const started = Date.now();
  while (!client.connected && !client.error) {
    if (Date.now() - started > timeoutMs) throw new Error('socket never connected');
    await sleep(50);
  }
  return client;
}

async function main() {
  console.log('\n=== hardening (production mode) ===');
  const main = await boot(4488, {
    NODE_ENV: 'production',
    ALLOW_MEMORY_CHAT: 'true',
    ALLOWED_ORIGINS: '',
  });

  const clients = [];
  try {
    /* ---------------------------------------------------------- headers */
    console.log('\nResponse headers');
    const page = await request(main.port, '/');
    const csp = page.headers['content-security-policy'] || '';

    check('the app is served over HTTP 200', page.status === 200, String(page.status));
    check('the server name is not advertised', page.headers['x-powered-by'] === undefined);
    check('a Content-Security-Policy is set', csp.length > 0);
    check('CSP locks the default source to self', csp.includes("default-src 'self'"), csp);
    check('CSP locks scripts to self', csp.includes("script-src 'self'"), csp);
    check('CSP forbids inline scripts and eval',
      !csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'"), csp);
    check('CSP blocks framing', csp.includes("frame-ancestors 'none'"), csp);
    check('CSP blocks plugins', csp.includes("object-src 'none'"), csp);
    check('plain HTTP does not force an upgrade on a local deployment',
      !csp.includes('upgrade-insecure-requests'), csp);
    check('X-Content-Type-Options is nosniff',
      page.headers['x-content-type-options'] === 'nosniff');
    check('X-Frame-Options is DENY', page.headers['x-frame-options'] === 'DENY');
    check('Referrer-Policy limits leakage',
      page.headers['referrer-policy'] === 'no-referrer', page.headers['referrer-policy']);
    check('HSTS is not advertised before TLS is in play',
      page.headers['strict-transport-security'] === undefined);
    check('a Permissions-Policy is set',
      String(page.headers['permissions-policy'] || '').includes('geolocation=()'));

    // Simulate the Render proxy: an HTTPS request arriving on the internal hop.
    const proxied = await request(main.port, '/', { 'X-Forwarded-Proto': 'https' });
    const proxiedCsp = proxied.headers['content-security-policy'] || '';
    check('CSP upgrades insecure requests once the page is served over HTTPS',
      proxiedCsp.includes('upgrade-insecure-requests'), proxiedCsp);
    check('HSTS is sent when the request arrived over HTTPS',
      String(proxied.headers['strict-transport-security'] || '').includes('max-age='), 
      String(proxied.headers['strict-transport-security'] || 'absent'));

    /* ------------------------------------------------------------ CORS */
    console.log('\nCross-origin access');
    const evil = await request(main.port, '/', { Origin: 'https://evil.example' });
    check('the app is not exposed cross-origin',
      evil.headers['access-control-allow-origin'] === undefined,
      String(evil.headers['access-control-allow-origin']));

    const handshake = await request(
      main.port,
      '/socket.io/?EIO=4&transport=polling',
      { Origin: 'https://evil.example' }
    );
    check('the websocket handshake is not opened up cross-origin',
      handshake.headers['access-control-allow-origin'] === undefined,
      String(handshake.headers['access-control-allow-origin']));

    /* ------------------------------------------------------------- 404 */
    console.log('\nUnexpected paths');
    const missing = await request(main.port, '/admin/config.json');
    check('unknown paths return 404 instead of the app shell', missing.status === 404,
      String(missing.status));
    const health = await request(main.port, '/health');
    check('/health still answers with JSON',
      health.status === 200 && JSON.parse(health.body).status === 'ok');

    /* -------------------------------------------------------- identity */
    console.log('\nPlayer identity');
    const alice = await waitConnected(connect(main.port));
    clients.push(alice);

    const created = await alice.emit('room:create', { name: 'Alice' });
    check('a room is created', created.ok === true, JSON.stringify(created));
    alice.id = created.playerId;
    alice.token = created.token;

    check('the server issues the player id, not the client',
      typeof created.playerId === 'string' && /^p_[\w-]{10,}$/.test(created.playerId),
      created.playerId);
    check('a long secret session token is issued',
      typeof created.token === 'string' && created.token.length >= 40,
      created.token ? `${created.token.length} chars` : 'missing');

    const roomJson = JSON.stringify(alice.room || {});
    check('the session token is never broadcast to the table',
      !roomJson.includes(created.token));

    // Reconnecting with the right pair reclaims the seat instead of duplicating.
    const aliceAgain = await waitConnected(connect(main.port));
    clients.push(aliceAgain);
    const rejoin = await aliceAgain.emit('room:join', {
      roomId: created.roomId,
      name: 'Alice',
      playerId: alice.id,
      token: alice.token,
    });
    check('a client with id + token reclaims its own seat',
      rejoin.ok === true && rejoin.playerId === alice.id, JSON.stringify(rejoin));
    await sleep(200);
    check('reclaiming a seat does not add a second player',
      aliceAgain.room.players.length === 1,
      `${aliceAgain.room.players.length} players`);

    // The attack: claim somebody else's id without their secret.
    const attacker = await waitConnected(connect(main.port));
    clients.push(attacker);
    const hijack = await attacker.emit('room:join', {
      roomId: created.roomId,
      name: 'Mallory',
      playerId: alice.id,
      token: 'not-the-real-token',
    });
    check('claiming another player\'s id without the token is refused',
      hijack.ok === true && hijack.playerId !== alice.id, JSON.stringify(hijack));
    await sleep(200);
    const aliceSeat = attacker.room.players.find((p) => p.id === alice.id);
    check('the original seat is untouched by the hijack attempt',
      !!aliceSeat && aliceSeat.name === 'Alice', JSON.stringify(aliceSeat));
    check('the hijack attempt gets a fresh identity instead',
      attacker.room.players.some((p) => p.id === hijack.playerId),
      hijack.playerId);

    const forgedIds = await Promise.all([
      alice.emit('room:create', { name: 'X', playerId: 'p_FAKE000000000000', token: 'x'.repeat(43) }),
    ]);
    check('a forged id/token pair is not honoured',
      forgedIds[0].playerId !== 'p_FAKE000000000000', JSON.stringify(forgedIds[0]));

    /* ------------------------------------------------------ validation */
    console.log('\nInput validation');
    const badCode = await attacker.emit('room:join', { roomId: '<script>', name: 'Bob' });
    check('malformed room codes are rejected', badCode.ok === false, JSON.stringify(badCode));

    const shortCode = await attacker.emit('room:join', { roomId: 'AB', name: 'Bob' });
    check('short room codes are rejected', shortCode.ok === false, JSON.stringify(shortCode));

    const longName = await attacker.emit('room:create', {
      name: 'N'.repeat(200),
    });
    const bob = await waitConnected(connect(main.port));
    clients.push(bob);
    await bob.emit('room:join', {
      roomId: longName.roomId,
      name: 'B'.repeat(200),
    });
    await sleep(200);
    const longest = Math.max(...bob.room.players.map((p) => p.name.length));
    check('player names are capped at 18 characters', longest <= 18, String(longest));

    const spam = await bob.emit('chat:send', {
      text: 'hi\u202Egnp\u0007\u0000 there\u200B friend',
    });
    check('a chat message with control characters is accepted', spam.ok === true);
    await sleep(200);
    const received = bob.messages[bob.messages.length - 1];
    check('control characters and bidi overrides are stripped from chat',
      !!received && !/[\u0000-\u001F\u202A-\u202E\u200B-\u200F]/.test(received.text),
      received ? JSON.stringify(received.text) : 'no message');
    check('harmless text survives sanitising',
      !!received && received.text.includes('there') && received.text.includes('friend'),
      received ? received.text : '');

    const huge = await bob.emit('chat:send', { text: 'z'.repeat(5000) });
    check('oversized chat is truncated rather than exploding storage', huge.ok === true);
    await sleep(200);
    const truncated = bob.messages[bob.messages.length - 1];
    check('the stored message respects the 300 character cap',
      !!truncated && truncated.text.length <= 300, truncated ? String(truncated.text.length) : '');

    const beforeBadMove = JSON.stringify(bob.room.game ? bob.room.game.tokens : null);
    bob.fire('game:move', { tokenIndex: 'DROP TABLE' });
    await sleep(250);
    check('a non-numeric token index is refused without moving anything',
      JSON.stringify(bob.room.game ? bob.room.game.tokens : null) === beforeBadMove);
  } finally {
    clients.forEach((c) => c.close());
    main.close();
    await sleep(300);
  }

  /* --------------------------------------------------------- rate limits */
  console.log('\n=== rate limits ===');
  const rl = await boot(4489, {
    NODE_ENV: 'production',
    ALLOW_MEMORY_CHAT: 'true',
    ALLOWED_ORIGINS: '',
  });
  const rlClients = [];
  try {
    // Chat first: the room-spam limiter below deliberately exhausts its budget.
    const chatRl = await waitConnected(connect(rl.port));
    rlClients.push(chatRl);
    const room = await chatRl.emit('room:create', { name: 'Chatty' });
    check('a room is available for the chat test', room.ok === true, JSON.stringify(room));
    if (room.ok) {
      const burst = [];
      for (let i = 0; i < 14; i += 1) {
        burst.push(await chatRl.emit('chat:send', { text: `msg ${i}` }));
      }
      const chatFailures = burst.filter((res) => !res.ok).length;
      check('chat flooding per socket is throttled', chatFailures > 0, `${chatFailures} refused`);
      check('normal chat still gets through', burst.some((res) => res.ok));
    } else {
      check('chat flooding per socket is throttled', false, 'could not open a room');
      check('normal chat still gets through', false, 'could not open a room');
    }

    const client = await waitConnected(connect(rl.port));
    rlClients.push(client);

    let allowed = 0;
    let refused = null;
    for (let i = 0; i < 12; i += 1) {
      const res = await client.emit('room:create', { name: `P${i}` });
      if (res.ok) allowed += 1;
      else if (!refused) refused = res.error;
    }
    check('rapid room creation is eventually throttled', refused !== null,
      `allowed=${allowed}`);
    check('the room-spam limiter reports why', /too many rooms/i.test(refused || ''), String(refused));
    check('a few rooms are still allowed through', allowed > 0 && allowed <= 8, String(allowed));
  } finally {
    rlClients.forEach((c) => c.close());
    rl.close();
    await sleep(300);
  }

  /* ------------------------------------------------------ connection cap */
  console.log('\n=== connection limits ===');
  const capped = await boot(4490, {
    NODE_ENV: 'production',
    ALLOW_MEMORY_CHAT: 'true',
    ALLOWED_ORIGINS: '',
    MAX_IP_CONNECTIONS: '2',
  });
  const capClients = [];
  try {
    const a = await waitConnected(connect(capped.port));
    const b = await waitConnected(connect(capped.port));
    capClients.push(a, b);
    check('connections up to the cap are accepted', a.connected && b.connected);

    const c = connect(capped.port);
    capClients.push(c);
    const started = Date.now();
    while (!c.error && Date.now() - started < 5000) await sleep(100);
    check('connections past the per-address cap are refused', !!c.error, c.error || 'connected anyway');
  } finally {
    capClients.forEach((c) => c.close());
    capped.close();
    await sleep(300);
  }

  /* ------------------------------------------------- production fail-fast */
  console.log('\n=== production configuration ===');
  const broken = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MONGODB_URI: '',
      ALLOW_MEMORY_CHAT: '',
      PORT: '4491',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const brokenLogs = [];
  const exitCode = await new Promise((resolve) => {
    broken.stdout.on('data', (d) => brokenLogs.push(String(d)));
    broken.stderr.on('data', (d) => brokenLogs.push(String(d)));
    broken.on('exit', (code) => resolve(code));
    setTimeout(() => { broken.kill(); resolve('timeout'); }, 8000);
  });
  const brokenText = brokenLogs.join('');
  check('production without a database refuses to start', exitCode !== 0 && exitCode !== 'timeout',
    String(exitCode));
  check('and explains exactly what is missing',
    /MONGODB_URI is required in production/.test(brokenText),
    brokenText.split('\n').filter(Boolean).slice(-2).join(' '));

  console.log(`\n${failed === 0 ? 'ALL PASSED' : 'FAILURES'}: ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSecurity check crashed:', err);
  process.exit(1);
});
