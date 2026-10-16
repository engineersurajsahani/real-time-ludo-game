'use strict';

/**
 * Board geometry for a standard 15x15 Ludo board.
 *
 * Everything is expressed in grid coordinates where `[row, col]` is a cell of
 * the 15x15 board (0-indexed). The client renders the same constants, so the
 * server stays authoritative for positions while the browser handles animation.
 */

const COLORS = ['red', 'green', 'yellow', 'blue'];

const COLOR_LABELS = {
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
};

// The shared 52 square ring, clockwise.
// Starts on red's entry square and ends one step before it.
const TRACK = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],           //  0- 4  left arm (upper row)
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],   //  5-10  top arm (left col)
  [0, 7], [0, 8],                                    // 11-12  top corner
  [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],            // 13-17  top arm (right col)
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14], // 18-23 right arm (top row)
  [7, 14], [8, 14],                                  // 24-25  right corner
  [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],        // 26-30  right arm (bottom row)
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], // 31-36 bottom arm (right col)
  [14, 7], [14, 6],                                  // 37-38  bottom corner
  [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],        // 39-43  bottom arm (left col)
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],    // 44-49  left arm (lower row)
  [7, 0], [6, 0],                                    // 50-51  left corner
];

const TRACK_LENGTH = TRACK.length; // 52

// Where each colour enters the shared ring (a.k.a. the coloured start square).
const START_INDEX = {
  red: 0,
  green: 13,
  yellow: 26,
  blue: 39,
};

// Squares where a token can never be captured.
const SAFE_INDICES = [0, 8, 13, 21, 26, 34, 39, 47];

// The 5-square coloured stretch leading into the centre for each colour.
const HOME_PATH = {
  red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
  blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
};

const HOME_STRETCH = 5;

/**
 * Token position encoding used everywhere on the wire:
 *   -1            -> still parked in the yard
 *    0..51        -> steps travelled along the shared ring
 *   52..56        -> steps inside the colour's home stretch
 *   57 (FINISH)   -> reached the centre, token is done
 */
const FINISH = TRACK_LENGTH + HOME_STRETCH; // 57

// Yard corner occupied by each colour, and the 4 parking slots inside it.
const YARD_BASE = {
  red: [0, 0],
  green: [0, 9],
  yellow: [9, 9],
  blue: [9, 0],
};

// Parking slot centres in grid units (0..15) - used by the client renderer.
const YARD_SLOTS = {
  red: [[2, 2], [2, 4], [4, 2], [4, 4]],
  green: [[2, 11], [2, 13], [4, 11], [4, 13]],
  yellow: [[11, 11], [11, 13], [13, 11], [13, 13]],
  blue: [[11, 2], [11, 4], [13, 2], [13, 4]],
};

// Colours of the 4 centre triangles, drawn clockwise from the top-left.
const CENTRE_SPREAD = {
  red: { axis: 'row', fixed: 6.95 },
  green: { axis: 'col', fixed: 6.95 },
  yellow: { axis: 'row', fixed: 8.05 },
  blue: { axis: 'col', fixed: 8.05 },
};

module.exports = {
  COLORS,
  COLOR_LABELS,
  TRACK,
  TRACK_LENGTH,
  START_INDEX,
  SAFE_INDICES,
  HOME_PATH,
  HOME_STRETCH,
  FINISH,
  YARD_BASE,
  YARD_SLOTS,
  CENTRE_SPREAD,
};
