"use strict";

/* ---------- theme toggle ---------- */
(() => {
  const root = document.documentElement;
  const btn = document.getElementById("theme");
  const effective = () => root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  btn.addEventListener("click", () => {
    const next = effective() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("nf-theme", next); } catch { /* storage blocked */ }
  });
})();

/* ---------- live download preview in the hero ---------- */
(() => {
  const demo = document.getElementById("demo");
  if (!demo) return;
  const ICON = {
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9M10.5 3.5v9"/></svg>',
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6l8-4.8z" fill="currentColor" stroke="none"/></svg>',
  };
  const fmt = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

  const rows = [...demo.querySelectorAll(".d-row")].map((el) => ({
    el,
    bar: el.querySelector(".bar i"),
    meta: el.querySelector(".d-meta"),
    btn: el.querySelector(".ibtn"),
    size: Number(el.dataset.size),
    speed: Number(el.dataset.speed) || 4,
    p: Number(el.dataset.p),
    paused: el.dataset.paused === "true",
    done: false,
    wait: 0,
  }));

  const draw = (r) => {
    const state = r.done ? "done" : r.paused ? "paused" : "active";
    r.el.dataset.state = state;
    r.bar.style.width = `${r.p}%`;
    r.meta.textContent = r.done
      ? `Finished, ${fmt(r.size)}`
      : r.paused
        ? `Paused at ${fmt((r.p / 100) * r.size)} of ${fmt(r.size)}`
        : `${fmt((r.p / 100) * r.size)} of ${fmt(r.size)}, ${r.speed.toFixed(1)} MB/s`;
    r.btn.innerHTML = r.paused ? ICON.play : ICON.pause;
    r.btn.setAttribute("aria-label", r.paused ? "Resume" : "Pause");
    r.btn.hidden = r.done;
  };

  for (const r of rows) {
    r.btn.addEventListener("click", () => { r.paused = !r.paused; draw(r); showSpeed(); });
    draw(r);
  }

  const total = document.getElementById("demo-speed");
  function showSpeed() {
    const sum = rows.filter((r) => !r.paused && !r.done).reduce((a, r) => a + r.speed * (0.94 + Math.random() * 0.12), 0);
    total.textContent = `${sum.toFixed(1)} MB/s`;
  }
  showSpeed();

  setInterval(() => {
    for (const r of rows) {
      if (r.done) {
        if (++r.wait > 6) { r.done = false; r.p = 3; r.wait = 0; draw(r); }
        continue;
      }
      if (r.paused) continue;
      r.p = Math.min(100, r.p + (r.speed * 0.9 * 100) / r.size * 4);
      if (r.p >= 100) { r.done = true; r.wait = 0; }
      draw(r);
    }
    showSpeed();
  }, 700);
})();
