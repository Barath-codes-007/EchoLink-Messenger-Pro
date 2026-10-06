(function () {
  "use strict";

  const tabs = document.querySelectorAll(".auth-tab");
  const forms = { login: document.getElementById("form-login"), signup: document.getElementById("form-signup"), forgot: document.getElementById("form-forgot") };
  const foot = document.getElementById("auth-foot");

  function showTab(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    Object.entries(forms).forEach(([key, form]) => form.classList.toggle("active", key === name));
    if (name === "login") foot.innerHTML = `Don't have an account? <a href="#" data-switch="signup">Sign up</a>`;
    else if (name === "signup") foot.innerHTML = `Already have an account? <a href="#" data-switch="login">Log in</a>`;
    else foot.innerHTML = `<a href="#" data-switch="login">Back to log in</a>`;
    bindFootLinks();
    document.title = (name === "signup" ? "Sign up" : name === "forgot" ? "Reset password" : "Log in") + " — EchoLink Messenger";
  }

  function bindFootLinks() {
    foot.querySelectorAll("[data-switch]").forEach((a) => {
      a.addEventListener("click", (e) => { e.preventDefault(); showTab(a.dataset.switch); });
    });
  }

  tabs.forEach((tab) => tab.addEventListener("click", () => showTab(tab.dataset.tab)));
  document.getElementById("forgot-link").addEventListener("click", (e) => { e.preventDefault(); showTab("forgot"); });

  const params = new URLSearchParams(location.search);
  showTab(params.get("mode") === "signup" ? "signup" : "login");

  function setLoading(form, loading) {
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = loading;
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = loading ? "Please wait…" : btn.dataset.label;
  }

  forms.login.addEventListener("submit", async (e) => {
    e.preventDefault();
    setLoading(forms.login, true);
    try {
      const identifier = document.getElementById("login-id").value.trim();
      const password = document.getElementById("login-pw").value;
      const rememberMe = document.getElementById("remember-me").checked;
      const { user } = await window.EchoAPI.post("/api/auth/login", { identifier, password, rememberMe });
      EchoToast.success(`Welcome back, ${user.username}!`);
      setTimeout(() => (location.href = "/app.html"), 500);
    } catch (err) {
      EchoToast.error(err.message);
      setLoading(forms.login, false);
    }
  });

  forms.signup.addEventListener("submit", async (e) => {
    e.preventDefault();
    setLoading(forms.signup, true);
    try {
      const username = document.getElementById("su-username").value.trim();
      const email = document.getElementById("su-email").value.trim();
      const password = document.getElementById("su-password").value;
      const { user } = await window.EchoAPI.post("/api/auth/signup", { username, email, password });
      EchoToast.success(`Account created — welcome, ${user.username}!`);
      setTimeout(() => (location.href = "/app.html"), 500);
    } catch (err) {
      EchoToast.error(err.message);
      setLoading(forms.signup, false);
    }
  });

  forms.forgot.addEventListener("submit", (e) => {
    e.preventDefault();
    EchoToast.info("If that email exists, a reset link would be sent (demo mode).");
    setTimeout(() => showTab("login"), 900);
  });
})();
