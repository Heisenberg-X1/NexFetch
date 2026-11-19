"use strict";

const { invoke } = window.__TAURI__.core;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = ["gid", "status", "totalLength", "completedLength", "downloadSpeed", "uploadSpeed", "uploadLength", "connections", "errorMessage", "files", "bittorrent", "followedBy", "seeder", "numSeeders"];
const DETAIL_KEYS = [...KEYS, "bitfield", "numPieces", "pieceLength", "dir"];

let ws = null;
let secret = "";
let nextId = 0;
const pending = new Map();

let items = [];
let view = "all";
let query = "";
let sort = { key: null, dir: 1 };
let selected = null;
let detail = null;
let detailPeers = null;
let globalDir = "";
let enginePort = 0;
const BRIDGE_PORT = 16800;

const HIST_N = 60;
const speedHist = new Array(HIST_N).fill(0);
const gidHist = new Map(); // gid -> recent speed samples

/* ================= settings ================= */

const DEFAULTS = { theme: "auto", accent: "amber", concurrent: 5, limit: 0, connections: 16, seed: "off" };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("nexfetch.settings") || "{}") }; } catch { /* first run */ }

function saveSettings() {
  try { localStorage.setItem("nexfetch.settings", JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

function applyLook() {
  const root = document.documentElement;
  if (settings.theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  root.dataset.accent = settings.accent;
}

async function applyEngine() {
  try {
    await rpc("aria2.changeGlobalOption", [{
      "max-concurrent-downloads": String(settings.concurrent),
      "max-overall-download-limit": String(Math.round(settings.limit * 1048576)),
    }]);
  } catch { /* engine not ready yet */ }
}

applyLook();

/* ================= aria2 JSON-RPC over WebSocket ================= */

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("The download engine is not running."));
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: [`token:${secret}`, ...params] }));
  });
}

function onMessage(e) {
  const msg = JSON.parse(e.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message));
  else p.resolve(msg.result);
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}/jsonrpc`);
    sock.onopen = () => { ws = sock; resolve(); };
    sock.onerror = () => reject(new Error("connect failed"));
    sock.onmessage = onMessage;
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      setStatus("The download engine stopped. Restart NexFetch.", true);
      for (const p of pending.values()) p.reject(new Error("The download engine stopped."));
      pending.clear();
    };
  });
}

async function connect() {
  const cfg = await invoke("rpc_config");
  secret = cfg.secret;
  enginePort = cfg.port;
  for (let i = 0; i < 50; i++) {
    try {
      await openSocket(cfg.port);
      setStatus("Engine ready", false, true);
      try { globalDir = (await rpc("aria2.getGlobalOption")).dir || ""; } catch { /* optional */ }
      await applyEngine();
      return;
    } catch {
      await sleep(200);
    }
  }
  setStatus("Couldn't start the download engine. Check that aria2c is in src-tauri/binaries.", true);
}

/* ================= formatting ================= */

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}

function fmtDur(sec) {
  if (!isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${Math.ceil(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.ceil(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}m`;
}

function nameOf(d) {
  const bt = d.bittorrent && d.bittorrent.info && d.bittorrent.info.name;
  if (bt) return bt;
  const f = d.files && d.files[0];
  if (f && f.path) {
    const base = f.path.split(/[\\/]/).pop();
    return base.startsWith("[METADATA]") ? "Fetching torrent info…" : base;
  }
  const uri = f && f.uris && f.uris[0] && f.uris[0].uri;
  if (uri) {
    const last = uri.split("?")[0].split("/").pop();
    try { return decodeURIComponent(last || uri); } catch { return last || uri; }
  }
  return "Fetching file info…";
}

function stateOf(d) {
  switch (d.status) {
    case "active": return d.seeder === "true" ? "seeding" : "active";
    case "waiting": return "queued";
    case "paused": return "paused";
    case "complete": return "done";
    case "error": return "failed";
    default: return "removed";
  }
}

const STATE_TEXT = { active: "Downloading", seeding: "Seeding", queued: "Queued", paused: "Paused", done: "Finished", failed: "Failed" };

const KINDS = [
  ["app", /^(exe|msi|dmg|pkg|deb|rpm|apk|appimage)$/],
  ["pack", /^(zip|rar|7z|tar|gz|bz2|xz|iso|img)$/],
  ["video", /^(mp4|mkv|avi|mov|webm|m4v|flv|ts)$/],
  ["audio", /^(mp3|flac|wav|aac|ogg|m4a|opus)$/],
  ["doc", /^(pdf|docx?|xlsx?|pptx?|txt|epub)$/],
  ["image", /^(jpe?g|png|gif|webp|svg|bmp)$/],
];

function kindOf(name) {
  const i = name.lastIndexOf(".");
  const ext = i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : "";
  if (!ext || ext.length > 5 || /[^a-z0-9]/.test(ext)) return { kind: "other", label: "FILE" };
  const hit = KINDS.find(([, re]) => re.test(ext));
  return { kind: hit ? hit[0] : "other", label: ext.toUpperCase() };
}

const isMetaDone = (d) => Array.isArray(d.followedBy) && d.followedBy.length > 0;
const kindOfItem = (d, name = nameOf(d)) => (d.bittorrent ? { kind: "torrent", label: "TOR" } : kindOf(name));

const progOf = (d) => {
  const total = Number(d.totalLength), done = Number(d.completedLength);
  return ["done", "seeding"].includes(stateOf(d)) ? 100 : total > 0 ? Math.min(100, (done / total) * 100) : 0;
};

/* ================= views, search, sort ================= */

const LIB = {
  all: () => true,
  active: (s) => s === "active" || s === "seeding" || s === "queued" || s === "paused",
  done: (s) => s === "done",
  failed: (s) => s === "failed",
};

function inView(d, v = view) {
  const st = stateOf(d);
  if (LIB[v]) return LIB[v](st);
  if (v.startsWith("cat:")) return kindOfItem(d).kind === v.slice(4);
  return true;
}

const SORTS = {
  name: (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }),
  size: (a, b) => Number(a.totalLength) - Number(b.totalLength),
  progress: (a, b) => progOf(a) - progOf(b),
};

const EMPTY = {
  all: ["No downloads yet", "Press Add download, or copy a link and press Ctrl+V."],
  active: ["Nothing in progress", "Downloads that are running, paused or waiting show up here."],
  done: ["Nothing finished yet", "Completed downloads show up here."],
  failed: ["No failed downloads", "Anything that can't be downloaded shows up here."],
  cat: ["Nothing in this category", "Files are sorted here by their type."],
  search: ["No matches", "Try a different search."],
};

/* ================= rows (patched in place so buttons never flicker) ================= */

const ic = (n) => `<svg class="i"><use href="#i-${n}"/></svg>`;
const ibtn = (act, label, icon) => `<button class="ibtn" data-act="${act}" title="${label}" aria-label="${label}">${ic(icon)}</button>`;

function actionsHtml(st) {
  if (st === "seeding") return ibtn("pause", "Pause seeding", "pause") + ibtn("cancel", "Stop seeding", "close");
  if (st === "active" || st === "queued") return ibtn("pause", "Pause", "pause") + ibtn("cancel", "Cancel download", "close");
  if (st === "paused") return ibtn("resume", "Resume", "play") + ibtn("cancel", "Cancel download", "close");
  return ibtn("remove", "Remove from list", "trash");
}

function buildRow(gid) {
  const li = document.createElement("li");
  li.className = "row enter";
  li.dataset.gid = gid;
  li.innerHTML =
    '<div class="c-name"><div class="tile"><span class="tile-text"></span></div><div class="nm"><div class="name"></div><div class="sub"></div></div></div>' +
    '<div class="col-size"></div>' +
    '<div class="c-prog"><span class="pct"></span><div class="bar"><div class="fill"></div></div></div>' +
    '<div class="col-speed"></div><div class="col-eta"></div>' +
    '<div class="actions"></div>';
  li.addEventListener("animationend", (e) => { if (e.animationName === "rowIn") li.classList.remove("enter"); });
  return li;
}

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

function updateRow(li, d) {
  const st = stateOf(d);
  const total = Number(d.totalLength), speed = Number(d.downloadSpeed), done = Number(d.completedLength);
  const pct = progOf(d);

  const prev = li.dataset.state;
  if (prev !== st) {
    li.dataset.state = st;
    $(".actions", li).innerHTML = actionsHtml(st);
    if (prev && !["done", "seeding"].includes(prev) && ["done", "seeding"].includes(st)) {
      li.classList.add("flash");
      setTimeout(() => li.classList.remove("flash"), 1200);
      toast(`Finished: ${nameOf(d)}`);
    }
  }

  const name = nameOf(d);
  if (li._name !== name) {
    li._name = name;
    const el = $(".name", li);
    el.textContent = name;
    el.title = name;
    const k = kindOfItem(d, name);
    li.dataset.kind = k.kind;
    $(".tile-text", li).textContent = k.label;
  }

  const sub = $(".sub", li);
  setText(sub, st === "failed" ? d.errorMessage || "Download failed" : STATE_TEXT[st]);
  sub.classList.toggle("err", st === "failed");

  setText($(".col-size", li), total ? fmtBytes(total) : "—");
  setText($(".col-speed", li), st === "active" ? `${fmtBytes(speed)}/s` : st === "seeding" ? `↑ ${fmtBytes(d.uploadSpeed)}/s` : "—");
  setText($(".col-eta", li), st === "active" && speed > 0 && total ? fmtDur((total - done) / speed) : "—");

  const label = st === "done" ? "Done" : st === "failed" ? "Failed" : st === "queued" ? "Queued" : st === "seeding" ? "Seeding" : `${Math.floor(pct)}%`;
  setText($(".pct", li), label);
  $(".fill", li).style.width = `${pct}%`;

  li.classList.toggle("sel", d.gid === selected);
}

function patchList(shown) {
  const list = $("#list");
  const existing = new Map();
  for (const li of list.children) existing.set(li.dataset.gid, li);

  const rows = shown.map((d) => {
    let li = existing.get(d.gid);
    if (li) existing.delete(d.gid);
    else li = buildRow(d.gid);
    updateRow(li, d);
    return li;
  });
  for (const li of existing.values()) li.remove();

  let ref = list.firstElementChild;
  for (const li of rows) {
    if (li === ref) ref = ref.nextElementSibling;
    else list.insertBefore(li, ref);
  }
}

/* ================= sidebar gauge + sparklines ================= */

function sparkPaths(hist, w, h, max) {
  const n = hist.length;
  const pts = hist.map((v, i) => [(i * w) / (n - 1), h - 3 - (v / max) * (h - 8)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  return [line, `${line} L${w} ${h} L0 ${h} Z`];
}

function drawGauge() {
  const [line, area] = sparkPaths(speedHist, 160, 44, Math.max(...speedHist, 1));
  $("#spark-line").setAttribute("d", line);
  $("#spark-area").setAttribute("d", area);
}

function showSpeed(bps) {
  const [num, unit] = fmtBytes(bps).split(" ");
  $("#speed").innerHTML = `${num}<small> ${unit}/s</small>`;
}

/* ================= render ================= */

function render(globalStat) {
  const visible = items.filter((d) => stateOf(d) !== "removed" && !isMetaDone(d));

  for (const el of $$("[data-count]")) el.textContent = visible.filter((d) => inView(d, el.dataset.count)).length;
  $("#side-nav").classList.toggle("live", visible.some((d) => ["active", "seeding"].includes(stateOf(d))));

  const q = query.trim().toLowerCase();
  let shown = visible.filter((d) => inView(d) && (!q || nameOf(d).toLowerCase().includes(q)));
  if (sort.key) shown = [...shown].sort((a, b) => sort.dir * SORTS[sort.key](a, b));
  patchList(shown);

  const empty = $("#empty");
  empty.hidden = shown.length > 0;
  const msg = q ? EMPTY.search : EMPTY[view.startsWith("cat:") ? "cat" : view];
  $("#empty-title").textContent = msg[0];
  $("#empty-text").textContent = msg[1];

  if (globalStat) {
    const speed = Number(globalStat.downloadSpeed) || 0;
    speedHist.push(speed);
    speedHist.shift();
    showSpeed(speed);
    drawGauge();
    const active = Number(globalStat.numActive) || 0;
    setText($("#totals"), active ? `${active} active, ${fmtBytes(speed)}/s` : `${visible.length} item${visible.length === 1 ? "" : "s"}`);
  }
}

/* ================= details panel ================= */

function openDetail(gid) {
  selected = gid;
  $("#app").dataset.panel = "open";
  $("#detail").setAttribute("aria-hidden", "false");
  detail = items.find((d) => d.gid === gid) || null;
  if (detail) renderDetail();
  refreshDetail();
  for (const li of $$("#list .row")) li.classList.toggle("sel", li.dataset.gid === gid);
}

function closeDetail() {
  selected = null;
  detail = null;
  $("#app").dataset.panel = "closed";
  $("#detail").setAttribute("aria-hidden", "true");
  for (const li of $$("#list .row.sel")) li.classList.remove("sel");
}

async function refreshDetail() {
  if (!selected) return;
  const gid = selected;
  try {
    const s = await rpc("aria2.tellStatus", [gid, DETAIL_KEYS]);
    if (selected !== gid) return;
    detail = s;
    detailPeers = null;
    if (s.bittorrent && ["active", "seeding"].includes(stateOf(s))) {
      try { detailPeers = (await rpc("aria2.getPeers", [gid])).length; } catch { /* peers are optional */ }
    }
    if (selected !== gid) return;
    renderDetail();
  } catch {
    if (selected === gid && ws) closeDetail(); // download was removed
  }
}

function pieceFractions(bitfield, numPieces, cells) {
  const sum = new Array(cells).fill(0), cnt = new Array(cells).fill(0);
  for (let i = 0; i < numPieces; i++) {
    const nib = parseInt(bitfield[i >> 2] || "0", 16);
    const c = Math.min(cells - 1, Math.floor((i * cells) / numPieces));
    sum[c] += (nib >> (3 - (i & 3))) & 1;
    cnt[c]++;
  }
  return sum.map((v, i) => (cnt[i] ? v / cnt[i] : 0));
}

function drawMap(d) {
  const canvas = $("#d-map");
  const note = $("#d-map-note");
  const numPieces = Number(d.numPieces) || 0;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!numPieces || !d.bitfield) {
    note.textContent = "Piece data appears once the file starts downloading.";
    return;
  }
  const cells = Math.min(numPieces, 240);
  const cols = Math.min(cells, 60);
  const rows = Math.ceil(cells / cols);
  const gap = 2;
  const cw = (w - gap * (cols - 1)) / cols;
  const chh = Math.min(14, (h - gap * (rows - 1)) / rows);
  const frac = pieceFractions(d.bitfield, numPieces, cells);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#f5a524";
  const doneCol = getComputedStyle(document.documentElement).getPropertyValue("--done").trim() || "#2fd1a5";
  const col = stateOf(d) === "done" ? doneCol : accent;
  for (let i = 0; i < cells; i++) {
    const x = (i % cols) * (cw + gap), y = Math.floor(i / cols) * (chh + gap);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(127,140,160,.22)";
    ctx.beginPath(); ctx.roundRect(x, y, cw, chh, 2.5); ctx.fill();
    if (frac[i] > 0) {
      ctx.globalAlpha = 0.28 + 0.72 * frac[i];
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.roundRect(x, y, cw, chh, 2.5); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  const donePieces = frac.reduce((a, b) => a + b, 0);
  note.textContent = `${numPieces.toLocaleString()} pieces of ${fmtBytes(Number(d.pieceLength))}, ${Math.round((donePieces / cells) * 100)}% complete`;
}

function renderDetail() {
  const d = detail;
  if (!d) return;
  const st = stateOf(d);
  const total = Number(d.totalLength), done = Number(d.completedLength), speed = Number(d.downloadSpeed);
  const pct = progOf(d);
  const name = nameOf(d);
  const k = kindOfItem(d, name);

  setText($("#d-name"), name);
  $("#d-name").title = name;
  $("#d-tile").dataset.kind = k.kind;
  setText($("#d-tile-text"), k.label);
  const chip = $("#d-chip");
  chip.dataset.state = st;
  setText(chip, STATE_TEXT[st] || "");

  $(".ring").dataset.state = st;
  $("#d-ring").style.strokeDashoffset = String(326.73 * (1 - pct / 100));
  setText($("#d-pct"), `${Math.floor(pct)}%`);
  setText($("#d-speed-big"), st === "active" ? `${fmtBytes(speed)}/s` : STATE_TEXT[st] || "");

  setText($("#d-size"), total ? fmtBytes(total) : "—");
  setText($("#d-done"), fmtBytes(done));
  setText($("#d-eta"), st === "active" && speed > 0 && total ? fmtDur((total - done) / speed) : "—");
  setText($("#d-conn"), st === "active" ? String(d.connections || 0) : "—");

  renderTorrent(d, st);
  drawMap(d);

  const hist = gidHist.get(d.gid) || [0, 0];
  const [line, area] = sparkPaths(hist.length > 1 ? hist : [0, 0], 160, 44, Math.max(...hist, 1));
  $("#d-spark-line").setAttribute("d", line);
  $("#d-spark-area").setAttribute("d", area);

  const f = d.files && d.files[0];
  const uri = (f && f.uris && f.uris[0] && f.uris[0].uri) || "—";
  setText($("#d-url"), uri);
  $("#d-url").title = uri;
  const path = (f && f.path) || d.dir || "—";
  setText($("#d-path"), path);
  $("#d-path").title = path;

  const p = $("#d-primary"), s = $("#d-secondary");
  p.dataset.gid = s.dataset.gid = d.gid;
  if (st === "active" || st === "queued" || st === "seeding") { fillBtn(p, "pause", st === "seeding" ? "Pause seeding" : "Pause", "pause"); fillBtn(s, "cancel", st === "seeding" ? "Stop seeding" : "Cancel", "close"); }
  else if (st === "paused") { fillBtn(p, "resume", "Resume", "play"); fillBtn(s, "cancel", "Cancel", "close"); }
  else { p.hidden = true; fillBtn(s, "remove", "Remove from list", "trash"); }
}

let filesKey = "";
const relPath = (p, dir) => {
  const a = String(p).replace(/\\/g, "/");
  const b = String(dir || "").replace(/\\/g, "/").replace(/\/?$/, "/");
  return b !== "/" && a.startsWith(b) ? a.slice(b.length) : a;
};

function renderTorrent(d, st) {
  const isBt = !!d.bittorrent;
  $("#d-bt").hidden = !isBt;
  const files = isBt && d.files && d.files.length > 1 ? d.files : null; // single-file torrents don't need a picker
  $("#d-files-sec").hidden = !files;
  if (isBt) {
    const up = Number(d.uploadLength) || 0, got = Number(d.completedLength) || 0;
    setText($("#d-seeds"), d.numSeeders != null ? String(d.numSeeders) : "—");
    setText($("#d-peers"), detailPeers != null ? String(detailPeers) : "—");
    setText($("#d-up"), fmtBytes(up));
    setText($("#d-ratio"), got > 0 ? (up / got).toFixed(2) : "—");
  }
  if (!files) { filesKey = ""; return; }

  const shown = files.slice(0, 300);
  const list = $("#d-files");
  const key = `${d.gid}:${files.length}`;
  if (key !== filesKey) {
    filesKey = key;
    list.innerHTML = shown.map((f) => `<li class="file" data-idx="${Number(f.index)}"><label class="fcheck"><input type="checkbox" /></label><span class="fn"></span><span class="fs"></span><div class="fbar"><div class="ffill"></div></div></li>`).join("");
  }
  const editable = (st === "paused" || st === "queued") && files.length <= 300;
  shown.forEach((f, i) => {
    const li = list.children[i];
    if (!li) return;
    let name = relPath(f.path, d.dir);
    const root = `${d.bittorrent.info && d.bittorrent.info.name}/`;
    if (name.startsWith(root)) name = name.slice(root.length); // drop the torrent folder name
    const fn = $(".fn", li);
    if (fn.textContent !== name) { fn.textContent = name; fn.title = name; }
    const len = Number(f.length) || 0, got = Number(f.completedLength) || 0;
    setText($(".fs", li), `${fmtBytes(got)} of ${fmtBytes(len)}`);
    $(".ffill", li).style.width = `${len ? Math.min(100, (got / len) * 100) : 0}%`;
    const cb = $("input", li);
    cb.disabled = !editable;
    if (document.activeElement !== cb) cb.checked = f.selected === "true";
  });
  setText($("#d-files-note"), files.length > 300
    ? `Too many files to list here (${files.length}).`
    : editable ? "Tick the files you want, then press Resume." : "Pause the download to change which files are included.");
}

function fillBtn(btn, act, label, icon) {
  btn.hidden = false;
  btn.dataset.act = act;
  const html = `${ic(icon)}${label}`;
  if (btn._html !== html) { btn._html = html; btn.innerHTML = html; }
}

/* ================= polling ================= */

let polling = false;
async function poll() {
  if (polling || !ws) return;
  polling = true;
  try {
    const [active, waiting, stopped, stat] = await Promise.all([
      rpc("aria2.tellActive", [KEYS]),
      rpc("aria2.tellWaiting", [0, 200, KEYS]),
      rpc("aria2.tellStopped", [0, 200, KEYS]),
      rpc("aria2.getGlobalStat"),
    ]);
    items = [...active, ...waiting, ...stopped.reverse()]; // newest finished first
    for (const d of active) {
      const h = gidHist.get(d.gid) || new Array(40).fill(0);
      h.push(Number(d.downloadSpeed) || 0);
      if (h.length > 40) h.shift();
      gidHist.set(d.gid, h);
    }
    render(stat);
    if (selected) await refreshDetail();
  } catch {
    /* the socket handler already reports engine problems */
  } finally {
    polling = false;
  }
}

/* ================= status + toasts ================= */

function setStatus(text, bad = false, ok = false) {
  const el = $("#status");
  el.textContent = text;
  el.classList.toggle("bad", bad);
  el.classList.toggle("ok", ok);
}

function toast(text, bad = false) {
  const box = $("#toasts");
  while (box.children.length >= 4) box.firstElementChild.remove();
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, bad ? 5000 : 3200);
}

/* ================= actions ================= */

async function doAction(act, gid) {
  try {
    switch (act) {
      case "pause": await rpc("aria2.pause", [gid]); break;
      case "resume": await rpc("aria2.unpause", [gid]); break;
      case "cancel":
        await rpc("aria2.remove", [gid]);
        await rpc("aria2.removeDownloadResult", [gid]).catch(() => {});
        if (selected === gid) closeDetail();
        break;
      case "remove":
        await rpc("aria2.removeDownloadResult", [gid]);
        if (selected === gid) closeDetail();
        break;
    }
    poll();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ================= modals ================= */

let addConn = settings.connections;

function bindSeg(el, get, set) {
  const paint = () => $$("button", el).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === String(get()))));
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    set(b.dataset.v);
    paint();
  });
  paint();
  return paint;
}

const paintAddConn = bindSeg($("#add-conn"), () => addConn, (v) => { addConn = Number(v); });
const paintTheme = bindSeg($("#set-theme"), () => settings.theme, (v) => { settings.theme = v; saveSettings(); applyLook(); });
const paintAccent = bindSeg($("#set-accent"), () => settings.accent, (v) => { settings.accent = v; saveSettings(); applyLook(); });
const paintSeed = bindSeg($("#set-seed"), () => settings.seed, (v) => { settings.seed = v; saveSettings(); });
const paintSetConn = bindSeg($("#set-conn"), () => settings.connections, (v) => { settings.connections = Number(v); saveSettings(); });

function openModal(id) {
  $(id).hidden = false;
}
function closeModals() {
  for (const m of $$(".scrim")) m.hidden = true;
}
const modalOpen = () => $$(".scrim").some((m) => !m.hidden);

function openAdd(prefill = "") {
  addConn = settings.connections;
  paintAddConn();
  $("#add-urls").value = prefill;
  $("#add-name").value = "";
  $("#add-paused").checked = false;
  $("#add-choose").checked = false;
  setTorrents([]);
  setText($("#add-dir"), globalDir || "your Downloads folder");
  openModal("#add-modal");
  $("#add-urls").focus();
}

function openSettings() {
  paintTheme(); paintAccent(); paintSetConn(); paintSeed();
  const note = $("#pair-note");
  note.hidden = !enginePort || enginePort === BRIDGE_PORT;
  note.textContent = `Port ${BRIDGE_PORT} is in use by another program, so the extension may need pairing again after each restart.`;
  $("#set-concurrent").value = settings.concurrent;
  $("#set-limit").value = settings.limit;
  openModal("#settings-modal");
}

let torrentFiles = [];
function setTorrents(list) {
  torrentFiles = list;
  $("#add-picked").textContent = list.length ? list.map((f) => f.name).join(", ") : "No file chosen";
  if (!list.length) $("#add-torrent").value = "";
}
$("#add-pick").addEventListener("click", () => $("#add-torrent").click());
$("#add-torrent").addEventListener("change", (e) => setTorrents([...e.target.files]));

const readB64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
  r.readAsDataURL(file);
});

function seedOpts() {
  return settings.seed === "off" ? { "seed-time": "0" } : { "seed-ratio": settings.seed === "1" ? "1.0" : "2.0" };
}

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const urls = $("#add-urls").value.split(/\s+/).filter((u) => /^(https?|ftp|magnet):/i.test(u));
  if (!urls.length && !torrentFiles.length) {
    const dlg = $("#add-form");
    dlg.classList.remove("shake");
    void dlg.offsetWidth;
    dlg.classList.add("shake");
    toast("Add a link, a magnet link or a .torrent file.", true);
    return;
  }
  const paused = $("#add-paused").checked;
  const choose = $("#add-choose").checked;
  const base = { split: String(addConn), "max-connection-per-server": String(Math.min(addConn, 16)), ...seedOpts() };
  const name = $("#add-name").value.trim();
  let added = 0;
  try {
    for (const u of urls) {
      const o = { ...base };
      const magnet = /^magnet:/i.test(u);
      if (name && urls.length === 1 && !torrentFiles.length && !magnet) o.out = name;
      if (paused) o.pause = "true";
      if (magnet && choose) o["pause-metadata"] = "true"; // stop after the file list is known, so files can be picked
      await rpc("aria2.addUri", [[u], o]);
      added++;
    }
    for (const f of torrentFiles) {
      const o = { ...base };
      if (paused || choose) o.pause = "true";
      await rpc("aria2.addTorrent", [await readB64(f), [], o]);
      added++;
    }
    closeModals();
    toast(added === 1 ? "Download added" : `${added} downloads added`);
    if (choose) toast("Open the paused download to pick files, then press Resume.");
    poll();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#d-files").addEventListener("change", async (e) => {
  const cb = e.target.closest("input");
  if (!cb || !selected) return;
  const idxs = $$("#d-files .file").filter((li) => $("input", li).checked).map((li) => li.dataset.idx);
  if (!idxs.length) { cb.checked = true; toast("Keep at least one file selected.", true); return; }
  try {
    await rpc("aria2.changeOption", [selected, { "select-file": idxs.join(",") }]);
  } catch (err) {
    cb.checked = !cb.checked;
    toast(err.message, true);
  }
});

$("#set-concurrent").addEventListener("change", (e) => {
  settings.concurrent = Math.min(20, Math.max(1, Number(e.target.value) || DEFAULTS.concurrent));
  e.target.value = settings.concurrent;
  saveSettings(); applyEngine();
});
$("#set-limit").addEventListener("change", (e) => {
  settings.limit = Math.max(0, Number(e.target.value) || 0);
  e.target.value = settings.limit;
  saveSettings(); applyEngine();
});

for (const m of $$(".scrim")) {
  m.addEventListener("mousedown", (e) => { if (e.target === m) closeModals(); });
  for (const b of $$("[data-close]", m)) b.addEventListener("click", closeModals);
}

/* ================= events ================= */

$("#btn-add").addEventListener("click", () => openAdd());
$("#copy-pair").addEventListener("click", async () => {
  if (!enginePort || !secret) { toast("The engine isn't ready yet.", true); return; }
  try {
    await navigator.clipboard.writeText(`NEXFETCH:${enginePort}:${secret}`);
    toast("Pairing code copied. Paste it into the extension.");
  } catch {
    toast("Couldn't copy the code.", true);
  }
});
$("#btn-settings").addEventListener("click", openSettings);
$("#btn-pause-all").addEventListener("click", async () => { try { await rpc("aria2.pauseAll"); poll(); } catch (err) { toast(err.message, true); } });
$("#btn-resume-all").addEventListener("click", async () => { try { await rpc("aria2.unpauseAll"); poll(); } catch (err) { toast(err.message, true); } });
$("#clear").addEventListener("click", async () => {
  try { await rpc("aria2.purgeDownloadResult"); if (selected && detail && ["done", "failed"].includes(stateOf(detail))) closeDetail(); poll(); }
  catch (err) { toast(err.message, true); }
});

$("#search").addEventListener("input", (e) => { query = e.target.value; render(); });

$("#side-nav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  view = b.dataset.view;
  for (const x of $$("#side-nav button")) x.setAttribute("aria-current", String(x === b));
  render();
});

$(".thead").addEventListener("click", (e) => {
  const th = e.target.closest("button[data-sort]");
  if (!th) return;
  const key = th.dataset.sort;
  if (sort.key !== key) sort = { key, dir: 1 };
  else if (sort.dir === 1) sort.dir = -1;
  else sort = { key: null, dir: 1 };
  for (const x of $$(".th[data-sort]")) {
    if (x.dataset.sort === sort.key) x.dataset.dir = String(sort.dir);
    else delete x.dataset.dir;
  }
  render();
});

$("#list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  const row = e.target.closest(".row");
  if (!row) return;
  if (btn) { doAction(btn.dataset.act, row.dataset.gid); return; }
  if (selected === row.dataset.gid) closeDetail();
  else openDetail(row.dataset.gid);
});

$("#d-close").addEventListener("click", closeDetail);
for (const b of [$("#d-primary"), $("#d-secondary")]) b.addEventListener("click", () => doAction(b.dataset.act, b.dataset.gid));
$("#d-copy").addEventListener("click", async () => {
  const url = $("#d-url").textContent;
  if (!url || url === "—") return;
  try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { toast("Couldn't copy the link", true); }
});

// Copy a link anywhere, press Ctrl+V in the window, and the Add dialog opens with it filled in.
document.addEventListener("paste", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  const text = ((e.clipboardData && e.clipboardData.getData("text")) || "").trim();
  if (/^(https?|ftp|magnet):/i.test(text)) {
    e.preventDefault();
    if ($("#add-modal").hidden) openAdd(text);
  }
});

document.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement && document.activeElement.tagName);
  if (e.key === "Escape") {
    if (modalOpen()) closeModals();
    else if (selected) closeDetail();
    else if (typing) document.activeElement.blur();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") { e.preventDefault(); openAdd(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); $("#search").focus(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !$("#add-modal").hidden) { $("#add-form").requestSubmit(); return; }
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !typing && !modalOpen()) {
    const rows = $$("#list .row");
    if (rows.length) {
      e.preventDefault();
      const i = rows.findIndex((r) => r.dataset.gid === selected);
      const next = rows[e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1)];
      openDetail(next.dataset.gid);
      next.scrollIntoView({ block: "nearest" });
    }
    return;
  }
  if (e.key === "Delete" && !typing && !modalOpen() && selected && detail) {
    doAction(["done", "failed"].includes(stateOf(detail)) ? "remove" : "cancel", selected);
  }
});

window.addEventListener("resize", () => { if (detail) drawMap(detail); });

/* ================= links and files handed over by Windows ================= */

function fileFromB64(name, b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: "application/x-bittorrent" });
}

async function takeLaunchItems() {
  let items = [];
  try { items = await invoke("take_launch_items"); } catch { return; }
  if (!items.length) return;
  const magnets = items.filter((i) => i.type === "magnet").map((i) => i.value);
  const torrents = items.filter((i) => i.type === "torrent").map((i) => fileFromB64(i.name, i.data));
  if (!magnets.length && !torrents.length) return;

  if ($("#add-modal").hidden) {
    openAdd(magnets.join("\n"));
    setTorrents(torrents);
  } else {
    // Add dialog already open: add to what's there instead of replacing it.
    const box = $("#add-urls");
    box.value = [box.value.trim(), ...magnets].filter(Boolean).join("\n");
    if (torrents.length) setTorrents([...torrentFiles, ...torrents]);
  }
}

const tauriEvent = window.__TAURI__ && window.__TAURI__.event;
if (tauriEvent) tauriEvent.listen("launch-items", takeLaunchItems);
takeLaunchItems();

drawGauge();
connect().then(() => {
  poll();
  setInterval(poll, 1000);
});
