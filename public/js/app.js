/* =====================================================================
   Ludo Royale - client application
   ===================================================================== */
(function () {
  'use strict';

  const B = window.LudoBoard;
  const $ = (id) => document.getElementById(id);

  const STEP_MS = 170;       // per-square walk time
  const DICE_SPIN_MS = 900;  // must stay in sync with the CSS dice transition
  const QUICK_EMOJIS = ['👍', '😂', '😮', '😭', '🔥', '🎉', '😎', '🤔'];

  const EMOJI_PALETTE = (
    '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😜 🤪 🤗 🤔 🤨 😐 😴 😷 ' +
    '🥳 😎 🤩 😭 😢 😤 😡 🤯 😱 🤬 🥺 😈 👻 💀 🤖 👽 🎃 ' +
    '👍 👎 👏 🙌 🙏 💪 🤝 ✌️ 🤞 👊 ✋ 🖐️ 🫶 ' +
    '🔥 ✨ ⚡ 💥 🎉 🎊 🏆 🥇 🎲 🎯 🚀 ⏰ 💣 🧨 ' +
    '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 💖 💯 💫 ' +
    '🍕 🍔 🍟 🌮 🍩 🍫 🍿 ☕ 🍺 🥳'
  ).split(' ').filter(Boolean);

  const DICE_ROTATION = {
    1: [0, 0],
    2: [-90, 0],
    3: [0, -90],
    4: [0, 90],
    5: [90, 0],
    6: [0, 180],
  };

  const DICE_FACE_ORDER = [
    { value: 1, transform: 'translateZ(46px)', pips: [4] },
    { value: 6, transform: 'rotateY(180deg) translateZ(46px)', pips: [0, 2, 3, 5, 6, 8] },
    { value: 3, transform: 'rotateY(90deg) translateZ(46px)', pips: [0, 4, 8] },
    { value: 4, transform: 'rotateY(-90deg) translateZ(46px)', pips: [0, 2, 6, 8] },
    { value: 2, transform: 'rotateX(90deg) translateZ(46px)', pips: [2, 4, 6] },
    { value: 5, transform: 'rotateX(-90deg) translateZ(46px)', pips: [0, 2, 4, 6, 8] },
  ];

  /* ------------------------------------------------------------------ */
  /* state                                                               */
  /* ------------------------------------------------------------------ */

  const state = {
    me: { id: '', token: '', name: '' },
    room: null,
    messages: [],
    tokens: {},
    screen: 'home',
    threeD: true,
    holdUntil: 0,
    pendingState: null,
    diceFace: null,
    activeInput: 'chatInput',
    seenMessageIds: new Set(),
  };

  const socket = window.io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 700,
    reconnectionDelayMax: 4000,
  });

  /* ------------------------------------------------------------------ */
  /* small helpers                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Identity for this tab, issued by the server.
   *
   * sessionStorage (not localStorage) on purpose: it survives a refresh or a
   * dropped connection, but two tabs on the same machine stay two different
   * players - otherwise a second tab would silently hijack the first seat.
   *
   * The id alone is not enough to reclaim a seat: the server also requires the
   * secret token it handed out when the seat was created.
   */
  function loadSession() {
    try {
      return {
        id: window.sessionStorage.getItem('ludo.playerId') || '',
        token: window.sessionStorage.getItem('ludo.token') || '',
      };
    } catch (_) {
      return { id: '', token: '' };
    }
  }

  function saveSession(id, token) {
    if (!id || !token) return;
    state.me.id = id;
    state.me.token = token;
    try {
      window.sessionStorage.setItem('ludo.playerId', id);
      window.sessionStorage.setItem('ludo.token', token);
    } catch (_) { /* ignore */ }
  }

  function storedName() {
    try { return window.localStorage.getItem('ludo.name') || ''; } catch (_) { return ''; }
  }

  function rememberName(name) {
    state.me.name = name;
    try { window.localStorage.setItem('ludo.name', name); } catch (_) { /* ignore */ }
  }

  function initials(name) {
    const clean = String(name || '?').trim();
    return clean.slice(0, 1).toUpperCase() || '?';
  }

  function toast(message, type = 'info', ttl = 4200) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 360);
    }, ttl);
  }

  function setScreen(name) {
    if (state.screen === name) return;
    state.screen = name;
    ['home', 'lobby', 'game'].forEach((key) => {
      $(`screen-${key}`).classList.toggle('is-active', key === name);
    });
    if (name === 'game') ensureBoard();
  }

  function isEmojiOnly(text) {
    return text.length <= 12 && !/[a-zA-Z0-9]/.test(text);
  }

  /* ------------------------------------------------------------------ */
  /* board + dice setup                                                  */
  /* ------------------------------------------------------------------ */

  let boardReady = false;

  function ensureBoard() {
    if (boardReady) return;
    B.buildBoard($('boardInner'));
    state.tokens = B.createTokens($('tokenLayer'));
    boardReady = true;

    $('tokenLayer').addEventListener('click', (event) => {
      const token = event.target.closest('.token');
      if (!token || !token.classList.contains('movable')) return;
      socket.emit('game:move', { tokenIndex: Number(token.dataset.index) });
    });
  }

  function buildDice() {
    const dice = $('dice');
    dice.innerHTML = '';
    DICE_FACE_ORDER.forEach((face) => {
      const faceEl = document.createElement('div');
      faceEl.className = 'face';
      faceEl.style.transform = face.transform;
      for (let i = 0; i < 9; i += 1) {
        const slot = document.createElement('span');
        slot.className = 'pip-slot';
        if (face.pips.includes(i)) slot.innerHTML = '<span></span>';
        faceEl.appendChild(slot);
      }
      dice.appendChild(faceEl);
    });
    setDiceFace(1, false);
  }

  let diceTurns = 0;

  function setDiceFace(value, animate) {
    const safe = DICE_ROTATION[value] ? value : 1;
    // Never re-spin the cube just because the room state was refreshed.
    if (!animate && state.diceFace === safe) return;
    state.diceFace = safe;
    const [x, y] = DICE_ROTATION[safe];
    const dice = $('dice');
    diceTurns += 1;
    if (animate) {
      dice.classList.add('rolling');
      setTimeout(() => dice.classList.remove('rolling'), DICE_SPIN_MS - 120);
    }
    dice.style.transform =
      `rotateX(${x + 360 * diceTurns}deg) rotateY(${y + 360 * (diceTurns + 1)}deg)`;
  }

  /* ------------------------------------------------------------------ */
  /* rendering                                                          */
  /* ------------------------------------------------------------------ */

  function me() {
    return state.room ? state.room.players.find((p) => p.id === state.me.id) || null : null;
  }

  function hold(ms) {
    state.holdUntil = Math.max(state.holdUntil, performance.now() + ms);
    setTimeout(flushPending, ms + 40);
  }

  function flushPending() {
    if (performance.now() < state.holdUntil) return;
    if (!state.pendingState) return;
    const next = state.pendingState;
    state.pendingState = null;
    render(next);
  }

  function onRoomUpdate(payload) {
    state.room = payload;
    if (performance.now() < state.holdUntil) {
      state.pendingState = payload;
      return;
    }
    render(payload);
  }

  function render(room) {
    if (!room) return;
    if (room.status === 'playing' || room.status === 'over') setScreen('game');
    else setScreen('lobby');

    if (room.status === 'lobby') renderSeats(room);
    renderPlayers(room);
    renderBoard(room);
    renderTurn(room);
    renderChatStatus(room);
  }

  function renderSeats(room) {
    const grid = $('seatGrid');
    grid.innerHTML = '';

    const seated = room.players.filter((p) => !p.spectator);
    const spectators = room.players.filter((p) => p.spectator);

    for (let i = 0; i < room.maxPlayers; i += 1) {
      const player = seated[i];
      const seat = document.createElement('div');
      seat.className = 'seat';

      if (!player) {
        seat.classList.add('empty');
        seat.innerHTML = `
          <div class="seat-token" style="--seat-color:rgba(255,255,255,.18)"></div>
          <div class="seat-info">
            <div class="seat-name">Open seat</div>
            <div class="seat-meta">Waiting for a player…</div>
          </div>`;
      } else {
        const color = B.COLOR_HEX[player.color] || '#8892b0';
        seat.classList.add('filled');
        seat.style.setProperty('--seat-color', color);
        if (player.id === state.me.id) seat.classList.add('you');

        const badges = [];
        if (player.isHost) badges.push('<span class="badge badge-host">Host</span>');
        if (player.id === state.me.id) badges.push('<span class="badge badge-you">You</span>');
        if (!player.connected) badges.push('<span class="badge badge-off">Offline</span>');

        seat.innerHTML = `
          <div class="seat-token"></div>
          <div class="seat-info">
            <div class="seat-name">${escapeHtml(player.name)}</div>
            <div class="seat-meta">${player.colorLabel || 'Player'} ${badges.join('')}</div>
          </div>`;
      }

      grid.appendChild(seat);
    }

    spectators.forEach((player) => {
      const seat = document.createElement('div');
      seat.className = 'seat filled';
      seat.style.setProperty('--seat-color', '#8892b0');
      if (player.id === state.me.id) seat.classList.add('you');
      seat.innerHTML = `
        <div class="seat-token"></div>
        <div class="seat-info">
          <div class="seat-name">${escapeHtml(player.name)}</div>
          <div class="seat-meta"><span class="badge badge-watch">Watching</span></div>
        </div>`;
      grid.appendChild(seat);
    });

    const seatedCount = seated.length;
    $('lobbyCount').textContent = `${seatedCount}/${room.maxPlayers} seated`;
    $('roomCode').textContent = room.roomId;

    const startBtn = $('startBtn');
    const amHost = room.hostId === state.me.id;
    const canStart = seatedCount >= room.minPlayers && !me()?.spectator;
    startBtn.disabled = !canStart;
    if (seatedCount < room.minPlayers) {
      startBtn.textContent = `Need ${room.minPlayers - seatedCount} more player(s)`;
    } else if (!amHost) {
      startBtn.textContent = 'Waiting for the host…';
      startBtn.disabled = true;
    } else {
      startBtn.textContent = `Start game (${seatedCount} players)`;
    }

    $('lobbyHint').textContent = amHost
      ? `Minimum ${room.minPlayers} players to start — 3 or 4 works too, extra joiners become spectators.`
      : 'Only the host can start the match. Chat is saved to the database while the game runs.';
  }

  function renderPlayers(room) {
    const list = $('playerList');
    list.innerHTML = '';

    room.players.filter((p) => !p.spectator).forEach((player) => {
      const row = document.createElement('div');
      row.className = 'player-row';
      row.style.setProperty('--pc', B.COLOR_HEX[player.color] || '#8892b0');
      if (room.game && room.game.turnPlayerId === player.id && room.status === 'playing') {
        row.classList.add('turn');
      }

      const tokens = (room.game && room.game.tokens[player.color]) || [];
      const home = tokens.filter((t) => t === B.FINISH).length;
      const pips = [0, 1, 2, 3]
        .map((i) => `<span class="pip ${i < home ? 'on' : ''}"></span>`)
        .join('');

      const tags = [];
      if (player.id === state.me.id) tags.push('You');
      if (player.isHost) tags.push('Host');
      if (!player.connected) tags.push('Offline');

      row.innerHTML = `
        <span class="player-dot"></span>
        <span class="player-main">
          <span class="player-name">${escapeHtml(player.name)}</span>
          <span class="player-sub">${player.colorLabel || 'Waiting'}${tags.length ? ' · ' + tags.join(' · ') : ''}</span>
        </span>
        <span class="player-progress">${pips}</span>`;

      list.appendChild(row);
    });
  }

  function renderBoard(room) {
    ensureBoard();
    const game = room.game;
    if (!game) return;

    const activeColors = new Set(room.players.filter((p) => !p.spectator).map((p) => p.color));
    const positional = [];
    const seen = new Set();

    B.COLORS.forEach((color) => {
      const positions = game.tokens[color] || [];
      positions.forEach((pos, index) => {
        const el = state.tokens[`${color}:${index}`];
        if (!el) return;
        if (!activeColors.has(color)) {
          el.style.display = 'none';
          return;
        }
        el.style.display = '';
        const [row, col] = B.gridPos(color, pos, index);
        positional.push({ color, index, row, col, el, finished: pos === B.FINISH });
        seen.add(el);
      });
    });

    B.spreadStack(positional);

    Object.values(state.tokens).forEach((el) => {
      if (!seen.has(el) && el.style.display !== 'none') el.style.display = 'none';
    });

    positional.forEach((item) => {
      B.place(item.el, item.row, item.col);
      item.el.classList.toggle('finished', item.finished);
      item.el.classList.toggle('mine', item.color === me()?.color);
    });
  }

  function renderTurn(room) {
    const game = room.game;
    const mine = me();
    const myTurn = !!game && room.status === 'playing' && game.turnPlayerId === state.me.id;

    $('turnChip').textContent = game && room.status === 'playing'
      ? `${(room.players.find((p) => p.id === game.turnPlayerId) || {}).colorLabel || ''} turn`
      : room.status === 'over' ? 'Game over' : 'Lobby';

    $('rollBtn').disabled = !myTurn || !game || game.awaitingMove;

    // Legal-move highlights.
    const legal = (game && game.legalMoves && game.legalMoves[state.me.id]) || [];
    Object.entries(state.tokens).forEach(([key, el]) => {
      const [color, index] = key.split(':');
      const movable = myTurn && color === mine?.color && legal.includes(Number(index));
      el.classList.toggle('movable', movable);
    });

    let hint = 'Waiting for other players…';
    if (room.status === 'over') hint = 'Match finished — chat history was deleted.';
    else if (myTurn) {
      hint = game.awaitingMove
        ? `You rolled ${game.dice}. Tap a glowing token.`
        : 'Your turn — roll the dice!';
    } else if (game) {
      const owner = room.players.find((p) => p.id === game.turnPlayerId);
      hint = `${owner ? owner.name : 'Opponent'} is playing…`;
    }
    $('turnHint').textContent = hint;

    if (game && typeof game.dice === 'number') setDiceFace(game.dice, false);
    else if (game && game.lastRoll) setDiceFace(game.lastRoll.value, false);

    // Keep the sidebar button in sync with the board state.
    $('rollBtn').textContent = myTurn && game && game.awaitingMove ? 'Move a token' : 'Roll dice';
  }

  function renderChatStatus(room) {
    const live = room.status === 'playing';
    const label = live ? 'saving to DB' : room.status === 'over' ? 'deleted' : 'lobby';
    ['chatStatus', 'chatStatusLobby'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.textContent = label;
      el.classList.toggle('off', !live);
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------------ */
  /* animations                                                          */
  /* ------------------------------------------------------------------ */

  function onRolled(event) {
    setDiceFace(event.value, true);
    hold(DICE_SPIN_MS + 120);
    if (event.pass) {
      setTimeout(() => toast(`${event.value} — no move possible`, 'warn', 2600), DICE_SPIN_MS);
    } else if (event.color === me()?.color) {
      setTimeout(() => toast(`You rolled ${event.value}`, 'info', 1800), DICE_SPIN_MS - 200);
    }
  }

  function onMoved(event) {
    const el = state.tokens[`${event.color}:${event.tokenIndex}`];
    if (!el) return;

    const steps = [];
    if (event.from === -1) {
      for (let p = 0; p <= event.to; p += 1) steps.push(p);
      el.classList.add('token-new');
      setTimeout(() => el.classList.remove('token-new'), 700);
    } else {
      for (let p = event.from + 1; p <= event.to; p += 1) steps.push(p);
    }

    el.classList.add('walking');
    steps.forEach((pos, index) => {
      setTimeout(() => {
        const [row, col] = B.gridPos(event.color, pos, event.tokenIndex);
        B.place(el, row, col);
        el.classList.add('landed');
        setTimeout(() => el.classList.remove('landed'), 320);
      }, index * STEP_MS);
    });

    const walkMs = Math.max(steps.length, 1) * STEP_MS;
    setTimeout(() => el.classList.remove('walking'), walkMs + 60);
    hold(walkMs + 200);

    if (event.captured && event.captured.length) {
      setTimeout(() => {
        event.captured.forEach((victim) => {
          const victimEl = state.tokens[`${victim.color}:${victim.tokenIndex}`];
          if (!victimEl) return;
          victimEl.classList.add('captured');
          const [row, col] = B.gridPos(victim.color, -1, victim.tokenIndex);
          setTimeout(() => B.place(victimEl, row, col), 190);
          setTimeout(() => victimEl.classList.remove('captured'), 760);
        });
        toast('Knocked out! 🎯', 'warn', 2600);
      }, walkMs);
      hold(walkMs + 780);
    }

    if (event.reachedHome) {
      setTimeout(() => toast('Token reached home 🏠', 'success', 2600), walkMs);
    }
  }

  function confetti() {
    const colors = ['#f2455b', '#22c98a', '#f0b429', '#3d8bfd', '#7c5cff', '#48d4ff'];
    for (let i = 0; i < 60; i += 1) {
      const piece = document.createElement('span');
      piece.className = 'confetti';
      piece.style.left = `${Math.random() * 100}vw`;
      piece.style.background = colors[i % colors.length];
      piece.style.animationDuration = `${2.2 + Math.random() * 1.8}s`;
      piece.style.animationDelay = `${Math.random() * 0.6}s`;
      document.body.appendChild(piece);
      setTimeout(() => piece.remove(), 4600);
    }
  }

  /* ------------------------------------------------------------------ */
  /* chat                                                                */
  /* ------------------------------------------------------------------ */

  function renderMessages() {
    ['chatBody', 'chatBodyLobby'].forEach((id) => renderInto($(id), id === 'chatBody'));
  }

  function renderInto(container, showEmptyState) {
    if (!container) return;
    container.innerHTML = '';

    if (!state.messages.length) {
      if (showEmptyState) {
        container.innerHTML =
          '<div class="chat-empty"><span>💬</span>No messages yet — say hi with an emoji!</div>';
      }
      return;
    }

    const fragment = document.createDocumentFragment();
    state.messages.forEach((message) => fragment.appendChild(buildMessage(message)));
    container.appendChild(fragment);
    container.scrollTop = container.scrollHeight;
  }

  function buildMessage(message) {
    const wrapper = document.createElement('div');
    if (message.kind === 'system') {
      wrapper.className = 'msg msg-system';
      const text = document.createElement('div');
      text.className = 'msg-text';
      text.textContent = message.text;
      wrapper.appendChild(text);
      return wrapper;
    }

    const mine = message.playerId === state.me.id;
    wrapper.className = `msg${mine ? ' msg-mine' : ''}${isEmojiOnly(message.text) ? ' msg-emoji' : ''}`;
    wrapper.style.setProperty('--pc', B.COLOR_HEX[message.color] || '#8892b0');

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = initials(message.name);

    const body = document.createElement('div');
    body.className = 'msg-body';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const who = document.createElement('span');
    who.textContent = mine ? 'You' : message.name;
    const when = document.createElement('span');
    when.textContent = new Date(message.sentAt || Date.now()).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    meta.append(who, when);

    const text = document.createElement('div');
    text.className = 'msg-text';
    text.textContent = message.text;

    body.append(meta, text);
    wrapper.append(avatar, body);
    return wrapper;
  }

  function appendMessage(message) {
    if (state.seenMessageIds.has(message.id)) return;
    state.seenMessageIds.add(message.id);
    state.messages.push(message);
    if (state.messages.length > 250) state.messages.shift();
    renderMessages();
  }

  function clearMessages() {
    state.messages = [];
    state.seenMessageIds.clear();
    renderMessages();
  }

  function sendChat(inputId) {
    const input = $(inputId);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    socket.emit('chat:send', { text }, (res) => {
      if (!res || !res.ok) toast((res && res.error) || 'Message failed', 'error');
    });
  }

  function sendEmoji(emoji) {
    socket.emit('chat:send', { text: emoji }, (res) => {
      if (!res || !res.ok) toast((res && res.error) || 'Message failed', 'error');
    });
  }

  /* emoji picker ------------------------------------------------------ */

  function buildEmojiPicker() {
    const grid = $('emojiGrid');
    const fragment = document.createDocumentFragment();
    EMOJI_PALETTE.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        const input = $(state.activeInput);
        input.value = `${input.value}${emoji}`.slice(0, 300);
        input.focus();
      });
      fragment.appendChild(btn);
    });
    grid.appendChild(fragment);
  }

  function openEmojiPicker(anchor, targetInputId) {
    state.activeInput = targetInputId;
    const pop = $('emojiPop');
    pop.hidden = false;

    const rect = anchor.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    let left = rect.right - width;
    let top = rect.top - height - 10;
    if (top < 10) top = rect.bottom + 10;
    pop.style.left = `${Math.max(10, Math.min(left, window.innerWidth - width - 10))}px`;
    pop.style.top = `${Math.max(10, Math.min(top, window.innerHeight - height - 10))}px`;

    document.querySelectorAll('.emoji-btn').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.emojiFor === targetInputId);
    });
  }

  function closeEmojiPicker() {
    $('emojiPop').hidden = true;
    document.querySelectorAll('.emoji-btn').forEach((btn) => btn.classList.remove('is-on'));
  }

  /* ------------------------------------------------------------------ */
  /* overlays                                                            */
  /* ------------------------------------------------------------------ */

  function showOverlay(payload) {
    const winner = payload.winner;
    const color = winner ? B.COLOR_HEX[winner.color] : '#7c5cff';

    $('overlayCrown').textContent = winner
      ? winner.id === state.me.id ? '🏆' : '🥈'
      : '🙈';
    $('overlayTitle').textContent = winner
      ? winner.id === state.me.id ? 'You win!' : `${winner.name} wins!`
      : 'Match cancelled';
    $('overlayTitle').style.color = winner ? color : '';

    $('overlayText').textContent =
      payload.message ||
      (winner ? `${winner.name} brought all four tokens home.` : 'Not enough players to continue.');

    $('overlay').hidden = false;
    if (winner) confetti();
  }

  /* ------------------------------------------------------------------ */
  /* socket wiring                                                       */
  /* ------------------------------------------------------------------ */

  function setConnection(status) {
    const pill = $('connPill');
    pill.className = `conn-pill ${status}`;
    pill.querySelector('span').textContent =
      status === 'live' ? 'Connected' : status === 'down' ? 'Disconnected' : 'Connecting…';
  }

  socket.on('connect', () => {
    setConnection('live');
    // Re-attach after a refresh or a dropped connection.
    if (state.room && state.room.roomId && state.me.id) {
      socket.emit(
        'room:join',
        {
          roomId: state.room.roomId,
          playerId: state.me.id,
          token: state.me.token,
          name: state.me.name,
        },
        (res) => {
          if (!res || !res.ok) return;
          saveSession(res.playerId, res.token);
          toast('Reconnected', 'success', 2200);
        }
      );
    }
  });

  socket.on('disconnect', () => {
    setConnection('down');
    toast('Connection lost — reconnecting…', 'error', 3000);
  });
  socket.on('connect_error', () => setConnection('down'));

  socket.on('room:update', onRoomUpdate);

  socket.on('chat:sync', (payload) => {
    clearMessages();
    (payload.messages || []).forEach((message) => {
      if (!state.seenMessageIds.has(message.id)) {
        state.seenMessageIds.add(message.id);
        state.messages.push(message);
      }
    });
    renderMessages();
  });

  socket.on('chat:message', appendMessage);

  socket.on('chat:cleared', () => {
    clearMessages();
    toast('Game ended — chat history deleted 🗑️', 'warn', 5000);
  });

  socket.on('chat:deleted', (payload) => {
    if (payload && payload.count) {
      toast(`${payload.count} message(s) removed from MongoDB`, 'info', 4200);
    }
  });

  socket.on('game:rolled', onRolled);
  socket.on('game:moved', onMoved);

  socket.on('game:over', (payload) => {
    const wait = Math.max(0, state.holdUntil - performance.now());
    setTimeout(() => showOverlay(payload), wait + 120);
  });

  socket.on('notice', (payload) => {
    if (payload && payload.message) toast(payload.message, payload.type || 'error');
  });

  socket.on('room:left', () => {
    state.room = null;
    clearMessages();
    $('overlay').hidden = true;
    setScreen('home');
  });

  /* ------------------------------------------------------------------ */
  /* ui wiring                                                           */
  /* ------------------------------------------------------------------ */

  function joinWithCode(code) {
    const name = $('nameInput').value.trim() || storedName() || `Player ${Math.floor(Math.random() * 90 + 10)}`;
    if (!name) {
      showHomeError('Pick a name first.');
      return;
    }
    rememberName(name);

    const identity = { playerId: state.me.id, token: state.me.token };
    const payload = { roomId: code, name, ...identity };
    const handler = (res) => {
      if (!res || !res.ok) {
        showHomeError((res && res.error) || 'Could not join the room.');
        return;
      }
      hideHomeError();
      // The server is the authority on who we are - always adopt its answer.
      saveSession(res.playerId, res.token);
      state.room = { roomId: res.roomId };
      setScreen('lobby');
    };

    if (code) socket.emit('room:join', payload, handler);
    else socket.emit('room:create', { name, ...identity }, handler);
  }

  function showHomeError(message) {
    const el = $('homeError');
    el.textContent = message;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  function hideHomeError() {
    $('homeError').textContent = '';
    $('homeError').classList.remove('show');
  }

  let booted = false;

  function init() {
    if (booted) return;
    booted = true;

    const session = loadSession();
    state.me.id = session.id;
    state.me.token = session.token;
    $('nameInput').value = storedName();

    buildDice();
    buildEmojiPicker();

    const QUICK_ROW = $('quickEmojis');
    QUICK_EMOJIS.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = emoji;
      btn.addEventListener('click', () => sendEmoji(emoji));
      QUICK_ROW.appendChild(btn);
    });

    // URL ?room=CODE prefill
    const params = new URLSearchParams(window.location.search);
    const preset = (params.get('room') || '').toUpperCase();
    if (preset) $('codeInput').value = preset;

    $('createBtn').addEventListener('click', () => joinWithCode(''));
    $('joinBtn').addEventListener('click', () => {
      const code = $('codeInput').value.trim().toUpperCase();
      if (code.length < 4) return showHomeError('Enter the 5-character room code.');
      return joinWithCode(code);
    });
    $('codeInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $('joinBtn').click();
    });
    $('nameInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $('createBtn').click();
    });

    $('startBtn').addEventListener('click', () => {
      socket.emit('room:start', (res) => {
        if (!res || !res.ok) toast((res && res.error) || 'Cannot start yet', 'warn');
      });
    });

    $('leaveBtn').addEventListener('click', () => socket.emit('room:leave'));
    $('roomCode').addEventListener('click', async () => {
      const code = $('roomCode').textContent.trim();
      try {
        await navigator.clipboard.writeText(code);
        toast(`Room code ${code} copied`, 'success', 2400);
      } catch (_) {
        toast(`Room code: ${code}`, 'info', 4000);
      }
    });

    $('rollBtn').addEventListener('click', () => {
      if ($('rollBtn').disabled) return;
      socket.emit('game:roll');
    });

    $('viewBtn').addEventListener('click', () => {
      state.threeD = !state.threeD;
      document.querySelector('.game-grid').classList.toggle('no-3d', !state.threeD);
      $('viewBtn').classList.toggle('is-on', !state.threeD);
      $('viewBtn').textContent = state.threeD ? '3D View' : 'Flat View';
    });

    $('overlayLobbyBtn').addEventListener('click', () => {
      $('overlay').hidden = true;
      socket.emit('room:reset');
    });
    $('overlayCloseBtn').addEventListener('click', () => { $('overlay').hidden = true; });

    // chat send buttons + inputs
    document.querySelectorAll('[data-send-for]').forEach((btn) => {
      btn.addEventListener('click', () => sendChat(btn.dataset.sendFor));
    });
    document.querySelectorAll('[data-emoji-for]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const pop = $('emojiPop');
        if (!pop.hidden && state.activeInput === btn.dataset.emojiFor) closeEmojiPicker();
        else openEmojiPicker(btn, btn.dataset.emojiFor);
      });
    });
    ['chatInput', 'chatInputLobby'].forEach((id) => {
      $(id).addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          sendChat(id);
        }
      });
    });
    $('emojiClose').addEventListener('click', closeEmojiPicker);
    document.addEventListener('click', (event) => {
      if (!$('emojiPop').hidden && !event.target.closest('#emojiPop') && !event.target.closest('.emoji-btn')) {
        closeEmojiPicker();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeEmojiPicker();
      if (event.key === ' ' && state.screen === 'game' && document.activeElement.tagName !== 'INPUT') {
        event.preventDefault();
        if (!$('rollBtn').disabled) socket.emit('game:roll');
      }
    });

    setScreen('home');
    setConnection('loading');

    // Debug handle: the raw socket plus the last state the server sent, so the
    // rendered DOM can always be compared against the authoritative state.
    window.__ludoDebug = { socket, state };

    // Lets the owner (and automated checks) know the UI is wired up.
    document.body.dataset.appReady = '1';
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
