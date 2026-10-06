# EchoLink Messenger — Call UI redesign

Full visual/UX redesign of the voice call, video call, incoming call, and
group call screens. Per the brief: **no backend or WebRTC negotiation logic
was touched** — every `RTCPeerConnection`, offer/answer/ICE-candidate flow,
and server-side socket handler is byte-for-byte the same as before. What
changed is markup, CSS, and purely-additive client-side features (local
media analysis, browser capability APIs, and reuse of the *existing*
generic `call:state`/`group-call:state` relay channels, which already
forwarded arbitrary state blindly before this — no new server code needed
for those).

New files: `public/css/calls.css`, `public/js/call-fx.js` (shared
ripple/haptic/tooltip/drag/pinch/waveform/reaction helpers). Modified:
`call.js`, `group-call.js`, `modal.js` (one small leak fix), `app.html`
(new incoming-call templates, script/style tags).

## What's real vs. what's honestly simplified

Everything below either uses a real browser API against real call state,
or is explicitly labeled as a simplification rather than dressed up as
something it isn't:

- **Waveform, mic-level meter, speaking-ring, speaker-view "main" tile** —
  all driven by live Web Audio `AnalyserNode` readings on the actual local
  and remote audio tracks. Not decorative/random.
- **Network quality, HD badge, bitrate/FPS stats** — from
  `RTCPeerConnection.getStats()`, read-only introspection of the real
  connection. Group-call quality now aggregates the *worst* of every peer
  in the mesh instead of sampling one arbitrary connection (this was a
  real, still-open bug from the previous audit round — fixed here as part
  of the same work).
- **Reactions, Hold** — sent over the existing `call:state` /
  `group-call:state` socket events. These already existed purely as a
  generic relay (the server forwards whatever `state` object it's given
  without inspecting it), so adding `{ reaction: '❤️' }` or `{ hold: true }`
  needed zero server changes. Fixing a bug found along the way: **group
  calls never had a receiving handler for `group-call:state` at all** —
  `toggleMic` was broadcasting mute state into the void. Added the missing
  listener, which also makes other participants' muted badges update
  correctly for the first time.
- **Picture-in-picture** — real `requestPictureInPicture()` (was already
  present for 1:1 calls; unchanged, just restyled).
- **Audio output picker ("Speaker"/"Bluetooth")** — real device
  enumeration + `setSinkId()`. Browsers expose one unified output-device
  list; a paired Bluetooth headset just appears in it like any other
  device — there's no separate Bluetooth API to call, so these two asks
  are implemented as one control. `setSinkId` is Chrome/Edge-only; the
  button explains this and points to system audio settings elsewhere
  rather than pretending to work.
- **Torch** — real `track.applyConstraints({ advanced: [{ torch }] })`;
  the button only appears when `track.getCapabilities().torch` is actually
  present (in practice, a narrow slice of Android Chrome).
- **Filters** — real canvas-based color grading. Each frame is drawn
  through a `canvas.filter` and re-captured as the outgoing track via
  `replaceTrack`, so the peer genuinely receives the filtered video, not
  just a local preview effect.
- **"Soft focus"** — a plain blur+brightness filter, explicitly *not*
  labeled as background blur. True background blur needs person
  segmentation (an ML model), which is out of scope — see below.
- **Add participant** — ends the 1:1 call and opens the existing group-call
  member picker (`EchoGroupCall.openMemberPicker`), which starts a real
  group call. There's no "upgrade a live 1:1 call in place" server
  capability, and building one would mean touching backend call-session
  logic, which the brief ruled out — this reuses what already exists
  instead.
- **Quick reply / Block caller** on the incoming-call screen — real
  `message:send` and the existing block endpoint, not new UI-only stubs.
- **Haptics** — real Vibration API. iOS Safari doesn't implement that API
  at all (a platform gap, not a bug here) — it's a silent no-op there.
- **Swipe-to-answer/decline** — real pointer-drag gesture with a distance
  threshold, plus a plain click/tap always works too (dragging is not the
  only way to answer, for accessibility).

## Explicitly out of scope (not faked)

- **Keypad/DTMF** — this app has no PSTN/phone-tree target to dial into;
  a numeric keypad wouldn't do anything real, so it isn't in the redesign.
- **True virtual backgrounds / ML background segmentation** — would need a
  bundled segmentation model and meaningfully more engineering. "Filters"
  above covers real, deliverable video effects instead of an overclaimed
  fake version of this.
- **Server-side call recording** — needs backend media-pipeline
  infrastructure that doesn't exist and wasn't in scope to build.
- **Foldable-device posture handling** — one best-effort CSS rule using the
  proposed `viewport-segments` media feature is included, but this
  couldn't be verified on real foldable hardware and may not do anything
  on most devices/browsers today.
- **Restoring in-call/WebRTC state after a Socket.IO reconnect** — still
  an open item from the previous audit round; unrelated to this visual
  redesign and not addressed here either.

## Also fixed along the way

- `modal.js`'s `closeModal()` never removed the `keydown` listener
  `openModal()` adds, leaking one per modal open — this mattered here
  because the incoming-call screen needs Escape to actually *decline* the
  call (not just visually dismiss it while it keeps ringing server-side),
  so getting Escape handling right was in-scope. Fixed for all modals, not
  just this one.
- Removed a stray duplicate `tpl-group-call-incoming` template that would
  have existed twice in `app.html` (a mistake made mid-edit, caught before
  shipping — the browser would have silently used the first one and the
  second would've been dead markup).

## Accessibility

- Every icon-only button has `aria-label`; toggles carry `aria-pressed`.
- Incoming-call screen is `role="dialog" aria-modal="true"`.
- Swipe-to-answer/decline buttons are fully operable by plain click/tap —
  not gesture-only.
- Touch targets are 48px+ (see the floor rule at the bottom of
  `calls.css`).
- `prefers-reduced-motion` was already handled globally in `tokens.css`
  (zeroes out all animation/transition durations app-wide), so it applies
  automatically to every new animation added here without extra rules.
- Added a `prefers-contrast: more` block strengthening borders and muted
  text on the new call surfaces.

## Not tested in a real browser

Same caveat as every round of work on this project: this environment has
no browser and no device, so nothing here was clicked through, and the
canvas-filter/getStats/setSinkId/torch/PiP code paths in particular should
get a real run-through — they're the parts most likely to have a rough
edge that only shows up on an actual screen.
