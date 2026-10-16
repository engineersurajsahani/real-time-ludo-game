'use strict';

const mongoose = require('mongoose');

/**
 * A single chat message.
 *
 * Messages only exist for the lifetime of a game: room chat is persisted to
 * MongoDB Atlas while a match is running and the whole room's history is
 * deleted the moment the game ends.
 */
const ChatMessageSchema = new mongoose.Schema(
  {
    room: { type: String, required: true, index: true },
    playerId: { type: String, required: true },
    name: { type: String, required: true },
    color: { type: String, default: null },
    text: { type: String, required: true, maxlength: 400 },
    kind: { type: String, enum: ['chat', 'system'], default: 'chat' },
    sentAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Lookups and wipes are always scoped to a room, newest first.
ChatMessageSchema.index({ room: 1, sentAt: 1 });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
