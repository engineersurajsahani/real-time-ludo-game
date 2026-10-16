/* =====================================================================
   Ludo Royale - board geometry + DOM renderer
   Mirrors src/game/constants.js so the server and browser agree on every
   square, while the browser owns only the animation side of things.
   ===================================================================== */
(function () {
  'use strict';

  const COLORS = ['red', 'green', 'yellow', 'blue'];

  const COLOR_HEX = {
    red: '#f2455b',
    green: '#22c98a',
    yellow: '#f0b429',
    blue: '#3d8bfd',
  };

  const TRACK = [
    [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
    [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
    [0, 7], [0, 8],
    [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
    [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
    [7, 14], [8, 14],
    [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
    [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
    [14, 7], [14, 6],
    [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
    [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
    [7, 0], [6, 0],
  ];

  const TRACK_LENGTH = TRACK.length; // 52

  const START_INDEX = { red: 0, green: 13, yellow: 26, blue: 39 };
  const SAFE_INDICES = [0, 8, 13, 21, 26, 34, 39, 47];

  const HOME_PATH = {
    red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
    green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
    yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
    blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  };

  const HOME_STRETCH = 5;
  const FINISH = TRACK_LENGTH + HOME_STRETCH; // 57

  const YARD_BASE = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] };

  const YARD_SLOTS = {
    red: [[2, 2], [2, 4], [4, 2], [4, 4]],
    green: [[2, 11], [2, 13], [4, 11], [4, 13]],
    yellow: [[11, 11], [11, 13], [13, 11], [13, 13]],
    blue: [[11, 2], [11, 4], [13, 2], [13, 4]],
  };

  // Where the four finished tokens fan out inside the centre triangle.
  const CENTRE_SPREAD = {
    red: { axis: 'row', fixed: 6.95 },
    green: { axis: 'col', fixed: 6.95 },
    yellow: { axis: 'row', fixed: 8.05 },
    blue: { axis: 'col', fixed: 8.05 },
  };

  const key = (r, c) => `${r}:${c}`;

  const trackLookup = new Map(TRACK.map((cell, index) => [key(cell[0], cell[1]), index]));
  const homeLookup = new Map();
  COLORS.forEach((color) => {
    HOME_PATH[color].forEach(([r, c]) => homeLookup.set(key(r, c), color));
  });
  const startLookup = new Map();
  COLORS.forEach((color) => startLookup.set(START_INDEX[color], color));
  const safeSet = new Set(SAFE_INDICES);

  /** Describe one board square. */
  function cellInfo(r, c) {
    if (r >= 6 && r <= 8 && c >= 6 && c <= 8) return { type: 'center' };

    const home = homeLookup.get(key(r, c));
    if (home) return { type: 'home', color: home };

    const index = trackLookup.get(key(r, c));
    if (index !== undefined) {
      return {
        type: 'track',
        index,
        startColor: startLookup.get(index) || null,
        safe: safeSet.has(index),
      };
    }

    if (r <= 5 && c <= 5) return { type: 'yard', color: 'red' };
    if (r <= 5 && c >= 9) return { type: 'yard', color: 'green' };
    if (r >= 9 && c >= 9) return { type: 'yard', color: 'yellow' };
    if (r >= 9 && c <= 5) return { type: 'yard', color: 'blue' };

    return { type: 'empty' };
  }

  /**
   * Centre point of a token inside the board, in grid units (0..15).
   * @returns {[number, number]} [row, col]
   */
  function gridPos(color, pos, tokenIndex) {
    if (pos === -1 || pos === null || pos === undefined) {
      const slot = YARD_SLOTS[color][tokenIndex];
      return [slot[0], slot[1]];
    }
    if (pos <= TRACK_LENGTH - 1) {
      const [r, c] = TRACK[(START_INDEX[color] + pos) % TRACK_LENGTH];
      return [r + 0.5, c + 0.5];
    }
    if (pos <= FINISH - 1) {
      const [r, c] = HOME_PATH[color][pos - TRACK_LENGTH];
      return [r + 0.5, c + 0.5];
    }
    const spread = CENTRE_SPREAD[color];
    const offset = (tokenIndex - 1.5) * 0.5;
    return spread.axis === 'row'
      ? [7.5 + offset, spread.fixed]
      : [spread.fixed, 7.5 + offset];
  }

  /** Nudge overlapping tokens apart so stacks stay readable. */
  function spreadStack(list) {
    const groups = new Map();
    list.forEach((item) => {
      const k = `${item.row.toFixed(2)}|${item.col.toFixed(2)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(item);
    });

    groups.forEach((group) => {
      if (group.length < 2) return;
      group.forEach((item, i) => {
        const angle = (Math.PI * 2 * i) / group.length - Math.PI / 2;
        item.row += Math.sin(angle) * 0.26;
        item.col += Math.cos(angle) * 0.26;
        item.stacked = true;
      });
    });

    return list;
  }

  /** Build the static 225-cell board inside `container`. */
  function buildBoard(container) {
    container.innerHTML = '';
    const fragment = document.createDocumentFragment();

    for (let r = 0; r < 15; r += 1) {
      for (let c = 0; c < 15; c += 1) {
        const info = cellInfo(r, c);
        if (info.type === 'center') continue;

        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);

        if (info.type === 'yard') {
          cell.classList.add('cell-yard');
          cell.style.setProperty('--c', COLOR_HEX[info.color]);
        } else if (info.type === 'home') {
          cell.classList.add('cell-home');
          cell.style.setProperty('--c', COLOR_HEX[info.color]);
        } else if (info.type === 'track') {
          cell.classList.add('cell-track');
          if (info.startColor) {
            cell.classList.add('cell-start');
            cell.style.setProperty('--c', COLOR_HEX[info.startColor]);
          } else if (info.safe) {
            cell.classList.add('cell-safe');
          }
        }

        fragment.appendChild(cell);
      }
    }

    container.appendChild(fragment);

    // The white inner square of each yard, drawn above the coloured cells.
    COLORS.forEach((color) => {
      const [r0, c0] = YARD_BASE[color];
      const box = document.createElement('div');
      box.className = 'yard-box';
      box.style.top = `${((r0 + 1) / 15) * 100}%`;
      box.style.left = `${((c0 + 1) / 15) * 100}%`;
      box.style.width = `${(4 / 15) * 100}%`;
      box.style.height = `${(4 / 15) * 100}%`;
      container.appendChild(box);
    });

    const centre = document.createElement('div');
    centre.className = 'board-center';
    container.appendChild(centre);

    // Keep the marker glyphs in proportion with the cells.
    const resize = () => {
      const width = container.clientWidth;
      if (width) container.style.fontSize = `${width / 15}px`;
    };
    resize();
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(resize);
      observer.observe(container);
    } else {
      window.addEventListener('resize', resize);
    }
  }

  /** Create the 16 token elements and return them keyed by `color:index`. */
  function createTokens(layer) {
    layer.innerHTML = '';
    const tokens = {};

    COLORS.forEach((color) => {
      for (let i = 0; i < 4; i += 1) {
        const el = document.createElement('div');
        el.className = 'token token-new';
        el.dataset.color = color;
        el.dataset.index = String(i);
        el.style.setProperty('--c', COLOR_HEX[color]);

        const inner = document.createElement('div');
        inner.className = 'token-3d';
        el.appendChild(inner);

        layer.appendChild(el);
        tokens[`${color}:${i}`] = el;
      }
    });

    return tokens;
  }

  function place(el, row, col) {
    el.style.left = `${(col / 15) * 100}%`;
    el.style.top = `${(row / 15) * 100}%`;
  }

  window.LudoBoard = {
    COLORS,
    COLOR_HEX,
    TRACK,
    TRACK_LENGTH,
    START_INDEX,
    SAFE_INDICES,
    HOME_PATH,
    FINISH,
    YARD_SLOTS,
    CENTRE_SPREAD,
    cellInfo,
    gridPos,
    spreadStack,
    buildBoard,
    createTokens,
    place,
  };
})();
