# EchoLink Messenger — audit & fix pass

This documents a security/bug-fix pass over the existing codebase. **Scope
note up front:** this environment has no network access and no browser, so
nothing here was run against a live server or tested in an actual browser —
every fix below was verified by careful code reading and `node --check`
(syntax only) on every file touched. Before deploying, run the app for real
and exercise the flows listed at the bottom of this file.

No existing features were removed. No API endpoints were renamed except
where noted (file URLs — a deliberate, necessary breaking change, see #4).

## Fixed

1. **Call hijacking / signaling spoofing (critical).** None of the 1:1 call
   handlers (`call:respond`, `call:offer`, `call:answer`, `call:ice-candidate`,
   `call:state`, `call:end`) or group-call handlers (`group-call:offer`,
   `group-call:answer`, `group-call:ice-candidate`, `group-call:state`)
   verified the sender was actually a participant of the call/group call.
   Any authenticated user who learned or guessed a `callId`/`groupCallId`
   could accept, end, or inject fake state/ICE candidates into someone
   else's call. Fixed in `server/src/sockets/calls.js` and
   `server/src/sockets/group-calls.js`: every handler now checks the sender
   (and, where the client supplies a target, the target too) is a real
   participant before doing anything.

2. **Call history status accuracy.** A socket disconnect was always logged
   as `missed`, even if the call had already connected and was mid-conversation.
   `call_logs.status` now distinguishes `missed` / `disconnected` / `cancelled`
   / `timeout` / `declined` / `completed` based on whether the call had
   actually connected. This required widening the `status` CHECK constraint
   on `call_logs`; since SQLite can't alter a CHECK constraint in place,
   `server/src/db/index.js` now runs a one-time migration (rebuild + copy)
   for existing databases — existing rows are preserved, not dropped.

3. **No call timeout.** An unanswered 1:1 call sat in memory forever if the
   callee never responded. Added a 45s ring timeout in `calls.js` that ends
   the call and logs it as `timeout`.

4. **Private files served publicly (critical).** `/uploads` was mounted as
   an unrestricted `express.static` directory — anyone with a file's URL
   (leaked in logs, a screenshot, a forwarded link) could download it, no
   authentication or room-membership check at all. Fixed by:
   - Removing the static mount (`server/src/app.js`).
   - Adding `GET /api/files/:filename` (`server/src/routes/files.routes.js`),
     which requires auth and checks the requester is either the uploader or
     a member of the room the file is attached to.
   - Adding an `uploads` table (`schema.sql`) that ties each file to its
     uploader, and — once a message referencing it is sent — to that room
     and message (`server/src/sockets/chat.js`, `message:send`).
   - **Breaking change, deliberate:** upload URLs are now
     `/api/files/<name>` instead of `/uploads/<name>`. The client
     (`public/js/app.js` upload flow, `chat-ui.js` rendering) needed no
     changes beyond this since the URL is just used as-is in `<img>`/
     `<video>`/`<audio>` `src` and the browser sends cookies automatically
     for same-origin requests. Any external code/bookmarks pointing at old
     `/uploads/...` URLs will need updating — there was no way to keep
     files private and preserve that exact URL shape.

5. **Upload content validation.** Extension was the only check — a
   client claiming `.png` for an uploaded script could have any real
   content. Added magic-byte signature verification
   (`server/src/middleware/upload.js`) for every accepted type before the
   file is written to disk (switched multer to memory storage so bytes can
   be inspected first). SVG uploads are now disabled by default (an SVG can
   carry `<script>`/event handlers and isn't safe to serve inline without a
   real sanitizer) — opt back in via `ALLOW_SVG_UPLOADS=1` only if a
   sanitizer is added downstream.

6. **Insecure JWT default.** `JWT_SECRET` silently fell back to a hardcoded
   dev string in *any* environment, including production. `config.js` now
   throws on startup if `NODE_ENV=production` and the secret is missing,
   equal to the dev fallback, or shorter than 32 characters.

7. **Cross-room exploits in chat (`server/src/sockets/chat.js`):**
   - `message:react` never checked the target message actually belonged to
     the room being reacted from — a message ID from Room A could be
     reacted to via Room B. Now verified.
   - `message:send` accepted any `replyToId` with no check it belonged to
     the same room. Now verified.
   - `poll:vote`'s `optionIndex` wasn't checked for being an actual integer
     — a non-numeric value slipped past the `< 0` / `>= length` bounds
     checks. Now uses `Number.isInteger`.
   - `location:share` and `location:update` only checked `typeof === "number"`,
     so `NaN`/`Infinity` and out-of-range lat/lng passed straight through.
     Both now validate finiteness and the real -90..90 / -180..180 ranges.

8. **Room capacity race on join approval.** Capacity was checked once when
   a join request was first queued, but not re-checked when an admin later
   approved it — other members could join in the meantime and push the
   room over its cap. `approvePendingRequest` (`room.controller.js`) now
   re-checks capacity immediately before inserting the member.

9. **Stale `rooms.owner_id` after ownership transfer.** Both the
   auto-transfer-on-leave path and the explicit `transferOwnership`
   endpoint updated `room_members.role` but never `rooms.owner_id`, leaving
   two conflicting sources of truth for "who owns this room." Both paths
   now update both columns together in a transaction.

10. **Unvalidated report targets.** `createReport` inserted whatever
    `targetUserId`/`messageId` was sent without checking either existed, or
    that the reporter could actually see the referenced message. Now
    verifies the user exists and, for a message report, that the reporter
    is a member of the room that message belongs to.

11. **Group-call ICE candidates silently dropped (critical, item flagged in
    the original request).** `public/js/group-call.js` called
    `addIceCandidate` and swallowed any failure with a comment claiming
    "browsers queue internally in most cases" — that assumption isn't
    reliable, and a candidate arriving before `setRemoteDescription()` was
    just lost rather than queued. Added a real per-peer
    `pendingCandidates` queue + `remoteDescriptionSet` flag; candidates
    arriving early are queued and replayed once the remote description is
    set (the 1:1 call code in `call.js` already did this correctly — group
    calls didn't).

12. **Group-call placeholder metadata.** When a peer's offer arrived before
    we'd created a peer entry for them, the code hard-coded the username as
    `"…"` even though `group-call:participant-joined` had already told us
    their real username/avatar. Now tracked in `state.knownParticipants`
    and used instead of the placeholder.

13. **Room-switching socket leak (critical, item flagged in the original
    request).** `openRoom()` in `public/js/app.js` joined the new room's
    Socket.IO room but never left the previous one — switching Room A ->
    B -> C left the socket still joined to A and B indefinitely, so their
    events kept arriving and accumulating. Fixed: `openRoom` now emits
    `room:leave` for the previously active room before joining the new
    one, and `closeRoom()` (leaving the room view entirely) also now emits
    `room:leave` instead of just clearing local UI state.

14. **Socket.IO reconnection recovery (item #3).** Socket.IO auto-reconnects
    the transport on its own, but that gets the server a brand-new
    `socket.id` — none of the old room membership (`socket.join`), presence,
    or "who's in this call" state carried over. There was no handling of
    this at all. Added (`public/js/socket-client.js`): an `onReconnect`
    hook that fires on every reconnect (not the first connect), plus
    reconnect-attempt/failure toasts. Wired up in `public/js/app.js` to
    re-emit `room:join` for the active room, refresh its member list, and
    restore the user's presence status (the server marks a disconnected
    user offline, so this undoes that once they're back).
    **Not attempted:** restoring in-progress call/WebRTC state after a
    reconnect — that's materially harder (the RTCPeerConnection itself may
    have already failed) and needs real testing, not a blind fix.

15. **Blocking not enforced on calls (item #39).** Blocking only affected
    the block-list endpoints themselves — nothing checked it anywhere else.
    Added `server/src/utils/blocking.js` (`isBlocked`, checked
    bidirectionally) and wired it into `call:invite` (1:1 calls) and
    `group-call:start`/`group-call:join` (skips inviting/rejects joining
    when either side has blocked the other). Message-level blocking wasn't
    addressed — this app's messages broadcast to an entire room rather
    than being 1:1, so "B can't message A" doesn't map onto the data model
    the way "B can't call A" does without a larger redesign.

16. **No refresh-token cleanup (item #41).** `refresh_tokens` grew forever —
    every login/refresh/logout inserts or revokes a row and nothing ever
    deleted them. Added `server/src/services/tokenCleanup.js`, a periodic
    sweep (every 6h, plus once at startup) that deletes expired tokens and
    revoked tokens older than a 7-day grace window, following the same
    `setInterval` + `.unref()` pattern the existing room-expiry sweep uses.

17. **No rate limiting on Socket.IO events (item #49).** `express-rate-limit`
    only covers HTTP routes — it does nothing for Socket.IO events, so
    message sending, reactions, and call signaling had zero rate limiting
    despite being named explicitly in the request. Added
    `server/src/utils/socketRateLimit.js` (a minimal per-user fixed-window
    limiter, keyed by user ID so a reconnect can't reset someone's
    allowance) and applied it to `message:send` (30/10s), `message:react`
    (60/10s), `call:invite` (10/min), and `group-call:start` (6/min).
    Other socket events (typing, presence, ICE relay) weren't limited —
    they're either inherently bounded by the UI or low-risk to spam.

18. **Room deletion left calls orphaned (extension of item #37).** Item
    #37 (temporary room expiration) was already handled correctly for
    rooms themselves, but neither that sweep nor explicit room deletion
    (`DELETE /api/rooms/:roomId`) terminated any active call happening in
    that room, or told connected clients the room was gone in the
    explicit-delete case at all (no `room:deleted` event was even emitted).
    Added `endCallsForRoom`/`endGroupCallsForRoom` (exported from
    `calls.js`/`group-calls.js`) and wired them into the expiry sweep, the
    owner-logout sweep, and explicit deletion. Explicit deletion needed a
    small decoupling module (`server/src/services/roomEvents.js`, a plain
    `EventEmitter`) rather than requiring the call modules directly from
    `room.controller.js`, which would have created a require cycle
    (`room.controller.js` -> `calls.js` -> `room.controller.js`) since the
    call modules already need `getMembership` from it.
    Added a matching client handler for the resulting `group-call:ended`
    event (`public/js/group-call.js`) — 1:1 calls already had a generic
    `call:ended` handler that this reuses as-is.

19. **Voice send button blocked while paused (item #23).** The Send button
    on a recorded voice note checked `EchoRecorder.isRecording()` only — a
    *paused* recording (a perfectly valid, stoppable state) made Send do
    nothing at all when clicked. Fixed in `public/js/chat-ui.js`: Send now
    works from either the recording or paused state.

20. **Mic stream leak on rapid re-record (item #24).** Tapping the record
    button again while a recording was paused bypassed the double-tap
    guard (which only checked `isRecording()`, not `isPaused()`), created a
    *second* `MediaRecorder`/mic stream, and overwrote the module-level
    references to the first one — leaking that mic stream and its
    `AudioContext` indefinitely (mic stayed "on" from the OS's perspective
    with no way to stop it short of reloading the page). Fixed at both
    layers: the UI guard (`chat-ui.js`) now excludes the paused state too,
    and `recorder.js`'s `start()` itself now force-closes any still-active
    previous session before starting a new one, so this can't regress even
    if a future UI change reintroduces a gap in the click guard.
    (Item #25, MIME-type compatibility, was already implemented correctly
    — `isTypeSupported` detection and using the recorder's actual
    negotiated MIME type end-to-end — no bug found there.)

21. **No real ringtone (item #12).** `showIncomingCall` created an
    `AudioContext` named `ringtone` and then never used it for anything —
    dead code, and it leaked one unused AudioContext per incoming call
    besides. No audio asset ships with the project, so implemented a real
    ringtone synthesized with Web Audio (a two-tone loop) rather than
    adding a binary asset I can't verify plays correctly without a
    browser. Handles autoplay restrictions gracefully (calls `.resume()`
    and fails silently rather than throwing if the browser keeps the
    context suspended — the visual "Incoming call" modal remains the
    primary cue either way). Stops on accept, decline, and — a related bug
    this surfaced — on the call ending out from under the still-open
    incoming-call modal (timeout, or the caller cancelling before
    answering): `onEnded()` previously only tore down the *in-call*
    overlay, never the separate incoming-call modal, so a
    caller-cancels-before-answer or a ring-timeout left the callee staring
    at a "Incoming call…" modal that could never be dismissed except by
    reloading. Now `onEnded()` explicitly closes it and stops the ringtone
    if it's still open.

22. **Screen-share button shown in voice calls (item #20).** In both 1:1
    (`call.js`) and group (`group-call.js`) calls, the screen-share control
    was rendered unconditionally, including in voice-only calls — where no
    video sender/transceiver exists at all. Clicking it would open the OS
    screen-picker, then silently do nothing (`getSenders().find(...
    kind === "video")` finds nothing to replace), while the UI still
    marked screen-sharing as "active." Now hidden for voice calls in both
    files, matching the spec's own suggested fix.

23. **Group screen share broken for anyone joining mid-share (item #20,
    group-call specific).** In the mesh architecture, starting a screen
    share correctly replaced the video track on every *existing* peer
    connection — but `createPeer()` (called when a new participant's offer
    arrives, or when joining an already-in-progress call) always added
    tracks from `state.localStream` (the camera), with no check for
    whether a screen share was already active. A participant who joined
    partway through someone's screen share would see that person's camera
    instead of their screen, while everyone else correctly saw the screen.
    Fixed: `createPeer` now checks `state.screenSharing` and swaps in the
    current screen track for any newly created peer connection.

24. **Voice-note duration never showing (user-reported).** `audio.duration`
    reports `Infinity`/`NaN` for MediaRecorder-produced webm/ogg files right
    after `loadedmetadata` in Chrome and Firefox — a live-recorded
    container has no total duration written into its header, only its
    actual end does, and the duration formatter (correctly) rendered any
    non-finite value as `0:00` forever. Fixed in `public/js/chat-ui.js`
    with the standard workaround: seek to a huge `currentTime` once, read
    the real duration off the `timeupdate` that results, then seek back to
    0, before syncing the play/duration/waveform UI.

25. **No retry when a voice-note/file upload fails (user-reported).** On
    any upload failure (dropped connection mid-upload, server error), the
    code showed a toast and discarded the file reference in the same
    `finally` block — for a recorded voice note specifically, that
    recording is gone for good; the only recovery was re-recording from
    scratch. Fixed: `uploadAndSend` now keeps the file/blob and renders a
    "⚠️ &lt;error&gt; [Retry] [Dismiss]" state in place of the progress bar
    on failure; Retry re-attempts the exact same upload without re-opening
    the mic.

26. **No live "recording…"/"uploading…" status to other room members
    (user-reported).** The item #12 concern was about the *callee's*
    ringtone; this is the analogous gap for text-chat voice notes — other
    users only found out a voice message existed once it fully finished
    uploading and appeared, unlike WhatsApp/Telegram's live status. Added
    a `voice:recording` socket event (`server/src/sockets/chat.js`,
    modeled directly on the existing `typing` event) broadcasting
    recording-started/stopped plus a `status` of `"recording"` or
    `"uploading"` to the room. The existing typing-indicator UI
    (`public/js/chat-ui.js`) now shows "X is recording a voice message" or
    "X is sending a voice message" in the same spot, taking priority over
    a plain typing indicator when both are somehow active. Also tracks
    per-user recording state server-side so a dropped connection
    mid-recording (crash, tab close) can't leave the indicator stuck on
    for everyone else forever — cleared on `disconnect` the same way.

27. **Malformed Leaflet CDN URL — Leaflet never loaded at all (critical,
    user-reported).** `app.html` literally contained
    `https://unpkg.com/[email protected]/dist/leaflet.css` — the brackets
    were real bytes in the file, not a display artifact (confirmed via
    `cat -A`). Every browser request for this URL would 404, meaning the
    map/location feature had zero chance of working in the shipped code.
    Fixed to `leaflet@1.9.4`. Swept the rest of the project for the same
    pattern — no other instances found.

28. **Render env var mismatch: `JWT_EXPIRES_IN` vs `ACCESS_TOKEN_EXPIRES_IN`
    (user-reported).** `config.js` only ever reads
    `process.env.ACCESS_TOKEN_EXPIRES_IN`; `render.yaml` declared
    `JWT_EXPIRES_IN`. Whatever value was set in the Render dashboard was
    silently ignored and the app always fell back to config.js's hardcoded
    `"15m"` default. Fixed the variable name in `render.yaml`, and while
    there, added the `TURN_SERVER`/`TURN_USERNAME`/`TURN_CREDENTIAL`,
    `REFRESH_TOKEN_EXPIRES_DAYS`, and `REFRESH_COOKIE_NAME` vars that
    `config.js` already supports but `render.yaml` never declared at all.

29. **`rememberMe: false` silently became persistent on token refresh
    (user-reported).** `refresh()` called `issueSession(res, user, true)`
    — hardcoded `true` regardless of how the user actually logged in. A
    session-only login (cookie cleared on browser close) would silently
    become a 30-day persistent login the moment the 15-minute access token
    expired and the client auto-refreshed, which happens routinely during
    normal use. Fixed by persisting the original choice on the refresh
    token record itself (`refresh_tokens.remember_me`, added via a safe
    `ALTER TABLE` migration for existing databases) and reading it back on
    every refresh instead of assuming.

30. **Presence: closing one tab marked the user offline everywhere (user-
    reported, "multi-tab handling").** `presence.js`'s disconnect handler
    unconditionally set `status = 'offline'` and broadcast
    `presence:user-left` for *any* socket disconnecting — with two tabs or
    a phone + laptop both open, closing either one incorrectly told every
    room the user had left, even though their other session was still
    fully connected. Also, room online-counts and the online-users list
    were built from raw socket IDs, so the same user with two tabs in a
    room counted (and appeared) twice. Fixed: added
    `server/src/utils/multiSocket.js` (checks Socket.IO's own
    `io.sockets.sockets` registry — no separate, easy-to-desync tracking
    structure needed) so a user only goes offline when their *last* socket
    disconnects, and presence counts/lists now dedupe by user id.

31. **1:1 calls could get stuck signaling to the wrong tab (user-reported,
    "multi-tab handling" + "WebRTC reliability").** Every call signaling
    relay (`call:offer/answer/ice-candidate/state`) resolved its target by
    "find *a* socket belonging to this userId that's in this room" — with
    two tabs/devices open, an SDP offer or ICE candidate could be
    delivered to a tab that never ran `setupPeerConnection()` for that
    call at all, which just silently drops it, leaving the call stuck in
    "Connecting…" forever with no error. Fixed by binding each call to the
    *exact* socket that accepted it (`call.callerSocketId` /
    `call.calleeSocketId`, set once and never re-resolved), and every
    relay now targets that exact socket. Incoming-call ringing now also
    reaches *every* tab/device the callee has open (via the per-user
    Socket.IO room every socket already joins on connect), with the
    non-answering tabs correctly dismissed the moment one tab
    accepts/declines — without killing the call the accepting tab just
    started (`socket.to()` excludes the sender for exactly this reason).
    Client-side (`call.js`), every signaling handler (`onAccepted`,
    `onDeclined`, `onEnded`, `onIceCandidate`, `onCallState`) now verifies
    the incoming event's `callId` actually matches this tab's own active
    call before acting on it, since events can legitimately reach other,
    unrelated tabs of the same user now.

32. **Group calls had the same class of multi-tab ambiguity.** Mesh
    signaling (`group-call:offer/answer/ice-candidate/state`) resolved
    targets by "any socket of this user currently in the room" — same
    stuck-signaling risk as #31. Rather than building full arbitrary
    multi-tab mesh routing (a much larger change), a participant is now
    bound to the exact socket that joined
    (`call.participants.get(userId).socketId`), and joining the same
    group call twice from a different tab/device is rejected with a clear
    error instead of silently creating an ambiguous second binding.
    Disconnect/leave logic was updated to match — an unrelated tab of the
    same user disconnecting no longer removes them from a group call
    they're still actively in via another tab. Incidentally fixed a small
    info leak: the participant list sent to joining clients was spreading
    the internal `socketId` field into the response; now explicitly
    whitelisted to `id`/`username`/`avatarUrl`.

33. **Abandoned call-state cleanup (item #7, defense in depth).** Every
    normal exit path already cleaned up `activeCalls`/`activeGroupCalls`
    correctly, but nothing caught the rare case of a cleanup event being
    missed entirely (process-level crash mid-handler, etc.), which would
    leak a call entry forever. Added a periodic sweep (every 2 minutes,
    alongside the existing room-expiry/token-cleanup jobs) that removes
    any call whose bound socket(s) are no longer actually connected.

34. **Explicit bind address and graceful DB shutdown for deployment
    robustness.** `server.listen(port, callback)` (no host argument) works
    but relies on Node's platform-dependent default host resolution;
    explicitly binding `"0.0.0.0"` avoids any ambiguity in a containerized
    deployment (Render's Docker runtime). Also added a `db.close()` call
    on `SIGTERM`/`SIGINT` (Render sends `SIGTERM` on every restart/
    redeploy) — WAL mode already makes SQLite crash-safe, but a clean
    close is still better practice than relying on that every time. Also
    fixed the startup log line claiming `http://localhost:PORT` even in
    production.

## Verified already correct (no change needed)

A number of items in this round's request turned out to already be
implemented correctly — listed here so they aren't re-investigated later:

- TURN support with graceful STUN-only fallback (`/api/config/rtc`).
- CORS restricted to `config.clientOrigin` (never `"*"`) for both Express
  and Socket.IO.
- Socket.IO/API client connections use `window.location.origin` and
  relative `/api/...` paths — no hardcoded localhost/LAN addresses
  anywhere outside the one intentional dev-only fallback in `config.js`.
- `PORT` read from `process.env.PORT`; `.env.example` already complete and
  aligned with `config.js`.
- SQLite: WAL mode, foreign keys on, parameterized queries throughout,
  `CREATE TABLE IF NOT EXISTS` (no accidental recreation on restart).
- `/health` endpoint exists.
- Error responses never leak stack traces/internals outside development.
- No sensitive data (passwords, secrets, tokens) found in any log call —
  there's exactly one `console.error` in the whole server, and it only
  logs caught error objects server-side.
- Rate limiting already covers auth endpoints tightly and general API
  traffic broadly (from earlier rounds).

35. **Critical: accepting/declining a call did nothing on the callee's own
    screen (user-reported).** `server/src/sockets/calls.js`'s
    `call:respond` handler never accepted or called an `ack` callback, but
    the client calls it via `emitAck` (`await EchoSocket.emitAck("call:respond",
    ...)`), which returns a Promise that only resolves once the server
    calls that callback. With no callback ever coming, the Promise hung
    forever:
    - **Accept**: `renderCallOverlay()` sits *after* the hung `await`, so
      it never ran — the callee's incoming-call modal closed (that part
      happens first) but no call screen ever appeared, even though the
      *caller's* side worked fine (it reacts to a separate broadcast
      event, not this hung Promise) and the call was actually connecting
      in the background with no UI to show for it.
    - **Decline**: the opposite ordering — `closeIncomingModal()` sits
      *after* the hung `await`, so the decliner's own modal and ringtone
      never stopped, even though the server had already processed the
      decline correctly and the caller correctly saw "declined."
    Fixed by adding the missing `ack` parameter and calling it on every
    path. Also hardened `emitAck` itself (`socket-client.js`) with a
    10-second timeout, so a future handler that similarly forgets to ack
    fails fast with a toast instead of hanging the UI indefinitely again —
    and gave `accept()`/`decline()` real error handling instead of
    silently swallowing failures.

36. **Avatar "box shape" instead of circular (user-reported).**
    `.avatar-fallback` (the initials-based avatar shown when someone has
    no profile photo) had **no base styling at all** in any stylesheet
    `app.html` actually loads. The correctly-styled circular version only
    existed in `landing.css` — used solely by the marketing landing page,
    never included in the actual chat app. Every fallback avatar
    throughout the whole app (not just calls — chat messages, room member
    lists, group-call tiles, the incoming-call screen) was rendering as a
    bare, unstyled square div. Fixed at the root: added the real base rule
    to `app.css` next to the existing (correctly circular) `.avatar` class,
    so every more specific call-screen override (size, border, shadow)
    now correctly inherits a circular shape instead of each needing its
    own fix.

37. **Sidebar collapse to free up chat space (user-requested).** Clicking
    the EchoLink logo in the sidebar header now collapses the sidebar
    (animates `width`, not just `transform`, so `chat-main` genuinely
    reclaims the freed space rather than leaving a blank gap) with a small
    floating button appearing in the chat area to bring it back. Preference
    persists across sessions via `localStorage`, same pattern as the
    existing theme toggle.

38. **Incoming-call screen polish (user-reported: "not professional").**
    Much of this was likely the hung-Promise bug above making the whole
    flow *look* broken regardless of styling. Beyond that bug fix, also:
    replaced the quick-action emoji (💬⏰🚫 — inconsistent rendering across
    platforms, reads as a placeholder) with clean stroke SVG icons matching
    the rest of the call UI's visual language; grounded the accept/decline
    buttons in a frosted-glass tray at the bottom instead of floating loose
    on the gradient background; added a subtle vignette for depth; added a
    small bouncing chevron above the accept button as a swipe-up gesture
    hint (the button remains a plain tap target regardless — the hint is
    purely additive, not a new requirement to swipe).

## Confirmed real issues, still not fixed

- **1:1 WebRTC reconnection / `restartIce()`** (item #5) — not audited.
- **TURN server wiring end-to-end** (item #6) — `config.js` and
  `/api/config/rtc` already support it via env vars; didn't verify the
  client actually applies TURN credentials correctly in all call paths.
- **Group call mesh cleanup on reconnect, duplicate peer connections**
  (item #21) — not audited in depth beyond the ICE queue and mid-share-join
  fixes above.
- **Per-endpoint HTTP rate limits** beyond the global `apiLimiter` and
  `authLimiter` — e.g. uploads and room creation share the general 120/min
  limit rather than having their own tighter ones.
- Client-side call/WebRTC state isn't restored after a Socket.IO
  reconnect (see item #14 above) — only room membership and presence are.
- `modal.js`'s `closeModal()` never removes the `keydown` (Escape) listener
  `openModal()` adds — found incidentally while fixing the ringtone/modal
  interaction above, unrelated to it, and left as-is since it's outside
  this round's scope: every modal open leaks one document-level keydown
  listener that's never cleaned up.

## Requires real browser/device testing (can't be done in this environment)

Per the original request's own instruction not to fake WebRTC testing: all
of the following need actual manual verification, which nothing here has
done:

- 1:1 and group audio/video calls across real devices/networks.
- Screen sharing start/stop/replace-track behavior.
- Ringtone playback and autoplay-restriction handling.
- MediaRecorder voice-note lifecycle across browsers.
- Reconnection behavior on real network drops.
- Everything in the original request's "Real-world WebRTC test matrix"
  section.

## Suggested smoke test before deploying

1. `npm install` in `/server` (no `node_modules` were shipped with this
   fix pass — nothing was installed or run here).
2. Set a real `JWT_SECRET` in `.env`; confirm the server refuses to start
   in `NODE_ENV=production` without one.
3. Upload an image, a voice note, and a PDF; confirm each renders/plays
   and that fetching its URL while logged out (or as a non-member of the
   room) returns 403/404 instead of the file.
4. Open Room A, switch to Room B, send a message in Room A from a second
   session — confirm it does *not* appear while B is open.
5. Start a 1:1 call, let it connect, then kill the network on one side —
   confirm call history logs `disconnected`, not `missed`.
6. Start a group call with 3+ participants and confirm everyone connects
   to everyone (mesh) reliably on a few repeated attempts.
