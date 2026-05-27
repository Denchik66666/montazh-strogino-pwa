const CONFIG = window.APP_CONFIG || {};
const QUEUE_KEY = "montazh_pending_queue";
const METRAZH_CACHE_KEY = "montazh_metrazh_cache";

/** @type {{ cameras: object[], project: string }} */
let catalog = { cameras: [], project: "" };
/** @type {Record<string, number|string>} */
let metrazhMap = {};
let selectedCamera = null;
let inputValue = "";

const $ = (id) => document.getElementById(id);

function toast(text, type = "success") {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2800);
}

function isOnline() {
  return navigator.onLine;
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

async function apiGet(action) {
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set("action", action);
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
    /* fallback GET — надёжнее с Apps Script */
  }
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set("action", "save");
  url.searchParams.set("camera", payload.camera);
  url.searchParams.set("row", String(payload.row));
  url.searchParams.set("meters", String(payload.meters));
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error("Сеть");
  return res.json();
}

async function loadCatalog() {
  const res = await fetch("cameras.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("Нет cameras.json");
  catalog = await res.json();
  $("project-title").textContent = CONFIG.PROJECT_NAME || catalog.project || "Метраж";
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
  if (!apiConfigured() || !isOnline()) return;
  let q = getQueue();
  if (!q.length) return;
  const remain = [];
  for (const item of q) {
    try {
      const r = await apiSave(item);
      if (r.ok) {
        metrazhMap[item.camera] = item.meters;
      } else {
        remain.push(item);
      }
    } catch {
      remain.push(item);
    }
  }
  setQueue(remain);
  cacheMetrazh(metrazhMap);
  updateStats();
  renderList($("search").value);
}

function updateStats() {
  const total = catalog.cameras.length;
  const done = catalog.cameras.filter((c) => metrazhMap[c.camera]).length;
  const q = getQueue().length;
  $("stat-total").textContent = `Всего: ${total}`;
  $("stat-done").textContent = `Готово: ${done}`;
  if (!apiConfigured()) {
    $("stat-net").textContent = "Демо (без таблицы)";
    $("stat-net").className = "pill warn";
  } else if (!isOnline()) {
    $("stat-net").textContent = "Офлайн";
    $("stat-net").className = "pill warn";
  } else if (q > 0) {
    $("stat-net").textContent = `В очереди: ${q}`;
    $("stat-net").className = "pill warn";
  } else {
    $("stat-net").textContent = "Онлайн";
    $("stat-net").className = "pill ok";
  }
}

function normalizeSearch(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function renderList(filter = "") {
  const root = $("camera-root");
  root.innerHTML = "";
  const q = normalizeSearch(filter);
  const items = catalog.cameras.filter(
    (c) => !q || c.search.includes(q) || c.camera.toLowerCase().includes(q)
  );

  if (!items.length) {
    root.innerHTML = '<p class="empty-msg">Ничего не найдено</p>';
    return;
  }

  let lastSection = "";
  for (const cam of items) {
    if (cam.section !== lastSection) {
      lastSection = cam.section;
      const h = document.createElement("h2");
      h.className = "section-title";
      h.textContent = cam.section || "Камеры";
      root.appendChild(h);
    }

    const m = metrazhMap[cam.camera];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "camera-btn";
    btn.innerHTML = `
      <div>
        <div class="code">${escapeHtml(cam.camera)}</div>
        <div class="meta">${escapeHtml(cam.floor)} · ${escapeHtml(cam.place)}</div>
      </div>
      <div class="badge ${m ? "done" : ""}">${m ? escapeHtml(String(m)) : "—"}</div>
    `;
    btn.addEventListener("click", () => openInput(cam));
    root.appendChild(btn);
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function openInput(cam) {
  selectedCamera = cam;
  const existing = metrazhMap[cam.camera];
  inputValue = existing ? String(existing).replace(/[^\d]/g, "") : "";
  $("input-code").textContent = cam.camera;
  $("input-info").textContent = [cam.floor, cam.place, cam.cable].filter(Boolean).join(" · ");
  const hint = $("overwrite-hint");
  if (existing) {
    hint.textContent = `Уже записано: ${existing} м. Новое число заменит старое.`;
    hint.classList.add("show");
  } else {
    hint.classList.remove("show");
  }
  updateMetersDisplay();
  $("screen-list").classList.add("hidden");
  $("screen-input").classList.add("active");
}

function closeInput() {
  $("screen-input").classList.remove("active");
  $("screen-list").classList.remove("hidden");
  selectedCamera = null;
  renderList($("search").value);
  updateStats();
}

function updateMetersDisplay() {
  const el = $("meters-display");
  const btn = $("btn-save");
  if (!inputValue) {
    el.textContent = "—";
    el.classList.add("empty");
    btn.disabled = true;
  } else {
    el.textContent = inputValue;
    el.classList.remove("empty");
    const n = parseInt(inputValue, 10);
    btn.disabled = !(n >= (CONFIG.MIN_METERS || 1) && n <= (CONFIG.MAX_METERS || 500));
  }
}

function appendDigit(d) {
  if (inputValue.length >= 3) return;
  if (inputValue === "0") inputValue = d;
  else inputValue += d;
  updateMetersDisplay();
}

function numpadHandler(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  const digit = btn.dataset.digit;
  const action = btn.dataset.action;
  if (digit !== undefined) appendDigit(digit);
  else if (action === "back") inputValue = inputValue.slice(0, -1);
  else if (action === "clear") inputValue = "";
  updateMetersDisplay();
}

async function saveMeters() {
  if (!selectedCamera || !inputValue) return;
  const meters = parseInt(inputValue, 10);
  if (meters < (CONFIG.MIN_METERS || 1) || meters > (CONFIG.MAX_METERS || 500)) {
    toast(`Введите от ${CONFIG.MIN_METERS || 1} до ${CONFIG.MAX_METERS || 500}`, "error");
    return;
  }

  const payload = {
    camera: selectedCamera.camera,
    row: selectedCamera.row,
    meters,
    at: new Date().toISOString(),
  };

  if (!apiConfigured()) {
    metrazhMap[payload.camera] = meters;
    cacheMetrazh(metrazhMap);
    toast(`Демо: ${payload.camera} = ${meters} м`, "queue");
    closeInput();
    return;
  }

  $("btn-save").disabled = true;

  if (!isOnline()) {
    const q = getQueue();
    q.push(payload);
    setQueue(q);
    metrazhMap[payload.camera] = meters;
    cacheMetrazh(metrazhMap);
    toast("Нет сети — сохранено, отправится позже", "queue");
    closeInput();
    return;
  }

  try {
    const r = await apiSave(payload);
    if (r.ok) {
      metrazhMap[payload.camera] = meters;
      cacheMetrazh(metrazhMap);
      toast(`✓ ${payload.camera}: ${meters} м`, "success");
      closeInput();
    } else {
      toast(r.error || "Ошибка сохранения", "error");
    }
  } catch {
    const q = getQueue();
    q.push(payload);
    setQueue(q);
    metrazhMap[payload.camera] = meters;
    cacheMetrazh(metrazhMap);
    toast("Сеть — в очереди, повторим автоматически", "queue");
    closeInput();
  } finally {
    $("btn-save").disabled = false;
  }
}

async function init() {
  if (!apiConfigured()) {
    $("setup-banner").classList.add("show");
  }

  $("search").addEventListener("input", (e) => renderList(e.target.value));
  $("btn-back").addEventListener("click", closeInput);
  $("numpad").addEventListener("click", numpadHandler);
  $("btn-save").addEventListener("click", saveMeters);

  window.addEventListener("online", () => {
    flushQueue();
    refreshMetrazh().then(() => {
      updateStats();
      renderList($("search").value);
    });
  });

  try {
    await loadCatalog();
    metrazhMap = loadCachedMetrazh();
    await refreshMetrazh();
    await flushQueue();
    renderList();
    updateStats();
  } catch (e) {
    $("camera-root").innerHTML =
      '<p class="empty-msg">Не удалось загрузить список камер</p>';
    console.error(e);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  setInterval(flushQueue, 30000);
  setInterval(refreshMetrazh, 60000);
}

init();
