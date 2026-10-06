(function () {
  "use strict";

  let socket = null;
  const listeners = new Map();
  const reconnectHandlers = [];
  let hasConnectedOnce = false;

  function connect() {
    if (socket) return socket;
    socket = io(window.location.origin, { withCredentials: true, transports: ["websocket", "polling"] });

    // Socket.IO auto-reconnects the transport on its own, but a reconnect
    // gets the server a *brand new* socket.id — none of the server-side
    // room membership (socket.join), presence tracking, or call state tied
    // to the old socket carries over automatically. Without re-driving that
    // from the client on every successful (re)connect, a user who reconnects
    // (flaky wifi, laptop sleep, etc.) silently stops receiving events for
    // whatever room they were in until they manually switch rooms or reload.
    socket.on("connect", () => {
      if (hasConnectedOnce) {
        EchoToast?.info?.("Reconnected.");
        for (const handler of reconnectHandlers) {
          try { handler(); } catch (e) { console.error("[reconnect handler]", e); }
        }
      }
      hasConnectedOnce = true;
    });

    socket.io.on("reconnect_attempt", () => {
      EchoToast?.info?.("Reconnecting…");
    });

    socket.io.on("reconnect_failed", () => {
      EchoToast.error("Couldn't reconnect. Check your connection and reload.");
    });

    socket.on("connect_error", async (err) => {
      if (err.message === "unauthorized") {
        if (!socket._echoRefreshAttempted) {
          socket._echoRefreshAttempted = true;
          try {
            const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
            if (res.ok) return socket.connect();
          } catch (e) { /* fall through to redirect */ }
        }
        window.location.href = "/auth.html?mode=login";
      } else {
        EchoToast.error("Connection lost — retrying…");
      }
    });

    return socket;
  }

  /** Wraps an emit with an ack callback into a Promise. */
  function emitAck(event, payload) {
    return new Promise((resolve, reject) => {
      if (!socket) return reject(new Error("Not connected."));
      socket.emit(event, payload, (res) => {
        if (res && res.ok === false) reject(new Error(res.error || "Request failed."));
        else resolve(res);
      });
    });
  }

  window.EchoSocket = {
    connect,
    get raw() { return socket; },
    on: (event, cb) => socket && socket.on(event, cb),
    off: (event, cb) => socket && socket.off(event, cb),
    emit: (event, payload) => socket && socket.emit(event, payload),
    emitAck,
    // Registers a callback to run after every reconnect (not the first
    // connect). Used by app.js to rejoin the active room and restore
    // presence — see bindSocketEvents() there.
    onReconnect: (cb) => reconnectHandlers.push(cb),
  };
})();
