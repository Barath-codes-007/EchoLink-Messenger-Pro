(function () {
  "use strict";

  let refreshInFlight = null;

  async function tryRefresh() {
    if (!refreshInFlight) {
      refreshInFlight = fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
        .then((res) => res.ok)
        .catch(() => false)
        .finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  async function request(method, url, body, isForm, isRetry) {
    const opts = {
      method,
      credentials: "include",
      headers: isForm ? {} : { "Content-Type": "application/json" },
    };
    if (body) opts.body = isForm ? body : JSON.stringify(body);

    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      throw new Error("Can't reach the server. Check your connection.");
    }

    // Access tokens are short-lived by design (15 min) — on a 401 (but not
    // for the auth endpoints themselves, to avoid loops), try one silent
    // refresh-and-retry before surfacing an error.
    if (res.status === 401 && !isRetry && !url.startsWith("/api/auth/")) {
      const refreshed = await tryRefresh();
      if (refreshed) return request(method, url, body, isForm, true);
    }

    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }

    if (!res.ok) {
      const message = (data && data.error) || `Request failed (${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  window.EchoAPI = {
    get: (url) => request("GET", url),
    post: (url, body) => request("POST", url, body),
    patch: (url, body) => request("PATCH", url, body),
    del: (url) => request("DELETE", url),
    postForm: (url, formData) => request("POST", url, formData, true),
  };
})();
