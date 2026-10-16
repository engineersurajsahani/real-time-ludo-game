'use strict';

const LudoGame = require('./LudoGame');
const { COLORS, COLOR_LABELS } = require('./constants');
const chatStore = require('../chatStore');
const identity = require('../identity');
const { config } = require('../config');

const MAX_PLAYERS = config.rooms.maxPlayers;
const MIN_PLAYERS = config.rooms.minPlayers;
const CHAT_MEMORY_LIMIT = 250;
const DISCONNECT_SKIP_MS = 5000;
const RESET_AFTER_OVER_MS = 15000;
const LOBBY_GRACE_MS = 90 * 1000;

const channel = (roomId) => `room:${roomId}`;

/**
 * One table: its players, the running game and the room chat.
 *
 * The room owns every timer so a single `destroy()` can shut it down cleanly.
 */
class Room {
  /**
   * @param {string} id short join code
   * @param {import('socket.io').Server} io
   */
  constructor(id, io) {
    this.id = id;
    this.io = io;
    this.players = [];
    this.hostId = null;
    this.status = 'lobby'; // lobby | playing | over
    this.graceTimers = new Map();
    this.game = null;
    this.chat = [];
    this.winner = null;

    this.turnTimer = null;
    this.resetTimer = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  emit(event, payload) {
    this.io.to(channel(this.id)).emit(event, payload);
  }

  seatedPlayers() {
    return this.players.filter((p) => !p.spectator && p.color);
  }

  connectedSeated() {
    return this.seatedPlayers().filter((p) => p.connected);
  }

  find(playerId) {
    return this.players.find((p) => p.id === playerId) || null;
  }

  pickColor() {
    const taken = new Set(this.seatedPlayers().map((p) => p.color));
    return COLORS.find((color) => !taken.has(color)) || null;
  }

  playerForColor(color) {
    return this.seatedPlayers().find((p) => p.color === color) || null;
  }

  clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  clearResetTimer() {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* membership                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Seat a player, or hand them a spectator spot when the table is busy.
   *
   * Identity is server-issued: a client may only reclaim an existing seat by
   * presenting both the id and the secret token it was given. Anything else -
   * including a guessed id - is treated as a newcomer and gets a fresh seat.
   *
   * @returns {{player: object, rejoined: boolean, token: string}}
   */
  addPlayer({ id, name, socketId, token }) {
    const safeName =
      String(name || 'Player').trim().slice(0, config.limits.nameLength) || 'Player';

    const claimed = id ? this.find(id) : null;
    if (identity.matches(claimed, id, token)) {
      claimed.socketId = socketId;
      claimed.connected = true;
      claimed.name = safeName;
      this.lastActivity = Date.now();
      this.clearGrace(claimed.id);
      return { player: claimed, rejoined: true, token: claimed.token };
    }

    const canSeat = this.status === 'lobby' && this.seatedPlayers().length < MAX_PLAYERS;
    const player = {
      id: identity.newPlayerId(),
      token: identity.newToken(),
      name: safeName,
      socketId,
      color: canSeat ? this.pickColor() : null,
      connected: true,
      spectator: !canSeat,
      joinedAt: Date.now(),
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;
    this.lastActivity = Date.now();
    this.clearGrace(player.id);

    return { player, rejoined: false, token: player.token };
  }

  /** Socket closed: keep the seat so the match survives a refresh. */
  handleDisconnect(playerId) {
    const player = this.find(playerId);
    if (!player) return null;
    player.connected = false;
    player.socketId = null;
    this.lastActivity = Date.now();

    // In the lobby an empty chair is simply freed after a short grace period
    // so a quick refresh does not lose the player's colour.
    if (this.status === 'lobby') {
      this.clearGrace(playerId);
      const timer = setTimeout(() => {
        this.graceTimers.delete(playerId);
        const still = this.find(playerId);
        if (!still || still.connected || this.status !== 'lobby') return;
        this.removePlayer(playerId);
        this.emitState();
      }, LOBBY_GRACE_MS);
      if (timer.unref) timer.unref();
      this.graceTimers.set(playerId, timer);
    }

    return player;
  }

  clearGrace(playerId) {
    const timer = this.graceTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(playerId);
    }
  }

  /** Drop a player and hand the host badge on if needed. */
  removePlayer(playerId) {
    const index = this.players.findIndex((p) => p.id === playerId);
    if (index === -1) return null;
    const [player] = this.players.splice(index, 1);
    this.clearGrace(playerId);
    if (this.hostId === playerId) {
      const next = this.players.find((p) => !p.spectator) || this.players[0];
      this.hostId = next ? next.id : null;
    }
    return player;
  }

  /** Player pressed "leave": free the seat outside a game, keep it during one. */
  handleLeave(playerId) {
    const player = this.removePlayer(playerId);
    if (!player) return null;

    if (this.status === 'playing' && this.game && !this.game.over) {
      // The seat is gone but the tokens are still on the board, so tell the
      // engine to skip that colour from now on.
      this.game.players = this.game.players.filter((p) => p.id !== playerId);
      if (this.game.players.length === 0) {
        this.abandon('The table emptied out.');
        return player;
      }
      if (this.game.turnIndex >= this.game.players.length) this.game.turnIndex = 0;
      if (this.game.legalMoves.length) {
        this.game.legalMoves = this.game.computeLegalMoves(
          this.game.currentColor,
          this.game.dice
        );
      }
      this.afterStateChange();
    }

    this.lastActivity = Date.now();
    return player;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async hydrateChat() {
    if (this.chat.length) return;
    const stored = await chatStore.history(this.id, CHAT_MEMORY_LIMIT);
    if (stored.length && !this.chat.length) this.chat = stored;
  }

  start(playerId) {
    if (this.status === 'playing') return { ok: false, error: 'The game is already running.' };
    if (this.status === 'over') return { ok: false, error: 'Starting the next round, hold on...' };
    if (playerId && this.hostId && playerId !== this.hostId) {
      return { ok: false, error: 'Only the host can start the game.' };
    }

    const seated = this.connectedSeated();
    if (seated.length < MIN_PLAYERS) {
      return { ok: false, error: `Need at least ${MIN_PLAYERS} players to start.` };
    }

    this.clearResetTimer();
    this.status = 'playing';
    this.winner = null;
    this.game = new LudoGame(seated);

    this.pushSystemMessage(
      `${seated.map((p) => p.name).join(', ')} started a ${seated.length}-player match.`
    );

    return { ok: true, players: seated.length };
  }

  /** Called when the last token reaches the centre. */
  async finish(winner) {
    if (this.status !== 'playing') return;
    this.status = 'over';
    this.winner = winner || null;
    this.clearTurnTimer();

    const announcement = winner
      ? `${winner.name} wins! Chat history for this match has been deleted.`
      : 'Game over. Chat history for this match has been deleted.';

    // Chat dies with the game - drop it from memory and from Atlas.
    this.chat = [];
    this.emit('chat:cleared', { reason: 'game-over' });
    this.emit('game:over', {
      winner: this.winner,
      reason: 'win',
      message: announcement,
    });
    this.emitState();

    const removed = await chatStore.wipe(this.id);
    this.emit('chat:deleted', { count: removed });

    this.clearResetTimer();
    this.resetTimer = setTimeout(() => {
      this.resetToLobby('Ready for another round.');
    }, RESET_AFTER_OVER_MS);
  }

  /** Not enough people left to keep playing. */
  async abandon(reason) {
    if (this.status !== 'playing') return;
    this.status = 'over';
    this.winner = null;
    this.clearTurnTimer();
    this.chat = [];

    this.emit('chat:cleared', { reason: 'game-over' });
    this.emit('game:over', {
      winner: null,
      reason: 'abandoned',
      message: reason || 'Not enough players - the match was cancelled.',
    });
    this.emitState();

    await chatStore.wipe(this.id);
    this.clearResetTimer();
    this.resetTimer = setTimeout(() => this.resetToLobby(reason), 4000);
  }

  resetToLobby(message) {
    this.clearResetTimer();
    this.clearTurnTimer();
    this.status = 'lobby';
    this.game = null;
    this.winner = null;
    this.chat = [];

    // Players who were watching get first refusal on the free seats.
    for (const player of this.players) {
      if (!player.spectator) continue;
      if (this.seatedPlayers().length >= MAX_PLAYERS) break;
      player.spectator = false;
      player.color = this.pickColor();
    }

    if (!this.find(this.hostId)) {
      const nextHost = this.players.find((p) => !p.spectator) || this.players[0];
      this.hostId = nextHost ? nextHost.id : null;
    }

    if (message) this.pushSystemMessage(message);
    this.emitState();
  }

  /** Re-run the turn bookkeeping after the player list changed. */
  afterStateChange() {
    if (this.status !== 'playing' || !this.game || this.game.over) return;
    if (this.game.players.length === 0) {
      this.abandon('The table emptied out.');
      return;
    }
    if (this.connectedSeated().filter((p) => this.game.players.some((gp) => gp.id === p.id)).length < MIN_PLAYERS) {
      this.abandon('Everyone left - not enough players to continue.');
      return;
    }
    this.scheduleTurnTimer();
  }

  /**
   * If the player on the clock has gone offline, give them a moment and then
   * move the game along so nobody gets stuck waiting.
   */
  scheduleTurnTimer() {
    this.clearTurnTimer();
    if (this.status !== 'playing' || !this.game || this.game.over) return;

    const owner = this.game.currentPlayer;
    const seat = this.find(owner.id);
    if (seat && seat.connected) return;

    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (this.status !== 'playing' || !this.game || this.game.over) return;
      if (this.game.currentPlayer.id !== owner.id) return;

      this.game.endTurn();
      this.game.lastEvent = {
        type: 'skip',
        message: `${owner.name} is away - turn skipped`,
      };
      this.emitState();
      this.scheduleTurnTimer();
    }, DISCONNECT_SKIP_MS);
  }

  /* ------------------------------------------------------------------ */
  /* chat                                                                */
  /* ------------------------------------------------------------------ */

  pushSystemMessage(text) {
    const packet = {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      playerId: 'system',
      name: 'Table',
      color: null,
      text,
      kind: 'system',
      sentAt: Date.now(),
    };
    this.remember(packet);
    this.emit('chat:message', packet);
    return packet;
  }

  /** Record a message in memory (and in Atlas while a match is running). */
  remember(packet) {
    this.chat.push(packet);
    if (this.chat.length > CHAT_MEMORY_LIMIT) {
      this.chat.splice(0, this.chat.length - CHAT_MEMORY_LIMIT);
    }
  }

  /** Persist + broadcast a chat message. */
  async addChat(player, text) {
    const packet = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      playerId: player.id,
      name: player.name,
      color: player.color,
      text,
      kind: 'chat',
      sentAt: Date.now(),
    };

    this.remember(packet);
    this.emit('chat:message', packet);

    // Chat is only written to Atlas while the match is live; it is wiped the
    // moment the game ends.
    if (this.status === 'playing') {
      await chatStore.save({ ...packet, room: this.id });
    }

    this.lastActivity = Date.now();
    return packet;
  }

  /* ------------------------------------------------------------------ */
  /* serialization                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Public snapshot for every client in the room.
   * The per-player session token is deliberately never included here - this
   * payload is broadcast to everyone at the table.
   */
  serialize() {
    return {
      roomId: this.id,
      status: this.status,
      hostId: this.hostId,
      maxPlayers: MAX_PLAYERS,
      minPlayers: MIN_PLAYERS,
      winner: this.winner,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        colorLabel: p.color ? COLOR_LABELS[p.color] : null,
        connected: p.connected,
        spectator: p.spectator,
        isHost: p.id === this.hostId,
      })),
      game: this.game ? this.game.serialize() : null,
    };
  }

  emitState() {
    this.emit('room:update', this.serialize());
  }

  destroy() {
    this.clearTurnTimer();
    this.clearResetTimer();
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.players = [];
  }
}

module.exports = Room;
module.exports.MAX_PLAYERS = MAX_PLAYERS;
module.exports.MIN_PLAYERS = MIN_PLAYERS;
module.exports.channel = channel;
