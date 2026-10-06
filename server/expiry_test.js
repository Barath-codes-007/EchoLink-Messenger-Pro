"use strict";
const http = require("http");
const { io } = require("socket.io-client");
const BASE = "http://localhost:4080";

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + path, { method, headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let c = "";
      res.on("data", (d) => (c += d));
      res.on("end", () => {
        const sc = res.headers["set-cookie"];
        resolve({ status: res.statusCode, body: JSON.parse(c || "{}"), cookie: sc ? sc.map((s) => s.split(";")[0]).join("; ") : cookie });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
function assert(cond, msg) { if (!cond) throw new Error("FAIL: " + msg); console.log("  ok " + msg); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const a = await request("POST", "/api/auth/signup", { username: "codeuser", email: "codeuser@test.com", password: "password123" });
  const cookieA = a.cookie;

  console.log("-- Custom room codes --");
  const custom = await request("POST", "/api/rooms", { name: "Custom Code Room", type: "permanent", code: "myCode1" }, cookieA);
  assert(custom.status === 201, "create room with custom code");
  assert(custom.body.room.code === "MYCODE1", "code normalized to uppercase: " + custom.body.room.code);

  const dup = await request("POST", "/api/rooms", { name: "Dup Room", type: "temporary", code: "mycode1" }, cookieA);
  assert(dup.status === 409, "duplicate custom code rejected (case-insensitive)");

  const badFormat = await request("POST", "/api/rooms", { name: "Bad", type: "temporary", code: "ab" }, cookieA);
  assert(badFormat.status === 400, "too-short custom code rejected");

  console.log("-- Two temp rooms get genuinely different auto codes --");
  const t1 = await request("POST", "/api/rooms", { name: "Temp One", type: "temporary" }, cookieA);
  const t2 = await request("POST", "/api/rooms", { name: "Temp One", type: "temporary" }, cookieA);
  assert(t1.body.room.code !== t2.body.room.code, `different codes for same-named rooms: ${t1.body.room.code} vs ${t2.body.room.code}`);
  assert(t1.body.room.name === t2.body.room.name, "same name allowed on two different rooms (not a bug, codes are the unique identifier)");

  console.log("-- Time-based expiry sweep (sweep interval set to 1.5s for this test) --");
  const shortLived = await request("POST", "/api/rooms", { name: "Short Lived", type: "temporary", expiresInSeconds: 2 }, cookieA);
  assert(shortLived.status === 201, "created room with 2s expiry");
  const roomId = shortLived.body.room.id;

  const sock = io(BASE, { extraHeaders: { Cookie: cookieA }, transports: ["websocket"] });
  await new Promise((res) => sock.on("connect", res));
  await new Promise((res) => sock.emit("room:join", { roomId }, res));
  const deletedEventPromise = new Promise((resolve) => sock.once("room:deleted", resolve));

  await sleep(5000);
  const deletedEvent = await Promise.race([deletedEventPromise, sleep(500).then(() => null)]);
  assert(deletedEvent && deletedEvent.roomId === roomId && deletedEvent.reason === "expired", "room:deleted socket event received with correct reason");

  const afterSweep = await request("GET", `/api/rooms/${roomId}`, null, cookieA);
  assert(afterSweep.status === 404, "expired room actually gone from DB: status " + afterSweep.status);

  sock.close();

  console.log("-- Logout-triggered deletion --");
  const b = await request("POST", "/api/auth/signup", { username: "logoutuser", email: "logoutuser@test.com", password: "password123" });
  const cookieB = b.cookie;
  const logoutRoom = await request("POST", "/api/rooms", { name: "Delete On Logout", type: "temporary", deleteOnOwnerLogout: true }, cookieB);
  assert(logoutRoom.status === 201, "created delete-on-logout room");
  const logoutRoomId = logoutRoom.body.room.id;

  const beforeLogout = await request("GET", `/api/rooms/${logoutRoomId}`, null, cookieB);
  assert(beforeLogout.status === 200, "room exists before logout");

  await request("POST", "/api/auth/logout", null, cookieB);

  const c = await request("POST", "/api/auth/login", { identifier: "logoutuser", password: "password123" });
  const cookieB2 = c.cookie;
  const afterLogout = await request("GET", `/api/rooms/${logoutRoomId}`, null, cookieB2);
  assert(afterLogout.status === 404, "room deleted after owner logout: got status " + afterLogout.status);

  console.log("\nALL ROOM-CODE / EXPIRY CHECKS PASSED");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
