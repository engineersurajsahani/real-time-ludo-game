'use strict';

const crypto = require('crypto');

/**
 * Player identity.
 *
 * The server - never the client - decides who a player is. A player id is
 * useless on its own: re-attaching to an existing seat also requires the secret
 * token that was issued alongside it, so a guessed id cannot hijack a seat.
 */

/** Public, non-secret identifier. */
function newPlayerId() {
  return `p_${crypto.randomBytes(12).toString('base64url')}`;
}

/** Secret handed to exactly one browser tab. */
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Constant-time string comparison that never throws on odd input. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** True only when this pair may reclaim the seat it belongs to. */
function matches(player, id, token) {
  if (!player) return false;
  if (!safeEqual(player.id, id)) return false;
  return safeEqual(player.token, token);
}

module.exports = { newPlayerId, newToken, safeEqual, matches };
