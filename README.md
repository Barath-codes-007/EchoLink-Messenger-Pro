# EchoLink Messenger

Real-time messaging with temporary *and* permanent rooms, 1:1 WebRTC voice/video calls, rich media sharing, and full message persistence — built on Node.js, Express, Socket.IO, and SQLite.

> **Honest scope note:** This is a genuine, working v2 of EchoLink covering the core messaging + calling experience end-to-end (see [Features](#-features) below). It intentionally does **not** include group/multi-party calls, AI features, E2E encryption, or an admin analytics dashboard — those are real infrastructure projects in their own right and are listed under [Roadmap](#-roadmap) rather than faked with placeholder code.

## 📸 Screenshots

> _Add screenshots of the landing page, chat view, and an active call here — e.g. `screenshots/landing.png`, `screenshots/chat.png`, `screenshots/call.png` — and reference them below:_
>
> `![Landing page](screenshots/landing.png)`
> `![Chat view](screenshots/chat.png)`
> `![Voice/video call](screenshots/call.png)`

## ✨ Features

**Authentication & profiles**
- Sign up / log in / log out with hashed passwords (bcrypt) and JWT sessions in httpOnly cookies
- Editable profile: bio, avatar upload, theme preference
- Status: online / away / do-not-disturb / invisible, with live last-seen
- Change password, export account data as JSON, delete account

**Rooms**
- **Temporary rooms** — vanish automatically (room + messages) the moment the last member leaves
- **Permanent rooms** — get a short, unique, human-friendly join code; message history is kept forever until an owner deletes the room
- Join by room code or invite link, optional room password
- Roles: owner / admin / member, with kick, ban, mute, promote/demote, and ownership transfer
- Room settings: rename, description, password, auto-ownership handoff if the owner leaves

**Messaging**
- Real-time text messages over Socket.IO with typing indicators and **read receipts** (checkmarks show sent vs. seen)
- Images, videos, files (PDF/DOCX/ZIP/etc.), and voice notes — drag-and-drop, clipboard paste, or the composer's attach/camera/mic buttons
- **Attachment preview before sending** (image/video/file preview with Send/Cancel) for picked/dropped/pasted files
- In-app camera: photo capture (front/rear switch, mirror preview, retake) **and video recording**, plus a flash/torch toggle where the device supports it
- Tap-to-record voice notes with a **live waveform driven by the actual microphone input**, pause/resume mid-recording, and **playback speed control** (1x/1.5x/2x) on sent voice notes
- Reactions, replies, **flat thread view** ("N replies" opens a dedicated thread panel, Slack-style), edit, delete, pin, star/bookmark, forward to another room
- **@Mentions** with autocomplete while typing, highlighted in the rendered message, and bypass room mute for notifications
- **Emoji picker**, **GIF picker** (via Tenor — needs a free API key, degrades gracefully with a clear message if unconfigured), and a built-in **sticker picker** (lightweight: renders as large "jumbo" emoji rather than licensed sticker art)
- **Polls** (single or multi-select, live tally, close by creator/admin) and **announcements** (admin/owner-only, auto-pinned)
- **Scheduled messages** (send at a future date/time, cancel before it fires)
- **Live location sharing** (one-time or live-updating for 15/30/60 min, shown on an embedded OpenStreetMap/Leaflet map)
- Markdown (bold/italic/strikethrough/inline code/code blocks) with real **syntax highlighting** (highlight.js) in code blocks
- **In-room message search**
- Per-room **Media tab** with filter chips (Photos/Videos/Audio/Files/**Links**), search, and sort

**Safety & moderation**
- Block users (hides their messages from your view) and unblock from a dedicated Blocked Users list
- Report a message or user (stored for room admins to review)
- Mute a room's notifications without leaving it
- **Waiting room / approve-to-join**: rooms can require owner/admin approval before a join request becomes membership

**Calling**
- 1:1 voice and video calls over WebRTC, signaled through Socket.IO — mute/unmute, camera on/off, front/rear camera switch, screen sharing, call timer, **working Picture-in-Picture**, and a **live connection-quality indicator** (via `getStats()`)
- **Group voice/video calls** (mesh WebRTC). Start a call for the entire room or hand-pick specific members; host controls include mute-everyone, lock the call against new joins, and remove a participant; host role auto-transfers if the host leaves; **screen sharing works in group calls too** (replaces the outgoing video track across every peer connection at once); same connection-quality indicator as 1:1 calls.
  > **Mesh limitation, stated plainly:** this is not an SFU-based system like Zoom/Teams. Bandwidth and CPU cost grow with each additional participant since every peer streams to every other peer directly, so it's solid for small groups (roughly up to 4-6 people) but isn't built to scale to large calls. A proper large-scale group calling system needs a dedicated media server (e.g. mediasoup, LiveKit) — that's a separate, substantial infrastructure project and is not what's shipped here.
- **Call history** view (all past calls, duration, direction, status)
- Uses public STUN by default; add your own TURN server via `.env` for reliability behind strict NATs/firewalls (see below)

**Rooms**
- Join by room code, invite link, **or QR code**
- Optional room password, roles (owner/admin/member), kick/ban/mute, ownership transfer

**Notifications**
- Browser/desktop notifications for new messages when the tab isn't focused (skipped for muted rooms and your own messages)

**Design**
- Dark/light theme toggle, glassmorphism surfaces, gradient accents, the "echo ring" motif used throughout
- Responsive layout (mobile, tablet, desktop), skeleton loaders, toasts, modals, context menus, ripple effects
- Landing page with animated hero, feature grid, stats, testimonials, roadmap, and FAQ

**Security**
- **Short-lived access tokens (15 min) + rotating refresh tokens** (30-day, httpOnly, hashed at rest, single-use with automatic rotation and revocation) instead of one long-lived JWT
- bcrypt password hashing, secure cookies
- express-rate-limit on all API routes (tighter limits on auth endpoints)
- Server-side input sanitization (XSS-safe) and parameterized SQL (no injection surface)
- Multer file-type allowlist and size caps on uploads
- Helmet security headers, CORS locked to your configured origin

## 🗺 Roadmap

| Status | Feature |
|---|---|
| ✅ Shipped | Temporary & permanent rooms, 1:1 calls, media sharing, roles/moderation |
| ✅ Shipped | Refresh tokens, message search, star/forward, block/report, room mute, QR join, call history, browser notifications, Markdown + syntax highlighting |
| ✅ Shipped | Group voice/video calls incl. screen share (mesh WebRTC — see limitations above), custom room codes, temp room expiry, waiting rooms |
| ✅ Shipped | Mentions, polls, announcements, scheduled messages, live location, threads, read receipts, emoji/GIF/sticker pickers, attachment preview, camera video recording, voice note pause/resume + speed control, connection quality indicator, working Picture-in-Picture |
| 🚧 Building | SFU-based group calls for larger groups (needs mediasoup/LiveKit or similar) |
| 📋 Planned | End-to-end encryption |
| 📋 Planned | AI smart replies & instant translation |
| 📋 Planned | Installable PWA with an offline message queue |
| 📋 Planned | Admin analytics dashboard, shared whiteboard, watch-together |

> **Note on blocking:** blocking is currently a client-side view filter (blocked users' messages are hidden in your UI), not a server-side delivery restriction — a blocked user's messages are still stored and delivered to your client, just not rendered. This is fine for casual use but isn't a hard privacy/security boundary yet.

## 🛠 Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 18+ |
| Server | Express 4 |
| Real-time | Socket.IO 4 |
| Database | SQLite via `better-sqlite3` (file-based, zero external DB setup) |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` |
| Uploads | `multer` (disk storage, type/size limits) |
| Calls | WebRTC (browser-native), STUN/TURN via `RTCPeerConnection` |
| Frontend | Vanilla HTML/CSS/JS (no build step, no framework lock-in) |

## 📁 Folder structure

```
EchoLink-Messenger/
├── server/
│   ├── server.js                 # Entry point
│   ├── src/
│   │   ├── app.js                # Express + Socket.IO wiring
│   │   ├── config.js             # Env-driven config
│   │   ├── db/
│   │   │   ├── schema.sql        # Full normalized schema
│   │   │   └── index.js          # SQLite connection + migration runner
│   │   ├── controllers/          # auth, user, room business logic
│   │   ├── routes/               # Express routers
│   │   ├── middleware/           # auth, rate limiting, uploads, errors
│   │   ├── services/             # room codes, JWT signing
│   │   ├── sockets/              # presence, chat, WebRTC signaling
│   │   └── utils/                # sanitization, validators
│   └── uploads/                  # user-uploaded files (gitignored)
├── public/                       # Static frontend (no build step)
│   ├── index.html                # Landing page
│   ├── auth.html                 # Login / signup / forgot password
│   ├── app.html                  # Main chat application
│   ├── css/
│   └── js/
├── Dockerfile
├── docker-compose.yml
├── render.yaml
└── .env.example
```

## 🚀 Installation

**Requirements:** Node.js 18+ and npm.

```bash
git clone https://github.com/barath/echolink-messenger.git
cd echolink-messenger

# Configure environment
cp .env.example server/.env
# then edit server/.env — at minimum, set JWT_SECRET to a long random string:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Install & run
cd server
npm install
npm run dev      # nodemon, auto-restarts on changes
# or: npm start   # plain node
```

The app is served entirely from the Express server — open **http://localhost:3000** for both the landing page and the app; there's no separate frontend dev server to run.

On first run, `server/data/echolink.db` is created automatically and the schema is applied.

## ▶️ Running locally

```bash
cd server
npm run dev
```

Then visit `http://localhost:3000`, sign up two accounts (e.g. in a normal window and an incognito window), create a room in one, join it with the room code in the other, and try text messages, file/voice-note sharing, and a voice/video call between them.

## 🌐 Environment variables

See [`.env.example`](.env.example) for the full list with comments. Key ones:

| Variable | Purpose |
|---|---|
| `PORT` | Port the server listens on (default `3000`) |
| `CLIENT_ORIGIN` | Origin allowed by CORS/cookies — set to your deployed URL in production |
| `JWT_SECRET` | **Required.** Long random string signing session tokens |
| `DB_PATH` | Path to the SQLite database file |
| `UPLOAD_DIR` / `MAX_UPLOAD_MB` | Where uploads are stored and the per-file size cap |
| `STUN_SERVERS` | Comma-separated STUN URLs for WebRTC (public Google STUN by default) |
| `TURN_SERVER` / `TURN_USERNAME` / `TURN_CREDENTIAL` | Optional TURN relay — recommended for production so calls work behind strict NATs/corporate firewalls. Self-host [coturn](https://github.com/coturn/coturn) or use a provider like Twilio/Xirsys. |

## 📦 Deployment

### Docker Compose (recommended for self-hosting)

```bash
cp .env.example .env   # fill in JWT_SECRET at minimum
docker compose up -d --build
```

Data and uploads persist in named Docker volumes (`echolink_data`, `echolink_uploads`).

### Render

This repo includes a [`render.yaml`](render.yaml) blueprint — connect the repo in the Render dashboard and it will provision a web service from the included `Dockerfile`, with a persistent disk for the SQLite database. Set `CLIENT_ORIGIN` to your Render URL after the first deploy.

### Railway

Railway auto-detects the `Dockerfile`. Add a volume mounted at `/usr/src/app/server/data` for persistence, and set the same environment variables as in `.env.example`.

### Vercel / Netlify (frontend only)

The `public/` folder is static and *can* be deployed separately to Vercel/Netlify, but you'll need to point it at a separately-hosted backend (Render/Railway/Docker) and update `CLIENT_ORIGIN` + the API base URLs accordingly, since Vercel/Netlify don't run persistent Socket.IO/WebSocket servers. For most self-hosters, deploying the whole app as one Docker service (as above) is simpler.

## 🤝 Contributing

Issues and pull requests are welcome. Please:
1. Open an issue describing the change before large PRs
2. Keep the existing folder structure and naming conventions
3. Test your changes locally (`npm run dev`) before submitting

## 📄 License

MIT — see [LICENSE](LICENSE).

## 👤 Author

**Created and Developed by Barath**

---

Built with ❤️ by Barath
