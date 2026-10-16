'use strict';

const {
  TRACK_LENGTH,
  START_INDEX,
  SAFE_INDICES,
  FINISH,
  COLOR_LABELS,
} = require('./constants');

const SAFE = new Set(SAFE_INDICES);
const SIXES_BEFORE_FORFEIT = 3;

/** Absolute square index on the shared 52-square ring for a given token pos. */
function squareIndex(color, pos) {
  return (START_INDEX[color] + pos) % TRACK_LENGTH;
}

/**
 * Authoritative Ludo rules engine for a single table.
 *
 * Token positions are integers; see `constants.js` for the encoding.
 * The class is pure (no timers, no sockets) so it stays easy to reason about.
 */
class LudoGame {
  /**
   * @param {Array<{id: string, name: string, color: string}>} seatedPlayers
   *        players in turn order (seat order == colour order).
   */
  constructor(seatedPlayers) {
    this.players = seatedPlayers.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
    }));

    this.tokens = {};
    for (const player of this.players) {
      this.tokens[player.color] = [-1, -1, -1, -1];
    }

    this.turnIndex = 0;
    this.dice = null;
    this.lastRoll = null;
    this.awaitingMove = false;
    this.legalMoves = [];
    this.consecutiveSixes = 0;
    this.finishedOrder = [];
    this.over = false;
    this.winner = null;
    this.startedAt = Date.now();
    this.moveCount = 0;
    this.lastEvent = {
      type: 'start',
      message: `${this.players[0].name} rolls first as ${COLOR_LABELS[this.players[0].color]}`,
    };
  }

  get currentPlayer() {
    return this.players[this.turnIndex];
  }

  get currentColor() {
    return this.currentPlayer.color;
  }

  playerByColor(color) {
    return this.players.find((p) => p.color === color) || null;
  }

  /** Token indexes the player is allowed to move with `value`. */
  computeLegalMoves(color, value) {
    if (!value) return [];
    const positions = this.tokens[color];
    if (!positions) return [];

    const moves = [];
    positions.forEach((pos, index) => {
      if (pos === -1) {
        // Leaving the yard always costs the whole roll of a six.
        if (value === 6) moves.push(index);
      } else if (pos < FINISH && pos + value <= FINISH) {
        // Must land exactly on the centre - no overshooting.
        moves.push(index);
      }
    });
    return moves;
  }

  /**
   * Roll for the player whose turn it is.
   * @returns {{ok: boolean, error?: string, value?: number, moves?: number[],
   *            pass?: boolean, forfeit?: boolean, color?: string}}
   */
  roll(playerId) {
    if (this.over) return { ok: false, error: 'The game is already over.' };
    if (this.currentPlayer.id !== playerId) {
      return { ok: false, error: 'It is not your turn.' };
    }
    if (this.awaitingMove) {
      return { ok: false, error: 'Move a token first.' };
    }

    const value = 1 + Math.floor(Math.random() * 6);
    const color = this.currentColor;
    this.dice = value;
    this.lastRoll = { color, value, playerId };

    if (value === 6) {
      this.consecutiveSixes += 1;
    }

    // Classic rule: three sixes in a row and the turn is forfeited.
    if (this.consecutiveSixes >= SIXES_BEFORE_FORFEIT) {
      const player = this.currentPlayer;
      this.lastEvent = {
        type: 'forfeit',
        message: `${player.name} rolled three sixes in a row - turn forfeited`,
        color,
      };
      this.endTurn();
      return { ok: true, value, moves: [], pass: true, forfeit: true, color };
    }

    const moves = this.computeLegalMoves(color, value);
    if (moves.length === 0) {
      this.lastEvent = {
        type: 'no-move',
        message: `${this.currentPlayer.name} rolled ${value} - no token can move`,
        color,
        value,
      };
      this.endTurn();
      return { ok: true, value, moves: [], pass: true, color };
    }

    this.legalMoves = moves;
    this.awaitingMove = true;
    this.lastEvent = {
      type: 'roll',
      message: `${this.currentPlayer.name} rolled ${value}`,
      color,
      value,
    };
    return { ok: true, value, moves, pass: false, color };
  }

  /**
   * Apply a token move for the player whose turn it is.
   * @returns {{ok: boolean, error?: string, ...}}
   */
  move(playerId, tokenIndex) {
    if (this.over) return { ok: false, error: 'The game is already over.' };
    if (this.currentPlayer.id !== playerId) {
      return { ok: false, error: 'It is not your turn.' };
    }
    if (!this.awaitingMove || !this.dice) {
      return { ok: false, error: 'Roll the dice first.' };
    }
    if (!this.legalMoves.includes(tokenIndex)) {
      return { ok: false, error: 'That token cannot move.' };
    }

    const color = this.currentColor;
    const player = this.currentPlayer;
    const value = this.dice;
    const from = this.tokens[color][tokenIndex];
    const to = from === -1 ? 0 : from + value;

    this.tokens[color][tokenIndex] = to;
    this.moveCount += 1;

    let extraTurn = value === 6;
    const captured = [];

    // Capture only happens on the shared ring, never inside a home stretch,
    // and never on a safe square.
    if (to <= TRACK_LENGTH - 1) {
      const landing = squareIndex(color, to);
      if (!SAFE.has(landing)) {
        for (const opponent of this.players) {
          if (opponent.color === color) continue;
          const opponentTokens = this.tokens[opponent.color];
          if (!opponentTokens) continue;
          opponentTokens.forEach((pos, index) => {
            if (pos < 0 || pos > TRACK_LENGTH - 1) return;
            if (squareIndex(opponent.color, pos) !== landing) return;
            this.tokens[opponent.color][index] = -1;
            captured.push({ color: opponent.color, tokenIndex: index });
          });
        }
        if (captured.length) extraTurn = true;
      }
    }

    const reachedHome = to === FINISH;
    if (reachedHome) extraTurn = true;

    // Has this player finished all four tokens?
    const allHome = this.tokens[color].every((pos) => pos === FINISH);
    if (allHome && !this.finishedOrder.includes(color)) {
      this.finishedOrder.push(color);
    }

    const parts = [`${player.name} moved a token`];
    if (from === -1) parts[0] = `${player.name} brought a token out`;
    if (captured.length) {
      const victims = [...new Set(captured.map((c) => COLOR_LABELS[c.color]))].join(', ');
      parts.push(`and knocked out ${victims}!`);
    }
    if (reachedHome) parts.push('- token reached home');

    this.lastEvent = {
      type: captured.length ? 'capture' : reachedHome ? 'home' : 'move',
      message: parts.join(' '),
      color,
      from,
      to,
      captured: captured.length,
    };

    this.dice = null;
    this.awaitingMove = false;
    this.legalMoves = [];

    if (allHome) {
      this.over = true;
      this.winner = {
        id: player.id,
        name: player.name,
        color: player.color,
      };
      this.lastEvent = {
        type: 'win',
        message: `${player.name} finished all four tokens and wins!`,
        color,
      };
      return {
        ok: true,
        color,
        from,
        to,
        captured,
        reachedHome,
        extraTurn: false,
        finished: true,
        winner: this.winner,
      };
    }

    if (extraTurn) {
      this.lastEvent.message += value === 6 ? ' (rolls again)' : ' (rolls again)';
    } else {
      this.endTurn();
    }

    return {
      ok: true,
      color,
      from,
      to,
      captured,
      reachedHome,
      extraTurn,
      finished: false,
      winner: null,
    };
  }

  /** Advance to the next seated player, clearing the dice. */
  endTurn() {
    this.turnIndex = (this.turnIndex + 1) % this.players.length;
    this.dice = null;
    this.awaitingMove = false;
    this.legalMoves = [];
    this.consecutiveSixes = 0;
  }

  /** Legal moves for the player whose turn it is (empty array otherwise). */
  legalMovesFor(playerId) {
    if (this.over || !this.awaitingMove) return [];
    if (this.currentPlayer.id !== playerId) return [];
    return this.legalMoves;
  }

  /** The full public snapshot broadcast to every client in the room. */
  serialize() {
    return {
      status: this.over ? 'over' : 'playing',
      turnColor: this.currentColor,
      turnPlayerId: this.currentPlayer.id,
      dice: this.awaitingMove ? this.dice : null,
      lastRoll: this.lastRoll,
      awaitingMove: this.awaitingMove,
      tokens: this.tokens,
      finishedOrder: this.finishedOrder,
      lastEvent: this.lastEvent,
      moveCount: this.moveCount,
      winner: this.winner,
      legalMoves: this.players.reduce((acc, player) => {
        acc[player.id] = this.legalMovesFor(player.id);
        return acc;
      }, {}),
    };
  }
}

module.exports = LudoGame;
module.exports.squareIndex = squareIndex;
