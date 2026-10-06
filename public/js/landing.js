(function () {
  "use strict";

  document.getElementById("year").textContent = new Date().getFullYear();

  /* ---- Theme toggle ---- */
  const themeBtn = document.getElementById("theme-toggle");
  themeBtn.addEventListener("click", () => window.EchoTheme.toggle());

  /* ---- Ripple effect on all .btn elements ---- */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn, .btn-icon");
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement("span");
    const size = Math.max(rect.width, rect.height);
    ripple.className = "ripple";
    ripple.style.width = ripple.style.height = size + "px";
    ripple.style.left = e.clientX - rect.left - size / 2 + "px";
    ripple.style.top = e.clientY - rect.top - size / 2 + "px";
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
  });

  /* ---- Hero typing animation ---- */
  const phrases = ["temporary room", "permanent room", "video call", "voice channel"];
  const typingEl = document.getElementById("hero-typing");
  let phraseIndex = 0, charIndex = 0, deleting = false;

  function tick() {
    const current = phrases[phraseIndex];
    if (!deleting) {
      charIndex++;
      typingEl.textContent = current.slice(0, charIndex);
      if (charIndex === current.length) {
        deleting = true;
        setTimeout(tick, 1400);
        return;
      }
    } else {
      charIndex--;
      typingEl.textContent = current.slice(0, charIndex);
      if (charIndex === 0) {
        deleting = false;
        phraseIndex = (phraseIndex + 1) % phrases.length;
      }
    }
    setTimeout(tick, deleting ? 35 : 65);
  }
  tick();

  /* ---- Stat counters (animate on scroll into view) ---- */
  const statEls = document.querySelectorAll(".stat-num");
  const statObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const target = parseFloat(el.dataset.count);
      const isDecimal = String(target).includes(".");
      let start = 0;
      const duration = 1100;
      const startTime = performance.now();
      function frame(now) {
        const progress = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const value = target * eased;
        el.textContent = isDecimal ? value.toFixed(1) : Math.round(value);
        if (progress < 1) requestAnimationFrame(frame);
        else el.textContent = isDecimal ? target.toFixed(1) : target;
      }
      requestAnimationFrame(frame);
      statObserver.unobserve(el);
    });
  }, { threshold: 0.5 });
  statEls.forEach((el) => statObserver.observe(el));

  /* ---- FAQ accordion ---- */
  document.querySelectorAll(".faq-item").forEach((item) => {
    item.querySelector(".faq-q").addEventListener("click", () => {
      const wasOpen = item.classList.contains("open");
      document.querySelectorAll(".faq-item.open").forEach((o) => o.classList.remove("open"));
      if (!wasOpen) item.classList.add("open");
    });
  });

  /* ---- Scroll-reveal for sections ---- */
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = "1";
        entry.target.style.transform = "translateY(0)";
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll(".feature-card, .testimonial-card, .roadmap-item").forEach((el) => {
    el.style.opacity = "0";
    el.style.transform = "translateY(16px)";
    el.style.transition = "opacity 0.5s ease, transform 0.5s ease";
    revealObserver.observe(el);
  });

  /* ---- Hero mockup: a lightweight inline recreation of the chat UI,
     avoids needing a static screenshot asset while still giving the hero
     something concrete (not just gradient blobs) to look at. ---- */
  const mockup = document.getElementById("hero-mockup");
  if (mockup) {
    mockup.innerHTML = `
      <div style="display:flex; height:380px;">
        <div style="width:64px; background:var(--surface-2); border-right:1px solid var(--border); display:flex; flex-direction:column; align-items:center; padding:16px 0; gap:14px;">
          <div class="brand-mark" style="width:32px;height:32px;font-size:14px;">E</div>
          ${["#00D9C0","#6C5CE7","#F5B94D"].map(c => `<div style="width:32px;height:32px;border-radius:10px;background:${c}22;border:1.5px solid ${c}55;"></div>`).join("")}
        </div>
        <div style="flex:1; display:flex; flex-direction:column;">
          <div style="padding:14px 20px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:10px;">
            <div class="avatar-fallback" style="width:30px;height:30px;font-size:11px;">DS</div>
            <div><div style="font-size:13px;font-weight:600;">Design Sync</div><div style="font-size:11px;color:var(--text-muted);">4 online</div></div>
            <div style="margin-left:auto; display:flex; gap:8px;">
              <div class="btn-icon" style="width:30px;height:30px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z"/></svg></div>
            </div>
          </div>
          <div style="flex:1; padding:18px 20px; display:flex; flex-direction:column; gap:14px; overflow:hidden;">
            <div style="display:flex; gap:10px; max-width:70%;">
              <div class="avatar-fallback" style="width:26px;height:26px;font-size:10px;flex-shrink:0;">RS</div>
              <div class="soft-panel" style="padding:10px 14px; font-size:13px;">Loving the new permanent room codes 🔥</div>
            </div>
            <div style="display:flex; gap:10px; max-width:70%; margin-left:auto; flex-direction:row-reverse;">
              <div class="soft-panel" style="padding:10px 14px; font-size:13px; background:var(--accent-soft); border-color:transparent;">Right? Try scanning the QR code too</div>
            </div>
            <div style="display:flex; gap:10px; max-width:60%;">
              <div class="avatar-fallback" style="width:26px;height:26px;font-size:10px;flex-shrink:0;">MA</div>
              <div class="soft-panel" style="padding:8px 12px; display:flex; align-items:center; gap:6px;">
                <span style="width:6px;height:6px;border-radius:50%;background:var(--text-faint); animation: skeleton-shimmer 1s infinite;"></span>
                <span style="width:6px;height:6px;border-radius:50%;background:var(--text-faint);"></span>
                <span style="width:6px;height:6px;border-radius:50%;background:var(--text-faint);"></span>
              </div>
            </div>
          </div>
          <div style="padding:14px 20px; border-top:1px solid var(--border); display:flex; gap:10px; align-items:center;">
            <div class="input" style="flex:1; padding:10px 14px; font-size:13px; color:var(--text-faint);">Message #design-sync</div>
            <div class="echo-rings"><div class="btn-icon" style="background:var(--accent-grad); color:#06141B;"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="m3 3 18 9-18 9v-7l12-2-12-2V3Z"/></svg></div></div>
          </div>
        </div>
      </div>
    `;
  }
})();
