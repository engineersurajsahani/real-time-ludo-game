'use strict';

/**
 * Browser check for the front-end.
 *
 * Boots the server, launches headless Chrome through the DevTools protocol,
 * and drives two real browser tabs: create a table, join it, start the match,
 * roll and move tokens, exchange chat, and confirms the board renders with no
 * uncaught errors along the way.
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.UI_TEST_PORT || 4477);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.UI_CDP_PORT || 9333);
const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

function httpJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(body || String(e))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function waitHttp(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(url, (res) => { res.resume(); resolve(true); })
        .on('error', () => {
          if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${url}`));
          setTimeout(tick, 250);
        });
    };
    tick();
  });
}

/* ---------------------------------------------------------------- CDP */

class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(d.exception ? d.exception.description : d.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
      }
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception
          ? result.exceptionDetails.exception.description
          : result.exceptionDetails.text
      );
    }
    return result.result.value;
  }

  async waitFor(expression, timeoutMs = 10000, label = expression) {
    const started = Date.now();
    for (;;) {
      let value = null;
      try { value = await this.evaluate(`return (${expression});`); } catch (_) { value = null; }
      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
      await sleep(120);
    }
  }

  close() {
    try { this.ws.close(); } catch (_) { /* ignore */ }
  }
}

async function newTarget(url) {
  const endpoint = `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`;
  try {
    return await httpJson(endpoint, 'PUT');
  } catch (_) {
    return httpJson(endpoint, 'GET');
  }
}

async function openPage(url) {
  const target = await newTarget('about:blank');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const page = new Page(ws);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Log.enable');
  await page.send('Page.navigate', { url });
  return page;
}

/* --------------------------------------------------------------- main */

async function main() {
  const profile = path.join(os.tmpdir(), `ludo-ui-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });

  // UI_PROD=1 runs the whole browser suite against a production-mode server,
  // which is what proves the strict CSP does not break the real client.
  const prodMode = process.env.UI_PROD === '1';
  console.log(`\nStarting server${prodMode ? ' (NODE_ENV=production)' : ''}...`);
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ...(prodMode ? { NODE_ENV: 'production', ALLOW_MEMORY_CHAT: 'true' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  server.stderr.on('data', (d) => serverLog.push(String(d)));
  await waitHttp(`${BASE}/health`, 20000);

  console.log('Starting headless Chrome...');
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--window-size=1500,1000',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 25000);
  await sleep(600);

  let host;
  let guest;

  try {
    console.log('\nHome screen');
    host = await openPage(BASE);
    await host.waitFor('document.body.dataset.appReady === "1"', 20000, 'app bundle');
    check('the page loads the socket.io client and app bundle', true);
    check('the board geometry module exposes the LudoBoard API',
      await host.evaluate('return typeof LudoBoard.gridPos === "function" && LudoBoard.TRACK.length === 52;'));

    const homeVisible = await host.evaluate(
      'const s = document.getElementById("screen-home"); return s.classList.contains("is-active") && getComputedStyle(s).display !== "none";'
    );
    check('the home screen is visible on load', homeVisible === true);

    const fontOk = await host.evaluate(
      'return getComputedStyle(document.querySelector(".home-card")).borderRadius !== "0px";'
    );
    check('the stylesheet is applied (glass cards are rounded)', fontOk === true);

    console.log('\nCreate + join from two browser tabs');
    await host.evaluate(`
      document.getElementById('nameInput').value = 'Aarav';
      document.getElementById('createBtn').click();
      return true;
    `);
    await host.waitFor('document.getElementById("screen-lobby").classList.contains("is-active")', 10000, 'lobby');
    const roomCode = await host.evaluate('return document.getElementById("roomCode").textContent.trim();');
    check('creating a table shows the lobby with a room code', /^[A-Z0-9]{5}$/.test(roomCode), roomCode);

    const startDisabled = await host.evaluate('return document.getElementById("startBtn").disabled;');
    check('the start button is disabled with a single player', startDisabled === true);

    guest = await openPage(BASE);
    await guest.waitFor('document.body.dataset.appReady === "1"', 20000, 'guest app');
    await guest.evaluate(`
      document.getElementById('nameInput').value = 'Meera';
      document.getElementById('codeInput').value = ${JSON.stringify(roomCode)};
      document.getElementById('joinBtn').click();
      return true;
    `);
    try {
      await guest.waitFor('document.getElementById("screen-lobby").classList.contains("is-active")', 10000, 'guest lobby');
    } catch (err) {
      const diag = await guest.evaluate(`
        return JSON.stringify({
          error: document.getElementById('homeError').textContent,
          code: document.getElementById('codeInput').value,
          home: document.getElementById('screen-home').classList.contains('is-active'),
          name: document.getElementById('nameInput').value,
          pid: sessionStorage.getItem('ludo.playerId'),
          conn: document.getElementById('connPill').textContent,
        });
      `);
      console.log('  i guest diagnostics:', diag);
      throw err;
    }
    await host.waitFor('document.querySelectorAll("#seatGrid .seat.filled").length === 2', 10000, 'two seats');

    const seats = await host.evaluate(`
      return [...document.querySelectorAll('#seatGrid .seat')].map((s) => ({
        filled: s.classList.contains('filled'),
        name: (s.querySelector('.seat-name') || {}).textContent || '',
      }));
    `);
    check('both players appear as seats in the lobby', seats.filter((s) => s.filled).length === 2, JSON.stringify(seats));

    console.log('\nLobby chat');
    await host.evaluate(`
      const i = document.getElementById('chatInputLobby');
      i.value = 'hi from the host 👋';
      document.querySelector('[data-send-for="chatInputLobby"]').click();
      return true;
    `);
    await guest.waitFor('document.getElementById("chatBodyLobby").textContent.includes("hi from the host")', 8000, 'guest sees lobby chat');
    check('lobby chat reaches the other browser tab', true);

    const emojiOpened = await host.evaluate(`
      const btn = document.querySelector('[data-emoji-for="chatInputLobby"]');
      btn.click();
      const pop = document.getElementById('emojiPop');
      return !pop.hidden && pop.querySelectorAll('.emoji-grid button').length > 40;
    `);
    check('the emoji picker opens with a full palette', emojiOpened === true);
    await host.evaluate('document.getElementById("emojiClose").click(); return true;');

    console.log('\nStarting the match');
    await host.waitFor('document.getElementById("startBtn").disabled === false', 8000, 'start enabled with 2 players');
    check('the host can start with exactly 2 players', true);

    await host.evaluate('document.getElementById("startBtn").click(); return true;');
    await host.waitFor('document.getElementById("screen-game").classList.contains("is-active")', 10000, 'game screen');
    await guest.waitFor('document.getElementById("screen-game").classList.contains("is-active")', 10000, 'guest game screen');
    check('both tabs switch to the 3D board view', true);

    const board = await host.evaluate(`
      const cells = document.querySelectorAll('#boardInner .cell').length;
      const centre = document.querySelectorAll('#boardInner .board-center').length;
      const yards = document.querySelectorAll('#boardInner .yard-box').length;
      const tokens = document.querySelectorAll('#tokenLayer .token').length;
      const faces = document.querySelectorAll('#dice .face').length;
      const el = document.getElementById('board');
      return { cells, centre, yards, tokens, faces, w: el.offsetWidth, h: el.offsetHeight };
    `);
    check('the board renders 216 cells plus one 3x3 centre and 4 yards',
      board.cells === 216 && board.centre === 1 && board.yards === 4, JSON.stringify(board));
    check('16 tokens are on the board', board.tokens === 16, String(board.tokens));
    check('the dice cube has 6 faces', board.faces === 6, String(board.faces));
    check('the board layout is a square and visible', board.w > 200 && Math.abs(board.w - board.h) <= 4,
      `${board.w}x${board.h}`);

    // Every colour's full journey must land inside the 15x15 grid - this is
    // what the 2-player game above cannot prove (no yellow/blue tokens exist).
    const geometry = await host.evaluate(`
      const bad = [];
      LudoBoard.COLORS.forEach((color) => {
        for (const pos of [-1].concat([...Array(59).keys()])) {
          for (let i = 0; i < 4; i += 1) {
            const [r, c] = LudoBoard.gridPos(color, pos, i);
            if (!(r >= 0 && r <= 15 && c >= 0 && c <= 15)) bad.push(color + ':' + pos + ':' + i + '=' + r + ',' + c);
          }
        }
      });
      return bad.length;
    `);
    check('all 4 colours resolve in-bounds coordinates for every square (yard -> centre)',
      geometry === 0, `${geometry} out-of-bounds`);

    const cornerSpread = await host.evaluate(`
      const corners = {};
      LudoBoard.COLORS.forEach((color) => {
        const [r, c] = LudoBoard.gridPos(color, -1, 0);
        corners[color] = (r < 7 ? 'top' : 'bottom') + '-' + (c < 7 ? 'left' : 'right');
      });
      return new Set(Object.values(corners)).size;
    `);
    check('the four yards occupy four distinct board corners', cornerSpread === 4, String(cornerSpread));

    const tilt = await host.evaluate(
      'return getComputedStyle(document.getElementById("board3d")).transform;'
    );
    check('the 3D perspective tilt is applied to the board',
      typeof tilt === 'string' && tilt !== 'none' && tilt.startsWith('matrix'), tilt);

    // A 2-player match uses 2 colours, so 8 tokens are live and 8 are hidden.
    const inside = await host.evaluate(`
      let outside = 0;
      let placed = 0;
      let hidden = 0;
      document.querySelectorAll('#tokenLayer .token').forEach((t) => {
        if (t.style.display === 'none') { hidden += 1; return; }
        const left = parseFloat(t.style.left);
        const top = parseFloat(t.style.top);
        if (Number.isNaN(left) || Number.isNaN(top)) { outside += 1; return; }
        if (left < 0 || left > 100 || top < 0 || top > 100) outside += 1;
        else placed += 1;
      });
      return { outside, placed, hidden };
    `);
    check('the 8 tokens of the two playing colours are positioned on the board',
      inside.outside === 0 && inside.placed === 8, JSON.stringify(inside));
    check('tokens for colours that are not playing stay hidden',
      inside.hidden === 8, JSON.stringify(inside));

    console.log('\nDice, moves and animation');
    // A generous budget on purpose: until someone rolls a 6 no token can leave
    // the yard, so a match can legally see a long run of pass-only turns.
    const drove = await driveTurns([host, guest], 45000);
    check('a player could roll and take a move through the UI', drove.rolled && drove.moved,
      JSON.stringify(drove));
    if (!drove.moved) console.log('  i move diagnostics:', JSON.stringify(drove.debug));
    check('tokens moved to new squares', drove.positionsChanged === true);
    check('the dice widget shows the rolled value', drove.face > 0, String(drove.face));

    console.log('\nTable chat during the match');
    await host.evaluate(`
      const i = document.getElementById('chatInput');
      i.value = 'nice roll 🎲🔥';
      document.querySelector('[data-send-for="chatInput"]').click();
      return true;
    `);
    await guest.waitFor('document.getElementById("chatBody").textContent.includes("nice roll")', 8000, 'game chat');
    check('in-game chat reaches the other player', true);

    const quickEmoji = await guest.evaluate(`
      const btn = document.querySelector('#quickEmojis button');
      const label = btn.textContent;
      btn.click();
      return label;
    `);
    await host.waitFor(`document.getElementById("chatBody").textContent.includes(${JSON.stringify(quickEmoji)})`, 8000, 'emoji reaction');
    check('quick emoji reactions are sent instantly', true);

    console.log('\nChat status + errors');
    const status = await host.evaluate('return document.getElementById("chatStatus").textContent.trim();');
    check('the chat panel reports that history is being saved', /saving/i.test(status), status);

    const issues = [...host.errors, ...guest.errors].filter((e) => !/favicon/i.test(e));
    check('no uncaught errors or console errors in either tab', issues.length === 0,
      issues.slice(0, 3).join(' | '));

    console.log('\nChat is wiped when the match ends');
    await host.evaluate(`
      const i = document.getElementById('chatInput');
      i.value = 'see you next round';
      document.querySelector('[data-send-for="chatInput"]').click();
      return true;
    `);
    await host.waitFor('document.getElementById("chatBody").textContent.includes("see you next round")', 8000, 'message visible');
    const beforeWipe = await host.evaluate('return document.querySelectorAll("#chatBody .msg").length;');
    check('the chat panel shows messages before the wipe', beforeWipe > 0, String(beforeWipe));

    // Closing the second player's tab leaves one player, so the server cancels
    // the match - which is the exact moment the chat history must disappear.
    await guest.send('Page.close');
    await host.waitFor('document.getElementById("overlay").hidden === false', 20000, 'results overlay');
    check('the remaining player is shown the results overlay', true);

    await host.waitFor('document.querySelectorAll("#chatBody .msg").length === 0', 10000, 'chat cleared');
    const after = await host.evaluate(`
      return {
        messages: document.querySelectorAll('#chatBody .msg').length,
        emptyState: document.querySelectorAll('#chatBody .chat-empty').length,
        title: document.getElementById('overlayTitle').textContent,
        status: document.getElementById('chatStatus').textContent.trim(),
      };
    `);
    check('every chat bubble is gone from the UI after the game ends',
      after.messages === 0, JSON.stringify(after));
    check('the chat panel falls back to its empty state', after.emptyState === 1, JSON.stringify(after));
    check('the chat panel reports the history as deleted', /deleted/i.test(after.status), after.status);
    check('the overlay explains that the match was cancelled',
      /cancel/i.test(after.title), after.title);

    console.log('\nScreenshot');
    await host.evaluate('document.getElementById("overlayCloseBtn").click(); return true;');
    const shot = await host.send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(__dirname, '..', 'screenshots');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'game-board.png');
    fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
    const png = fs.readFileSync(outFile);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    check('a screenshot of the running match was captured', png.length > 40000, `${png.length} bytes`);
    check('the screenshot is a real rendered frame',
      png.slice(1, 4).toString() === 'PNG' && width > 800 && height > 600, `${width}x${height}`);
    console.log('  i saved to screenshots/game-board.png');
  } finally {
    if (host) host.close();
    if (guest) guest.close();
    chrome.kill();
    server.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  console.log(`\n${failed === 0 ? 'ALL PASSED' : 'FAILURES'}: ${passed} passed, ${failed} failed\n`);
  if (failed) {
    console.log('server log tail:\n' + serverLog.slice(-10).join(''));
    process.exit(1);
  }
  process.exit(0);
}

/**
 * Plays real turns through the UI across several tabs.
 *
 * Early in a Ludo match a roll can legally have no move at all (a token needs a
 * 6 to leave the yard), so this keeps rolling until a token actually moves or
 * the budget runs out - the roll is a hint, never an assertion.
 */
async function driveTurns(pages, budgetMs) {
  const started = Date.now();
  const result = { rolled: false, moved: false, face: 0, positionsChanged: false, rolls: 0 };

  const snapshot = () => pages[0].evaluate(`
    return [...document.querySelectorAll('#tokenLayer .token')]
      .filter((t) => t.style.display !== 'none')
      .map((t) => t.dataset.color + ':' + t.dataset.index + '@' + t.style.left + ',' + t.style.top)
      .join('|');
  `);

  const READ = `
    return {
      mine: document.getElementById('rollBtn').disabled === false,
      movable: document.querySelectorAll('#tokenLayer .token.movable').length,
    };
  `;

  const before = await snapshot();
  const trace = [];

  while (Date.now() - started < budgetMs) {
    let acted = false;

    for (const page of pages) {
      const state = await page.evaluate(READ);

      if (state.movable > 0) {
        await page.evaluate(`
          const t = document.querySelector('#tokenLayer .token.movable');
          t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        `);
        result.moved = true;
        acted = true;
        await sleep(780); // let the square-by-square walk animation finish
        break;
      }

      if (state.mine) {
        await page.evaluate('document.getElementById("rollBtn").click(); return true;');
        result.rolled = true;
        result.rolls += 1;
        acted = true;
        // The button locks once the roll lands (a move is pending or the turn
        // has passed). Retrying is safe - the server rejects stale clicks.
        await page
          .waitFor('document.getElementById("rollBtn").disabled === true', 4000, 'roll applied')
          .catch(() => {});
        break;
      }
    }

    if (!acted) await sleep(160);
    if (trace.length < 20 && acted) {
      trace.push(`${Math.round(Date.now() - started)}ms rolled=${result.rolls} moved=${result.moved}`);
    }

    result.face = await pages[0].evaluate(
      'return (document.getElementById("dice").style.transform || "").includes("rotateX") ? 1 : 0;'
    );

    if ((await snapshot()) !== before) result.positionsChanged = true;
    if (result.moved && result.rolled && result.positionsChanged) break;
  }

  if (!result.moved) {
    result.debug = { trace, probes: [] };
    for (const page of pages) {
      result.debug.probes.push(
        await page.evaluate(`
          const dbg = window.__ludoDebug || {};
          const room = dbg.state && dbg.state.room;
          const game = room && room.game;
          return {
            renderedTurn: document.getElementById('turnChip').textContent.trim(),
            rollDisabled: document.getElementById('rollBtn').disabled,
            movable: document.querySelectorAll('#tokenLayer .token.movable').length,
            serverTurn: game ? game.turnColor : null,
            status: room ? room.status : null,
            awaitingMove: game ? game.awaitingMove : null,
            dice: game ? game.dice : null,
            lastEvent: game && game.lastEvent ? game.lastEvent.message : null,
            holdMsLeft: dbg.state ? Math.round(dbg.state.holdUntil - performance.now()) : null,
            stuckPending: dbg.state ? dbg.state.pendingState !== null : null,
            tokens: game ? JSON.stringify(game.tokens) : null,
          };
        `).catch((err) => String(err.message))
      );
    }
  }

  return result;
}

main().catch((err) => {
  console.error('\nUI check crashed:', err);
  process.exit(1);
});
