'use strict';

const { config } = require('./config');
const { RateLimiter } = require('./security');
const { channel } = require('./game/Room');

const ROOM_CODE_RE = /^[A-Z0-9]{5}$/;

/**
 * Strip anything that could be used to corrupt or spoof the chat panel:
 * control characters, newlines and the bidirectional overrides that let a
 * message render as somebody else's.
 */
function sanitizeText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Socket.IO handshake address, honouring the proxy hop when configured. */
function socketIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (config.trustProxy && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return socket.handshake.address || 'unknown';
}

/**
 * Register every realtime event handler.
 * @param {import('socket.io').Server} io
 * @param {import('./game/roomManager')} rooms
 * @returns {{stop: () => void}} limiter cleanup for graceful shutdown
 */
function registerSocketHandlers(io, rooms) {
  const limiters = {
    create: new RateLimiter({ ...config.limits.roomCreate, name: 'room:create' }),
    join: new RateLimiter({ ...config.limits.roomJoin, name: 'room:join' }),
    chat: new RateLimiter({ ...config.limits.chat, name: 'chat' }),
    action: new RateLimiter({ ...config.limits.gameAction, name: 'game-action' }),
  };

  const connectionsInRoom = (roomId) => {
    const members = io.sockets.adapter.rooms.get(channel(roomId));
    return members ? members.size : 0;
  };

  /** Live socket count per address, so one client cannot exhaust the server. */
  const liveByIp = new Map();

  io.use((socket, next) => {
    const ip = socketIp(socket);
    if ((liveByIp.get(ip) || 0) >= config.socket.maxConnectionsPerIp) {
      return next(new Error('Too many open connections from this address.'));
    }
    socket.data.ip = ip;
    return next();
  });

  io.on('connection', (socket) => {
    const ip = socket.data.ip || socketIp(socket);
    liveByIp.set(ip, (liveByIp.get(ip) || 0) + 1);

    const currentRoom = () => rooms.get(socket.data.roomId);
    const notify = (message, type = 'error') => socket.emit('notice', { type, message });

    /** Seat a socket in a room and send it everything it needs. */
    async function seat(room, { id, name, token }) {
      const { player, rejoined, token: issued } = room.addPlayer({
        id,
        name,
        token,
        socketId: socket.id,
      });

      if (socket.data.roomId && socket.data.roomId !== room.id) {
        socket.leave(channel(socket.data.roomId));
      }
      socket.join(channel(room.id));
      socket.data.roomId = room.id;
      socket.data.playerId = player.id;

      await room.hydrateChat();

      socket.emit('chat:sync', { messages: room.chat });
      socket.emit('room:update', room.serialize());

      if (!rejoined && room.status !== 'over') {
        room.pushSystemMessage(
          player.spectator
            ? `${player.name} is watching this table`
            : `${player.name} joined the table`
        );
      }
      room.emitState();

      return { player, rejoined, token: issued };
    }

    /* ---------------------------------------------------------------- */
    /* rooms                                                             */
    /* ---------------------------------------------------------------- */

    socket.on('room:create', async (payload = {}, ack) => {
      try {
        const verdict = limiters.create.check(ip);
        if (!verdict.allowed) {
          return fail(ack, 'Too many rooms created from here. Try again in a minute.');
        }
        if (rooms.rooms.size >= config.rooms.maxRooms) {
          return fail(ack, 'The server is at capacity right now. Please retry shortly.');
        }

        const room = rooms.create();
        if (!room) {
          return fail(ack, 'The server is at capacity right now. Please retry shortly.');
        }

        const { player, token } = await seat(room, {
          id: sanitizeText(payload.playerId, 64),
          token: sanitizeText(payload.token, 128),
          name: sanitizeText(payload.name, config.limits.nameLength),
        });

        ok(ack, {
          roomId: room.id,
          playerId: player.id,
          token,
          seated: !player.spectator,
        });
      } catch (err) {
        console.error('[socket] room:create failed:', err);
        fail(ack, 'Could not create the room.');
      }
    });

    socket.on('room:join', async (payload = {}, ack) => {
      try {
        const verdict = limiters.join.check(ip);
        if (!verdict.allowed) {
          return fail(ack, 'Too many join attempts. Please wait a moment.');
        }

        const roomId = sanitizeText(payload.roomId, 8).toUpperCase();
        if (!ROOM_CODE_RE.test(roomId)) {
          return fail(ack, 'Room codes are exactly 5 letters or digits.');
        }

        const room = rooms.get(roomId);
        if (!room) return fail(ack, `No table found with the code "${roomId}".`);

        if (connectionsInRoom(roomId) >= config.socket.maxConnectionsPerRoom) {
          return fail(ack, 'This table is full right now.');
        }

        const { player, token } = await seat(room, {
          id: sanitizeText(payload.playerId, 64),
          token: sanitizeText(payload.token, 128),
          name: sanitizeText(payload.name, config.limits.nameLength),
        });

        ok(ack, {
          roomId: room.id,
          playerId: player.id,
          token,
          seated: !player.spectator,
        });
      } catch (err) {
        console.error('[socket] room:join failed:', err);
        fail(ack, 'Could not join that room.');
      }
    });

    socket.on('room:leave', () => {
      const room = currentRoom();
      if (!room) return;

      const removed = room.handleLeave(socket.data.playerId);
      socket.leave(channel(room.id));
      socket.data.roomId = null;
      socket.data.playerId = null;

      if (removed) {
        room.pushSystemMessage(`${removed.name} left the table`);
        room.emitState();
        room.afterStateChange();
      }

      if (!room.players.some((p) => p.connected) && room.status !== 'playing') {
        rooms.delete(room.id);
      }

      socket.emit('room:left', { roomId: room.id });
    });

    socket.on('room:start', (ack) => {
      const room = currentRoom();
      if (!room) return fail(ack, 'Join a table first.');

      const result = room.start(socket.data.playerId);
      if (!result.ok) return fail(ack, result.error);

      room.emitState();
      ok(ack, { players: result.players });
    });

    /** Nudge the whole table to the next round from the results screen. */
    socket.on('room:reset', () => {
      const room = currentRoom();
      if (!room) return;
      if (room.status === 'over') room.resetToLobby('Back in the lobby.');
    });

    /* ---------------------------------------------------------------- */
    /* gameplay                                                          */
    /* ---------------------------------------------------------------- */

    const tooFast = () => {
      const verdict = limiters.action.check(socket.id);
      if (!verdict.allowed) notify('Slow down a little.', 'warn');
      return !verdict.allowed;
    };

    socket.on('game:roll', () => {
      const room = currentRoom();
      if (!room) return;
      if (room.status !== 'playing' || !room.game) {
        return notify('The game is not running.');
      }
      if (tooFast()) return;

      const result = room.game.roll(socket.data.playerId);
      if (!result.ok) {
        notify(result.error);
        room.emitState();
        return;
      }

      room.emit('game:rolled', {
        playerId: socket.data.playerId,
        color: result.color,
        value: result.value,
        moves: result.moves,
        pass: !!result.pass,
        forfeit: !!result.forfeit,
      });
      room.emitState();

      if (result.pass) room.scheduleTurnTimer();
    });

    socket.on('game:move', (payload = {}) => {
      const room = currentRoom();
      if (!room) return;
      if (room.status !== 'playing' || !room.game) {
        return notify('The game is not running.');
      }
      if (tooFast()) return;

      const tokenIndex = Number(payload.tokenIndex);
      if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex > 3) {
        return notify('Invalid token.');
      }

      const result = room.game.move(socket.data.playerId, tokenIndex);
      if (!result.ok) {
        notify(result.error);
        room.emitState();
        return;
      }

      room.emit('game:moved', {
        playerId: socket.data.playerId,
        color: result.color,
        tokenIndex,
        from: result.from,
        to: result.to,
        captured: result.captured,
        reachedHome: result.reachedHome,
        extraTurn: result.extraTurn,
      });

      if (result.finished) {
        room.finish(result.winner).catch((err) =>
          console.error('[socket] finish failed:', err)
        );
        return;
      }

      room.emitState();
      room.scheduleTurnTimer();
    });

    /* ---------------------------------------------------------------- */
    /* chat                                                              */
    /* ---------------------------------------------------------------- */

    socket.on('chat:send', async (payload = {}, ack) => {
      const room = currentRoom();
      if (!room) return fail(ack, 'Join a table first.');

      const player = room.find(socket.data.playerId);
      if (!player) return fail(ack, 'Join a table first.');

      const text = sanitizeText(payload.text, config.limits.messageLength);
      if (!text) return fail(ack, 'Type something first.');

      const verdict = limiters.chat.check(socket.id);
      if (!verdict.allowed) {
        return fail(ack, 'You are sending messages too fast.');
      }

      try {
        await room.addChat(player, text);
        ok(ack);
      } catch (err) {
        console.error('[socket] chat:send failed:', err);
        fail(ack, 'Message could not be sent.');
      }
    });

    socket.on('chat:history', async (ack) => {
      const room = currentRoom();
      if (!room) return fail(ack, 'Join a table first.');
      await room.hydrateChat();
      ok(ack, { messages: room.chat });
    });

    /* ---------------------------------------------------------------- */
    /* disconnect                                                        */
    /* ---------------------------------------------------------------- */

    socket.on('disconnect', (reason) => {
      const remaining = (liveByIp.get(ip) || 1) - 1;
      if (remaining <= 0) liveByIp.delete(ip);
      else liveByIp.set(ip, remaining);

      limiters.chat.reset(socket.id);
      limiters.action.reset(socket.id);

      const room = currentRoom();
      if (!room) return;

      const player = room.find(socket.data.playerId);
      if (!player) return;

      // A reconnect that already took over this player keeps the seat.
      if (player.socketId && player.socketId !== socket.id) return;

      room.handleDisconnect(player.id);
      if (reason !== 'client namespace disconnect' && reason !== 'server namespace disconnect') {
        room.pushSystemMessage(`${player.name} lost connection`);
      }
      room.emitState();
      room.afterStateChange();
    });
  });

  return {
    stop() {
      Object.values(limiters).forEach((limiter) => limiter.stop());
      liveByIp.clear();
    },
  };
}

const ok = (ack, payload = {}) => {
  if (typeof ack === 'function') ack({ ok: true, ...payload });
};
const fail = (ack, error) => {
  if (typeof ack === 'function') ack({ ok: false, error });
};

module.exports = registerSocketHandlers;
