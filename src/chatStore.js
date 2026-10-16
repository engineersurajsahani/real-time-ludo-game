'use strict';

const ChatMessage = require('./models/ChatMessage');
const { isReady } = require('./db');

/**
 * Room-scoped chat storage.
 *
 * While a game is running the messages live in MongoDB Atlas. The in-memory
 * copy in `Room` keeps the UI instant and also covers the "no database"
 * development mode. When a game ends the room's database documents are
 * deleted for good, which is the whole point of this module.
 */

/** Persist one packet. Resolves to false when Atlas is unavailable. */
async function save(packet) {
  if (!isReady()) return false;
  try {
    await ChatMessage.create({
      room: packet.room,
      playerId: packet.playerId,
      name: packet.name,
      color: packet.color || null,
      text: packet.text,
      kind: packet.kind || 'chat',
      sentAt: new Date(packet.sentAt || Date.now()),
    });
    return true;
  } catch (err) {
    console.error('[chatStore] save failed:', err.message);
    return false;
  }
}

/** Load the surviving history for a room (newest `limit` messages, in order). */
async function history(roomId, limit = 100) {
  if (!isReady()) return [];
  try {
    const docs = await ChatMessage.find({ room: roomId })
      .sort({ sentAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    return docs.reverse().map((doc) => ({
      id: String(doc._id),
      playerId: doc.playerId,
      name: doc.name,
      color: doc.color,
      text: doc.text,
      kind: doc.kind,
      sentAt: doc.sentAt instanceof Date ? doc.sentAt.getTime() : doc.sentAt,
    }));
  } catch (err) {
    console.error('[chatStore] history failed:', err.message);
    return [];
  }
}

/** Hard-delete everything stored for a room. Called when the game ends. */
async function wipe(roomId) {
  if (!isReady()) return 0;
  try {
    const result = await ChatMessage.deleteMany({ room: roomId });
    const removed = result.deletedCount || 0;
    console.log(`[chatStore] wiped ${removed} message(s) for room ${roomId}`);
    return removed;
  } catch (err) {
    console.error('[chatStore] wipe failed:', err.message);
    return 0;
  }
}

module.exports = { save, history, wipe };
