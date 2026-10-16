# 🎲 Ludo Royale — Real-time multiplayer Ludo

A real-time 4-player Ludo game built with **Node.js + Express + Socket.IO** and a
plain **HTML/CSS/JS** front-end in `public/`. Chat runs alongside the board and is
persisted to **MongoDB Atlas** for exactly as long as a match is running — the
moment the game ends, the room's chat history is deleted.

<div align="center">

`2 – 4 players` · `live emoji chat` · `3D board + dice animations` · `Atlas chat storage` · `Render-ready`

</div>

---

## Features

| Area | What you get |
| --- | --- |
| **Seating** | Up to 4 players per room (Red · Green · Yellow · Blue). A **2-player game starts fine** — 3 also works. Anyone joining a full or in-progress table becomes a spectator and can still chat. |
| **Gameplay** | Authoritative server-side engine: 52-square ring, safe squares, capturing, 5-square home stretch, exact roll needed to finish, extra turn on a 6 / capture / reaching home, three-sixes forfeit. |
| **Chat** | Room chat in lobby and game view, full emoji picker plus quick reactions, system messages for joins/leaves/captures. |
| **Chat lifetime** | While a match runs every message is written to MongoDB Atlas. When the game ends (win or abandoned) the room's documents are hard-deleted and every client is told to clear its view. |
| **Realtime** | Socket.IO state broadcasts, per-socket chat flood control, auto-skip for an offline player, automatic re-attach after a refresh, abandoned-match handling. |
| **UI** | Dark glassmorphism, animated gradient orbs, 3D tilted board (toggleable), 3D CSS dice cube that spins onto the rolled face, tokens that hop square-by-square, knockout spin on capture, confetti on a win. |
| **Hardened** | Strict CSP, security headers, per-IP rate limits, server-issued identities with secret tokens, input sanitising, payload caps, graceful shutdown. |

---

## Quick start

```bash
npm install
cp .env.example .env     # then paste your Atlas connection string
npm start                # http://localhost:3000
```

Open the URL in **two or more** browser tabs, enter a name, create a table in one
and join with the room code in the others.

> Without `MONGODB_URI` the game is fully playable in development — chat is kept
> in memory and the console says so. In **production** the server refuses to boot
> without a database unless you explicitly set `ALLOW_MEMORY_CHAT=true`.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables strict CSP, HSTS and config validation. |
| `MONGODB_URI` | — | Atlas connection string. Required in production. |
| `PORT` | `3000` | Render sets this automatically. |
| `TRUST_PROXY` | `true` in prod | Trust one `X-Forwarded-For` hop. |
| `ALLOWED_ORIGINS` | same-origin | Extra websocket origins, comma separated. Never `*`. |
| `ALLOW_MEMORY_CHAT` | `false` | Allow production to run without a database on purpose. |
| `MAX_ROOMS` | `500` | Hard ceiling on live rooms. |
| `MAX_ROOM_CONNECTIONS` | `12` | Sockets allowed in one room. |
| `MAX_IP_CONNECTIONS` | `20` | Concurrent sockets per address. |
| `SOCKET_MAX_BUFFER` | `65536` | Max websocket payload in bytes. |

---

## Deploying on Render

The repo ships a `render.yaml` blueprint.

1. Push this project to GitHub/GitLab.
2. Render dashboard → **New +** → **Blueprint** → pick the repo.
   (Or: **New + → Web Service** and set *Build* `npm ci --omit=dev`,
   *Start* `node server.js`, *Health check path* `/health`.)
3. When prompted, set the secret **`MONGODB_URI`** to your Atlas connection
   string. Everything else is already in `render.yaml`.
4. Deploy. The log should end with `Chat storage: MongoDB Atlas` and
   `https://<your-app>.onrender.com/health` should return `"database":"connected"`.

### ⚠️ Atlas must allow Render's IPs

Render's outbound IPs are **not fixed** on the free/standard plans, so a
whitelist entry for your laptop will not work — the deployed app will log the
same "IP isn't whitelisted" error. In practice you must:

**Atlas → Security → Network Access → Add IP Address → `0.0.0.0/0`**

Because that opens the cluster to the internet, do the following at minimum:

- Use a **strong, unique database password** (not something guessable).
- Create a **least-privilege user** scoped to just this database, with the
  `readWrite` role only.
- Never expose the connection string: it lives in Render's environment, not in
  the repo (`.env` is gitignored).

If you have a paid Render plan, use a **static outbound IP** and whitelist only
that single address instead of `0.0.0.0/0`.

### Other platform notes

- **WebSockets** work on Render out of the box; the client tries `websocket`
  first and falls back to `polling`.
- **Free instances sleep** after ~15 minutes of inactivity, so the first visit
  takes 30–60 seconds to wake.
- **Run a single instance.** Rooms live in process memory. To scale
  horizontally, add `@socket.io/redis-adapter` and a shared store for rooms; the
  rate limiters would need a shared backend too.

---

## Security

| Control | Implementation |
| --- | --- |
| **Identity** | The server issues the player id *and* a 256-bit secret token. Reclaiming an existing seat requires both (constant-time compared), so a guessed or leaked id cannot hijack a seat — the attacker just gets a new one. Tokens are never broadcast to the table. |
| **CSP** | `default-src 'self'`, `script-src 'self'` (no inline/eval), `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'`; only Google Fonts is allowed externally. Verified in a real browser in production mode. |
| **Headers** | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP, HSTS and `upgrade-insecure-requests` (both only once TLS is in play). `X-Powered-By` is removed. |
| **CORS** | Same-origin by default in production; the front-end is served by this same process, so no cross-origin browser request is legitimate. `*` is rejected by config validation. |
| **Rate limits** | Per-IP: 6 room creations/min, 30 joins/min, 300 HTTP req/min, 20 concurrent sockets. Per-socket: 8 chat messages/5s, 40 game actions/5s. |
| **Input** | Room codes validated against `^[A-Z0-9]{4,8}$`, names capped at 18 chars, chat at 300 chars with control characters and bidi overrides stripped, token indexes checked as integers, websocket payloads capped at 64 KB. |
| **Client** | All player-supplied text is inserted with `textContent`/escaped, so a hostile display name cannot inject markup. |
| **Ops** | Uncaught exceptions trigger a clean shutdown (the platform restarts a healthy process), SIGTERM drains connections with an 8 s cap, and production refuses to start with missing/invalid config. |

Rate limiting is per process. On multiple instances, back it with Redis.

---

## How the chat lifetime works

```
lobby        chat shown, kept only in memory
  │
  ├── host starts the match ──────────────► status = "playing"
  │                                            every message is INSERTED into Atlas
  │
  └── someone brings all 4 tokens home ───► status = "over"
                                              1. room chat cleared in memory and on every client
                                              2. ChatMessage.deleteMany({ room }) on Atlas
                                              3. clients are told how many documents were removed
                                              4. lobby reset after 15s, ready for a rematch
```

A match abandoned through disconnects is wiped the same way. `src/chatStore.js`
is the only module that touches the database, so the "save while playing /
delete when the game ends" rule lives in one small, readable file.

---

## Project layout

```
server.js                  Express + Socket.IO bootstrap, security, health, shutdown
render.yaml                Render blueprint
src/
  config.js                env parsing, validation, fail-fast
  security.js              CSP/security headers + rate limiter
  identity.js              server-issued ids, secret tokens, constant-time compare
  db.js                    Mongo connection (degrades to memory-only)
  chatStore.js             save / history / wipe - the only DB writer
  models/ChatMessage.js    Mongoose schema, indexed by room
  socketHandlers.js        every realtime event + validation + limits
  game/
    constants.js           15x15 board geometry, shared with the browser
    LudoGame.js            pure rules engine (roll, move, capture, win)
    Room.js                seating, lifecycle, timers, chat
    roomManager.js         room registry + join codes
public/
  index.html               home / lobby / game screens
  css/style.css            theme, 3D transforms, animations
  js/board.js              board geometry + DOM renderer
  js/app.js                socket wiring, animation, chat
scripts/
  flow-test.js             end-to-end realtime match over sockets
  security-check.js        headers, CORS, limits, identity, validation
  ui-check.js              headless-Chrome browser suite
  db-check.js              chat persistence + game-end wipe
```

---

## Game rules implemented

- A **6** releases a token from the yard onto its coloured start square.
- Landing on an opponent's token on the shared ring sends it back to the yard —
  unless the square is **safe** (the four start squares and the four star squares).
- Rolling a **6**, capturing, or bringing a token home all grant **another roll**.
- Three sixes in a row forfeits the turn.
- Tokens need the **exact** number to enter the centre; overshooting is not allowed.
- The first player with **all four tokens home** wins.

---

## Testing

```bash
npm run test:flow      # boots the server, drives real clients through a full match
npm run test:security  # headers, CSP, CORS, rate limits, identity, validation
npm run test:ui        # headless Chrome: real tabs play a match through the UI
UI_PROD=1 npm run test:ui   # same suite against a production-mode server (strict CSP)
npm run test:db        # chat persistence + game-end wipe (needs MONGODB_URI)
npm test               # flow + security + ui
```

- **`test:flow`** (46 checks) — HTTP layer, lobby rules, 2-player minimum, chat
  fan-out and sanitising, turn enforcement, a full bot-played match, the
  post-game chat wipe, spectator seating, and a **4-player** table where the
  turn must rotate through all four colours.
- **`test:security`** (49 checks) — security headers and CSP over plain HTTP and
  simulated HTTPS, cross-origin rejection, 404 behaviour, seat-hijack attempts,
  forged identities, input sanitising, and every rate limit.
- **`test:ui`** (35 checks) — create/join, lobby and in-game chat, emoji picker,
  the rendered board (216 cells + centre + 4 yards), token coordinates for all
  four colours, the 3D tilt, a real dice roll and token move, and the chat panel
  emptying itself when the match ends. It also asserts **zero console errors**,
  which is what proves the strict CSP works. Saves `screenshots/game-board.png`.
- **`test:db`** — writes messages, reads them back, wipes the room, confirms the
  documents are gone. Without `MONGODB_URI` it runs offline checks and reports
  the live checks as **not run** rather than passing them.

MIT licensed.
