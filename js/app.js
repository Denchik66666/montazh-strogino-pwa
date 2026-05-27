const CONFIG = window.APP_CONFIG || {};
const QUEUE_KEY = "montazh_pending_queue";
const METRAZH_CACHE_KEY = "montazh_metrazh_cache";
const THEME_KEY = "montazh_theme";
const THEME_COLORS = { dark: "#0f172a", light: "#e3e4ea" };

let catalog = { site: { id: "", name: "" }, systems: [] };
/** @type {Record<string, number|string>} */
let metrazhMap = {};

const nav = {
  system: null,
  section: null,
};

let selectedCamera = null;
let inputValue = "";

const $ = (id) => document.getElementById(id);

function metrazhKey(systemId, camera) {
  return `${systemId}:${camera}`;
}

function toast(text, type = "success") {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2800);
}

function apiConfigured() {
  return Boolean(CONFIG.API_URL && CONFIG.API_URL.includes("script.google.com"));
}

function getQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
  } catch {
    return [];
  }
}

function setQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

function cacheMetrazh(map) {
  localStorage.setItem(METRAZH_CACHE_KEY, JSON.stringify(map));
}

function loadCachedMetrazh() {
  try {
    return JSON.parse(localStorage.getItem(METRAZH_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

async function apiGet(action, params = {}) {
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error("Сеть");
  return res.json();
}

async function apiSave(payload) {
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return res.json();
  } catch {
    /* GET fallback */
  }
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set("action", "save");
  url.searchParams.set("system", payload.system);
  url.searchParams.set("camera", payload.camera);
  url.searchParams.set("row", String(payload.row));
  url.searchParams.set("meters", String(payload.meters));
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error("Сеть");
  return res.json();
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** На экране: ВК2.1.1 → ВК 2.1.1 (в таблице код без пробела) */
function formatCameraCode(code) {
  return String(code || "").replace(/^ВК(?=\d)/i, "ВК ");
}

function parseSectionName(name) {
  const numM = String(name).match(/секция\s*(\d+)/i);
  const camM = String(name).match(/\((\d+)\s*камер/i);
  const num = numM ? parseInt(numM[1], 10) : 0;
  const cameras = camM ? parseInt(camM[1], 10) : 0;
  return {
    num,
    cameras,
    short: num ? `Секция ${num}` : name,
    sub: cameras ? `${cameras} камер` : "",
  };
}

function pickTone(index) {
  return `pick-card--tone-${(index % 6) + 1}`;
}

function pickStatus(done, total) {
  if (total && done >= total) return "pick-card--status-done";
  if (done > 0) return "pick-card--status-progress";
  return "pick-card--status-empty";
}

function statusLabel(done, total) {
  if (total && done >= total) return "Готово ✓";
  if (done > 0) return `В работе · ${done}/${total}`;
  return "Не начато";
}

function allCamerasFlat() {
  const list = [];
  for (const sys of catalog.systems) {
    if (!sys.ready) continue;
    for (const sec of sys.sections) {
      for (const cam of sec.cameras) {
        list.push({ system: sys, section: sec, camera: cam });
      }
    }
  }
  return list;
}

function cameraSearchHaystack(item) {
  const c = item.camera;
  return [
    c.camera,
    formatCameraCode(c.camera),
    c.floor,
    c.place,
    c.cable,
    item.system.code,
    item.section.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function countDone(system) {
  if (!system.ready) return { done: 0, total: 0 };
  let done = 0;
  let total = 0;
  for (const sec of system.sections) {
    for (const cam of sec.cameras) {
      total++;
      if (metrazhMap[metrazhKey(system.id, cam.camera)]) done++;
    }
  }
  return { done, total };
}

function countSectionDone(system, section) {
  let done = 0;
  const total = section.cameras.length;
  for (const cam of section.cameras) {
    if (metrazhMap[metrazhKey(system.id, cam.camera)]) done++;
  }
  return { done, total };
}

function showScreen(name) {
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  const screen = document.getElementById(`screen-${name}`);
  if (screen) screen.classList.add("active");

  const back = $("nav-back");
  back.hidden = name === "systems";

  updateHeader(name);
}

function updateHeader(screenName) {
  const site = catalog.site?.name || CONFIG.PROJECT_NAME || "Объект";
  const titles = {
    systems: site,
    sections: nav.system?.code || "Система",
    cameras: nav.section?.name || "Секция",
    input: "Метраж",
  };
  $("screen-title").textContent = titles[screenName] || "Метраж";

  const crumbs = [];
  if (screenName !== "systems") crumbs.push(site);
  if (nav.system && screenName !== "systems") crumbs.push(nav.system.code);
  if (nav.section && (screenName === "cameras" || screenName === "input")) {
    crumbs.push(nav.section.name.replace(/секция\s*/i, "Сек. "));
  }
  $("breadcrumb").textContent = crumbs.join(" › ");
}

function goSystems() {
  nav.system = null;
  nav.section = null;
  $("search-results").classList.add("hidden");
  $("global-search").value = "";
  showScreen("systems");
  renderSystems();
  updateStats();
}

function goSections(system) {
  nav.system = system;
  nav.section = null;
  showScreen("sections");
  renderSections();
  updateStats();
}

function goCameras(section) {
  nav.section = section;
  showScreen("cameras");
  renderCameras();
}

function goBack() {
  const active = document.querySelector(".screen.active")?.id;
  if (active === "screen-input") {
    showScreen("cameras");
    return;
  }
  if (active === "screen-cameras") {
    goSections(nav.system);
    return;
  }
  if (active === "screen-sections") {
    goSystems();
  }
}

async function loadCatalog() {
  const res = await fetch("catalog.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("Нет catalog.json");
  catalog = await res.json();
}

async function refreshMetrazh() {
  if (!apiConfigured()) {
    metrazhMap = loadCachedMetrazh();
    return;
  }
  try {
    const data = await apiGet("metrazh");
    if (data.ok && data.metrazh) {
      metrazhMap = data.metrazh;
      cacheMetrazh(metrazhMap);
    }
  } catch {
    metrazhMap = loadCachedMetrazh();
  }
}

async function flushQueue() {
  if (!apiConfigured() || !navigator.onLine) return;
  const remain = [];
  for (const item of getQueue()) {
    try {
      const r = await apiSave(item);
      if (r.ok) {
        const k = metrazhKey(item.system, item.camera);
        if (item.meters === 0) delete metrazhMap[k];
        else metrazhMap[k] = item.meters;
      } else remain.push(item);
    } catch {
      remain.push(item);
    }
  }
  setQueue(remain);
  cacheMetrazh(metrazhMap);
  refreshCurrentView();
  updateStats();
}

function refreshCurrentView() {
  const active = document.querySelector(".screen.active")?.id;
  if (active === "screen-systems") renderSystems();
  else if (active === "screen-sections") renderSections();
  else if (active === "screen-cameras") renderCameras();
}

function updateStats() {
  let allDone = 0;
  let allTotal = 0;
  for (const s of catalog.systems.filter((x) => x.ready)) {
    const c = countDone(s);
    allDone += c.done;
    allTotal += c.total;
  }
  $("stat-done").textContent = `Готово ${allDone}/${allTotal}`;
  const q = getQueue().length;
  const net = $("stat-net");
  if (!apiConfigured()) {
    net.textContent = "Демо";
    net.className = "pill warn";
  } else if (!navigator.onLine) {
    net.textContent = "Офлайн";
    net.className = "pill warn";
  } else if (q > 0) {
    net.textContent = `Очередь ${q}`;
    net.className = "pill warn";
  } else {
    net.textContent = "Онлайн";
    net.className = "pill ok";
  }
}

function renderSystems() {
  const root = $("systems-root");
  root.innerHTML = "";
  catalog.systems.forEach((sys, i) => {
    const btn = document.createElement("button");
    btn.type = "button";

    if (sys.ready) {
      const { done, total } = countDone(sys);
      const pct = total ? Math.round((done / total) * 100) : 0;
      btn.className = `pick-card pick-card--system ${pickTone(i)} ${pickStatus(done, total)}`;
      btn.innerHTML = `
        <span class="pick-num pick-num--code">${escapeHtml(sys.code)}</span>
        <span class="pick-body">
          <span class="pick-label">${escapeHtml(sys.title.replace(/^СОТ\s*—\s*/i, ""))}</span>
          <span class="pick-sub">${total} камер</span>
          <span class="pick-bar"><span style="width:${pct}%"></span></span>
        </span>
        <span class="pick-side">
          <span class="pick-fraction">${done}<span>/${total}</span></span>
          <span class="pick-status">${escapeHtml(statusLabel(done, total))}</span>
        </span>
      `;
      btn.addEventListener("click", () => goSections(sys));
    } else {
      btn.className = `pick-card pick-card--system pick-card--disabled ${pickTone(i)}`;
      btn.innerHTML = `
        <span class="pick-num pick-num--code">${escapeHtml(sys.code)}</span>
        <span class="pick-body">
          <span class="pick-label">${escapeHtml(sys.title)}</span>
          <span class="pick-sub pick-sub--warn">Скоро</span>
        </span>
      `;
      btn.addEventListener("click", () =>
        toast("Таблица для этой системы ещё не подключена", "queue")
      );
    }
    root.appendChild(btn);
  });
}

function renderSections() {
  const root = $("sections-root");
  root.innerHTML = "";
  const sys = nav.system;
  if (!sys?.ready) return;

  sys.sections.forEach((sec, i) => {
    const { done, total } = countSectionDone(sys, sec);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const info = parseSectionName(sec.name);
    const numLabel = info.num ? String(info.num).padStart(2, "0") : String(i + 1).padStart(2, "0");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pick-card pick-card--section ${pickTone(i)} ${pickStatus(done, total)}`;
    btn.innerHTML = `
      <span class="pick-num">${numLabel}</span>
      <span class="pick-body">
        <span class="pick-label">${escapeHtml(info.short)}</span>
        <span class="pick-sub">${escapeHtml(info.sub || `${total} камер`)}</span>
        <span class="pick-bar"><span style="width:${pct}%"></span></span>
      </span>
      <span class="pick-side">
        <span class="pick-fraction">${done}<span>/${total}</span></span>
        <span class="pick-status">${escapeHtml(statusLabel(done, total))}</span>
      </span>
    `;
    btn.addEventListener("click", () => goCameras(sec));
    root.appendChild(btn);
  });
}

function renderCameras() {
  const root = $("cameras-root");
  root.innerHTML = "";
  const sys = nav.system;
  const sec = nav.section;
  if (!sys || !sec) return;

  sec.cameras.forEach((cam, i) => {
    const m = metrazhMap[metrazhKey(sys.id, cam.camera)];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `camera-btn ${m ? "camera-btn--done" : "camera-btn--pending"} ${
      i % 2 ? "camera-btn--alt" : ""
    }`;
    btn.innerHTML = `
      <span class="cam-dot" aria-hidden="true"></span>
      <div class="cam-main">
        <div class="code">${escapeHtml(formatCameraCode(cam.camera))}</div>
        <div class="meta">${escapeHtml(cam.floor)} · ${escapeHtml(cam.place)}</div>
      </div>
      <div class="badge ${m ? "done" : "pending"}">${m ? escapeHtml(String(m)) + " м" : "ввод"}</div>
    `;
    btn.addEventListener("click", () => openInput(sys, sec, cam));
    root.appendChild(btn);
  });
}

function renderGlobalSearch(q) {
  const box = $("search-results");
  const norm = q.trim().toLowerCase();
  if (!norm) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  const hits = allCamerasFlat().filter((x) => cameraSearchHaystack(x).includes(norm));

  box.classList.remove("hidden");
  if (!hits.length) {
    box.innerHTML = '<p class="empty-msg">Не найдено</p>';
    return;
  }

  box.innerHTML = "";
  for (const x of hits.slice(0, 12)) {
    const m = metrazhMap[metrazhKey(x.system.id, x.camera.camera)];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-hit";
    btn.innerHTML = `
      <strong>${escapeHtml(formatCameraCode(x.camera.camera))}</strong>
      <span>${escapeHtml(x.system.code)} · ${escapeHtml(x.section.name)}</span>
      <em>${m ? m + " м" : "—"}</em>
    `;
    btn.addEventListener("click", () => {
      nav.system = x.system;
      nav.section = x.section;
      openInput(x.system, x.section, x.camera);
      box.classList.add("hidden");
      $("global-search").value = "";
    });
    box.appendChild(btn);
  }
}

function openInput(system, section, cam) {
  selectedCamera = { system, section, cam };
  const key = metrazhKey(system.id, cam.camera);
  const existing = metrazhMap[key];
  inputValue = existing ? String(existing).replace(/[^\d]/g, "") : "";

  $("input-system").textContent = `${catalog.site.name} · ${system.code} · ${section.name}`;
  $("input-code").textContent = formatCameraCode(cam.camera);
  $("input-info").textContent = [cam.floor, cam.place, cam.cable].filter(Boolean).join(" · ");

  const hint = $("overwrite-hint");
  if (existing) {
    hint.textContent = `Было: ${existing} м. Введите 0 — стерётся.`;
    hint.classList.add("show");
  } else hint.classList.remove("show");

  updateMetersDisplay();
  showScreen("input");
}

function isMetersValid(n) {
  if (n === 0) return true;
  return n >= 1 && n <= (CONFIG.MAX_METERS || 500);
}

function updateMetersDisplay() {
  const el = $("meters-display");
  const btn = $("btn-save");
  if (!inputValue) {
    el.textContent = "—";
    el.classList.add("empty");
    el.classList.remove("meters-display--clear");
    btn.disabled = true;
    btn.textContent = "СОХРАНИТЬ";
    btn.classList.remove("save-btn--clear");
  } else {
    el.textContent = inputValue;
    el.classList.remove("empty");
    const n = parseInt(inputValue, 10);
    const isClear = n === 0;
    el.classList.toggle("meters-display--clear", isClear);
    btn.disabled = !isMetersValid(n);
    btn.textContent = isClear ? "СТЕРЕТЬ МЕТРАЖ" : "СОХРАНИТЬ";
    btn.classList.toggle("save-btn--clear", isClear);
  }
}

function numpadHandler(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  const digit = btn.dataset.digit;
  const action = btn.dataset.action;
  if (digit !== undefined) {
    if (inputValue.length >= 3) return;
    inputValue = inputValue === "0" ? digit : inputValue + digit;
  } else if (action === "back") inputValue = inputValue.slice(0, -1);
  else if (action === "clear") inputValue = "";
  updateMetersDisplay();
}

async function saveMeters() {
  if (!selectedCamera || !inputValue) return;
  const { system, cam } = {
    system: selectedCamera.system,
    cam: selectedCamera.cam,
  };
  const meters = parseInt(inputValue, 10);
  if (!isMetersValid(meters)) {
    toast(`Введите 0 (стереть) или от 1 до ${CONFIG.MAX_METERS || 500} м`, "error");
    return;
  }

  const key = metrazhKey(system.id, cam.camera);
  const clearing = meters === 0;
  const payload = {
    system: system.id,
    sheet: system.sheet,
    camera: cam.camera,
    row: cam.row,
    meters,
    clear: clearing,
    at: new Date().toISOString(),
  };

  if (!apiConfigured()) {
    if (clearing) delete metrazhMap[key];
    else metrazhMap[key] = meters;
    cacheMetrazh(metrazhMap);
    toast(
      clearing ? `Стерто: ${formatCameraCode(cam.camera)}` : `✓ ${formatCameraCode(cam.camera)}: ${meters} м`,
      clearing ? "queue" : "success"
    );
    showScreen("cameras");
    renderCameras();
    updateStats();
    return;
  }

  $("btn-save").disabled = true;
  const offline = !navigator.onLine;

  const afterLocal = () => {
    if (clearing) delete metrazhMap[key];
    else metrazhMap[key] = meters;
    cacheMetrazh(metrazhMap);
    const msg = clearing
      ? offline
        ? "Стереть — отправится в сеть"
        : `Стерто: ${formatCameraCode(cam.camera)}`
      : offline
        ? "Сохранено — отправится в сеть"
        : `✓ ${formatCameraCode(cam.camera)}: ${meters} м`;
    toast(msg, offline || clearing ? "queue" : "success");
    showScreen("cameras");
    renderCameras();
    updateStats();
  };

  if (offline) {
    setQueue([...getQueue(), payload]);
    afterLocal();
    $("btn-save").disabled = false;
    return;
  }

  try {
    const r = await apiSave(payload);
    if (r.ok) afterLocal();
    else toast(r.error || "Ошибка", "error");
  } catch {
    setQueue([...getQueue(), payload]);
    afterLocal();
  } finally {
    $("btn-save").disabled = false;
  }
}

function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(THEME_KEY, t);

  const meta = document.getElementById("meta-theme-color");
  if (meta) meta.content = THEME_COLORS[t];

  const apple = document.getElementById("meta-apple-status");
  if (apple) apple.content = t === "light" ? "default" : "black-translucent";

  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.setAttribute("aria-label", t === "light" ? "Тёмная тема" : "Светлая тема");
  }
}

function initTheme() {
  let theme = localStorage.getItem(THEME_KEY);
  if (theme !== "light" && theme !== "dark") theme = "dark";
  applyTheme(theme);
  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
      applyTheme(cur === "light" ? "dark" : "light");
    });
  }
}

async function init() {
  initTheme();
  if (!apiConfigured()) $("setup-banner").classList.add("show");

  $("nav-back").addEventListener("click", goBack);
  $("numpad").addEventListener("click", numpadHandler);
  $("btn-save").addEventListener("click", saveMeters);
  $("global-search").addEventListener("input", (e) => renderGlobalSearch(e.target.value));

  window.addEventListener("online", () => {
    flushQueue();
    refreshMetrazh().then(() => {
      refreshCurrentView();
      updateStats();
    });
  });

  try {
    await loadCatalog();
    metrazhMap = loadCachedMetrazh();
    await refreshMetrazh();
    await flushQueue();
    goSystems();
  } catch {
    $("systems-root").innerHTML =
      '<p class="empty-msg">Нет catalog.json — в папке montazh-pwa: npm run export</p>';
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  setInterval(flushQueue, 30000);
  setInterval(refreshMetrazh, 60000);
}

init();
