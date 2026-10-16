'use strict';

const Room = require('./Room');
const { config } = require('../config');

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const ROOM_CODE_LENGTH = 5;

/** In-memory registry of live tables. */
class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();

    this.sweeper = setInterval(() => this.sweep(), 1000 * 60 * 10);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  static makeCode() {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    return code;
  }

  get(roomId) {
    if (!roomId) return null;
    const code = String(roomId).trim().toUpperCase();
    if (code.length !== ROOM_CODE_LENGTH) return null;
    return this.rooms.get(code) || null;
  }

  /** @returns {Room|null} null when the server is at capacity */
  create() {
    if (this.rooms.size >= config.rooms.maxRooms) {
      console.warn(`[rooms] at capacity (${config.rooms.maxRooms}) - refusing to create`);
      return null;
    }

    let code = RoomManager.makeCode();
    while (this.rooms.has(code)) code = RoomManager.makeCode();

    const room = new Room(code, this.io);
    this.rooms.set(code, room);
    return room;
  }

  delete(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.destroy();
    this.rooms.delete(roomId);
  }

  /** Drop rooms that are empty or have gone quiet. */
  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const anyoneHere = room.players.some((p) => p.connected);
      if (!anyoneHere) {
        this.delete(code);
        continue;
      }
      if (now - room.lastActivity > config.rooms.idleTtlMs) {
        room.emit('notice', { type: 'warn', message: 'Room closed after being idle.' });
        this.delete(code);
      }
    }
  }

  stats() {
    let players = 0;
    for (const room of this.rooms.values()) players += room.players.length;
    return { rooms: this.rooms.size, players };
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const code of [...this.rooms.keys()]) this.delete(code);
  }
}

module.exports = RoomManager;
