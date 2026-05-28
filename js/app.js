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
const MAX_SESSION_PHOTOS = 3;
/** @type {{ previewUrl: string, driveUrl?: string, fileId?: string }[]} */
let sessionPhotos = [];

const $ = (id) => document.getElementById(id);

/** Совпадает с normalizeCameraCode_ в Apps Script (BK в таблице / ВК в приложении). */
function normalizeCameraCode(code) {
  const s = String(code || "").trim();
  const m = s.match(/^([\u0412\u0432Bb])([\u041a\u043aKk])(.*)$/);
  if (m) return `BK${m[3]}`;
  return s;
}

function metrazhKey(systemId, camera) {
  return `${systemId}:${normalizeCameraCode(camera)}`;
}

function driveAuthUrl() {
  if (!apiConfigured()) return "";
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set("action", "authDrive");
  return url.toString();
}

function apiErrorMessage(err) {
  const m = err && err.message ? String(err.message) : "";
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return "Нет связи с таблицей. Проверьте интернет и обновите страницу";
  }
  if (/DriveApp|auth\/drive|разрешени/i.test(m)) {
    return "Фото: таблица → меню «Метраж» → Разрешить фото на Диске";
  }
  return m || "Нет связи с таблицей";
}

function photoApiErrorMessage(r) {
  const err = (r && r.error) || "";
  if ((r && r.needDriveAuth) || /DriveApp|auth\/drive|разрешени/i.test(err)) {
    return "Фото: в таблице Метраж → Разрешить фото (или Apps Script → authorizeDrive_)";
  }
  if (err.length > 120) return "Фото: разрешите Диск в таблице (меню Метраж)";
  return err || "Ошибка загрузки";
}

async function parseApiResponse(res) {
  const text = await res.text();
  if (/DriveApp|auth\/drive|разрешения на вызов/i.test(text)) {
    return { ok: false, needDriveAuth: true, error: "Нужен доступ к Google Диску" };
  }
  if (!text || text.trimStart().startsWith("<")) {
    const ex = text.match(/Exception:\s*([^<(]+)/);
    if (ex) throw new Error(ex[1].trim().slice(0, 120));
    throw new Error("Ошибка сервера таблицы");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Неверный ответ сервера");
  }
}

function toast(text, type = "success") {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast show ${type}`;
  clearTimeout(toast._t);
  const ms = type === "error" && text.length > 40 ? 6000 : 2800;
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
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
  return parseApiResponse(res);
}

async function apiSave(payload) {
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return parseApiResponse(res);
  } catch {
    /* GET fallback */
  }
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set("action", "save");
  url.searchParams.set("system", payload.system);
  url.searchParams.set("camera", normalizeCameraCode(payload.camera));
  url.searchParams.set("row", String(payload.row));
  url.searchParams.set("meters", String(payload.meters));
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error("Сеть");
  return parseApiResponse(res);
}

const PHOTO_CHUNK_SIZE = 500;

async function apiUploadPhoto(payload) {
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "photo", ...payload }),
    });
    if (res.ok) {
      const j = await parseApiResponse(res);
      if (j && (j.ok || j.error)) return j;
    }
  } catch {
    /* GET по частям — как метраж */
  }

  const { data, system, systemCode, sectionFolder, projectName, camera, row, mimeType } =
    payload;
  const uploadId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const total = Math.max(1, Math.ceil(data.length / PHOTO_CHUNK_SIZE));
  let last = null;

  for (let part = 0; part < total; part++) {
    const chunk = data.slice(part * PHOTO_CHUNK_SIZE, (part + 1) * PHOTO_CHUNK_SIZE);
    const params = {
      uploadId,
      part: String(part),
      total: String(total),
      chunk,
    };
    if (part === 0) {
      params.system = system;
      params.systemCode = systemCode;
      params.sectionFolder = sectionFolder;
      params.projectName = projectName;
      params.camera = camera;
      params.row = String(row);
      params.mimeType = mimeType;
    }
    last = await apiGet("photoChunk", params);
    if (!last.ok && !last.pending) throw new Error(last.error || "Загрузка");
    if (typeof apiUploadPhoto.onProgress === "function") {
      apiUploadPhoto.onProgress(part + 1, total);
    }
  }
  return last;
}

async function apiDeletePhoto(fileId) {
  return apiGet("deletePhoto", { fileId });
}

function photosEnabled() {
  return CONFIG.PHOTOS_ENABLED !== false && apiConfigured();
}

function updatePhotoBlockVisibility() {
  const block = $("photo-block");
  if (!block) return;
  block.hidden = !photosEnabled();
}

async function compressImageFile(file, maxSide = 1024, quality = 0.75) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Сжатие"))), "image/jpeg", quality);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      resolve(s.includes(",") ? s.split(",")[1] : s);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function clearSessionPhotos() {
  for (const p of sessionPhotos) {
    if (p.previewUrl && !p.fromDrive) URL.revokeObjectURL(p.previewUrl);
  }
  sessionPhotos = [];
}

async function loadSessionPhotosFromDrive() {
  if (!photosEnabled() || !selectedCamera) return;
  const status = $("photo-status");
  if (status) status.textContent = "Загрузка фото с Диска…";

  const { system, section, cam } = selectedCamera;
  try {
    const r = await apiGet("listPhotos", {
      system: system.id,
      systemCode: system.code,
      sectionFolder: sectionFolderName(section),
      projectName: projectFolderName(),
      camera: normalizeCameraCode(cam.camera),
    });
    if (!r.ok) {
      if (status) {
        status.textContent = r.needDriveAuth
          ? "Нужно разрешить Диск в таблице (меню Метраж)"
          : "Не удалось загрузить список фото";
      }
      return;
    }
    if (!Array.isArray(r.photos) || !r.photos.length) {
      renderPhotoSession();
      return;
    }
    clearSessionPhotos();
    for (const p of r.photos) {
      sessionPhotos.push({
        previewUrl: p.thumbUrlAlt || p.thumbUrl || p.url,
        driveUrl: p.url,
        fileId: p.fileId,
        fromDrive: true,
      });
    }
    renderPhotoSession();
  } catch {
    if (status) status.textContent = "Нет связи — фото на Диске, обновите позже";
    renderPhotoSession();
  }
}

function renderPhotoSession() {
  const status = $("photo-status");
  const preview = $("photo-preview");
  if (!status || !preview) return;

  const n = sessionPhotos.length;
  const atMax = n >= MAX_SESSION_PHOTOS;
  setPhotoButtonsDisabled(atMax);

  if (!n) {
    status.textContent = "Можно снять 1–3 фото · крестик на превью — удалить";
    preview.hidden = true;
    preview.innerHTML = "";
    return;
  }

  const last = sessionPhotos[n - 1];
  status.innerHTML = atMax
    ? `На Диске: <strong>${n}</strong> фото. Не то? <strong>×</strong> на превью — удалить.`
    : `На Диске: <strong>${n}</strong> фото. Размазано — снимите ещё или <strong>×</strong> удалить.`;

  preview.hidden = false;
  preview.innerHTML = sessionPhotos
    .map(
      (p, i) => `
      <div class="photo-thumb-wrap">
        <a class="photo-thumb" href="${escapeHtml(p.driveUrl || "#")}" target="_blank" rel="noopener" title="Фото ${i + 1} на Диске">
          <img src="${p.previewUrl}" alt="фото ${i + 1}" loading="lazy" referrerpolicy="no-referrer" />
        </a>
        <button type="button" class="photo-delete" data-photo-idx="${i}" aria-label="Удалить фото ${i + 1}">×</button>
      </div>`
    )
    .join("");

  if (last.driveUrl) {
    const link = document.createElement("a");
    link.className = "photo-open-last";
    link.href = last.driveUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "На Диске ↗";
    preview.appendChild(link);
  }
}

async function deleteSessionPhoto(index) {
  const p = sessionPhotos[index];
  if (!p) return;

  const status = $("photo-status");
  if (status) status.textContent = "Удаление с Диска…";
  setPhotoButtonsDisabled(true);

  try {
    if (p.fileId) {
      if (!navigator.onLine) {
        toast("Нужен интернет, чтобы удалить с Диска", "error");
        renderPhotoSession();
        return;
      }
      const r = await apiDeletePhoto(p.fileId);
      if (!r.ok) {
        toast(photoApiErrorMessage(r) || "Не удалось удалить", "error");
        renderPhotoSession();
        return;
      }
    }

    if (p.previewUrl && !p.fromDrive) URL.revokeObjectURL(p.previewUrl);
    sessionPhotos.splice(index, 1);
    renderPhotoSession();
    toast(
      p.fileId ? "Фото удалено с Диска" : "Убрано из списка · на Диске удалите вручную",
      "success"
    );
  } catch (err) {
    toast(apiErrorMessage(err) || "Не удалось удалить", "error");
    renderPhotoSession();
  } finally {
    setPhotoButtonsDisabled(false);
  }
}

function setPhotoButtonsDisabled(disabled) {
  $("btn-photo-camera").disabled = disabled;
  $("btn-photo-gallery").disabled = disabled;
}

async function uploadPhotoFromFile(file) {
  if (!selectedCamera) return;
  if (!photosEnabled()) {
    toast("Фотоотчёты после подключения таблицы", "queue");
    return;
  }
  if (sessionPhotos.length >= MAX_SESSION_PHOTOS) {
    toast(`Максимум ${MAX_SESSION_PHOTOS} фото — удалите лишнее (×)`, "error");
    return;
  }
  if (!navigator.onLine) {
    toast("Нужен интернет для фото", "error");
    return;
  }

  const status = $("photo-status");
  setPhotoButtonsDisabled(true);
  status.textContent = "Отправка фото…";
  apiUploadPhoto.onProgress = (n, total) => {
    status.textContent =
      total > 1 ? `Отправка фото… ${n}/${total}` : "Отправка фото…";
  };

  try {
    const blob = await compressImageFile(file);
    const data = await blobToBase64(blob);
    const { system, section, cam } = selectedCamera;
    const r = await apiUploadPhoto({
      system: system.id,
      systemCode: system.code,
      projectName: projectFolderName(),
      sectionFolder: sectionFolderName(section),
      camera: normalizeCameraCode(cam.camera),
      row: cam.row,
      data,
      mimeType: "image/jpeg",
    });
    if (r.ok) {
      const previewUrl = URL.createObjectURL(blob);
      sessionPhotos.push({ previewUrl, driveUrl: r.url, fileId: r.fileId, fromDrive: false });
      renderPhotoSession();
      toast(`Фото ${sessionPhotos.length} сохранено · ${formatCameraCode(cam.camera)}`, "success");
    } else {
      toast(photoApiErrorMessage(r), "error");
      renderPhotoSession();
    }
  } catch (err) {
    const msg = apiErrorMessage(err);
    toast(msg && msg !== "Сеть" ? msg : "Не удалось отправить фото", "error");
    renderPhotoSession();
  } finally {
    apiUploadPhoto.onProgress = null;
    setPhotoButtonsDisabled(false);
    $("photo-input-camera").value = "";
    $("photo-input-gallery").value = "";
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** На экране всегда кириллица ВК; в таблице и API — BK */
function formatCameraCode(code) {
  const n = normalizeCameraCode(code);
  return n.replace(/^BK(?=\d)/i, "ВК ");
}

function systemDisplayTitle(sys) {
  if (!sys?.title) return sys?.code || "Система";
  return String(sys.title).replace(/^СОТ\s*—\s*/i, "").trim() || sys.title;
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

/** Имя папки на Диске: «01 — Секция 1» как в приложении */
function sectionFolderName(section) {
  if (!section) return "Без секции";
  const info = parseSectionName(section.name);
  if (info.num) return `${String(info.num).padStart(2, "0")} — ${info.short}`;
  return String(section.name || "Без секции").slice(0, 80);
}

/** Имя папки проекта на Диске (на сервере приоритет у имени таблицы). */
function projectFolderName() {
  if (CONFIG.PROJECT_FOLDER_NAME) return String(CONFIG.PROJECT_FOLDER_NAME);
  return catalog.site?.name || CONFIG.PROJECT_NAME || "";
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

function appName() {
  return CONFIG.APP_NAME || "Den - Монтажник";
}

function updateHeader(screenName) {
  const site = catalog.site?.name || CONFIG.PROJECT_NAME || "Объект";
  const titles = {
    systems: appName(),
    sections: systemDisplayTitle(nav.system),
    cameras: nav.section?.name || "Секция",
    input: "Метраж",
  };
  $("screen-title").textContent = titles[screenName] || appName();
  document.title =
    screenName === "systems" ? appName() : `${titles[screenName] || appName()} · ${appName()}`;

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

/** Название объекта в шапке и на Диске = имя Google-таблицы. */
async function syncProjectNameFromApi() {
  if (!apiConfigured()) return;
  try {
    const r = await apiGet("ping");
    const name = r.ok && r.sheet ? String(r.sheet).trim() : "";
    if (!name) return;
    if (!catalog.site) catalog.site = { id: "default", name: "" };
    catalog.site.name = name;
  } catch {
    /* офлайн — остаётся catalog.json / config */
  }
}

async function refreshAppData(showToast = false) {
  await syncProjectNameFromApi();
  await refreshMetrazh();
  await flushQueue(false);
  refreshCurrentView();
  updateStats();
  const active = document.querySelector(".screen.active")?.id;
  if (active === "screen-input" && selectedCamera) {
    await loadSessionPhotosFromDrive();
  }
  if (showToast) toast("Данные обновлены", "success");
}

function getActiveScrollEl() {
  const screen = document.querySelector(".screen.active");
  if (!screen) return null;
  return screen.querySelector(".tile-grid, .camera-list") || screen;
}

function initPullToRefresh() {
  const indicator = $("pull-refresh");
  if (!indicator) return;

  const THRESH = 56;
  let startY = 0;
  let pulling = false;
  let refreshing = false;

  const resetPull = () => {
    indicator.classList.remove("pull-refresh--visible", "pull-refresh--ready", "pull-refresh--loading");
    indicator.style.setProperty("--pull", "0px");
    indicator.setAttribute("aria-hidden", "true");
  };

  const onStart = (e) => {
    if (refreshing || e.touches.length !== 1) return;
    const scrollEl = getActiveScrollEl();
    if (!scrollEl || scrollEl.scrollTop > 4) return;
    startY = e.touches[0].clientY;
    pulling = true;
  };

  const onMove = (e) => {
    if (!pulling || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) {
      resetPull();
      return;
    }
    if (dy > 8) e.preventDefault();
    const h = Math.min(dy * 0.45, 72);
    indicator.style.setProperty("--pull", `${h}px`);
    indicator.classList.add("pull-refresh--visible");
    indicator.classList.toggle("pull-refresh--ready", dy >= THRESH);
    indicator.setAttribute("aria-hidden", "false");
    const label = indicator.querySelector(".pull-refresh__label");
    if (label) label.textContent = dy >= THRESH ? "Отпустите" : "Потяните вниз";
  };

  const onEnd = async () => {
    if (!pulling) return;
    pulling = false;
    const pull = parseFloat(indicator.style.getPropertyValue("--pull") || "0");
    const ready = indicator.classList.contains("pull-refresh--ready");
    if (!ready || pull < 20) {
      resetPull();
      return;
    }

    refreshing = true;
    indicator.classList.add("pull-refresh--loading");
    const label = indicator.querySelector(".pull-refresh__label");
    if (label) label.textContent = "Обновление…";
    try {
      await refreshAppData(true);
    } catch {
      toast("Не удалось обновить", "error");
    } finally {
      refreshing = false;
      resetPull();
    }
  };

  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchmove", onMove, { passive: false });
  document.addEventListener("touchend", onEnd);
  document.addEventListener("touchcancel", onEnd);
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

async function flushQueue(showResult) {
  if (!apiConfigured() || !navigator.onLine) return false;
  const pending = getQueue();
  if (!pending.length) return true;
  const remain = [];
  let lastErr = "";
  for (const item of pending) {
    try {
      const r = await apiSave(item);
      if (r.ok) {
        const k = metrazhKey(item.system, item.camera);
        if (item.meters === 0) delete metrazhMap[k];
        else metrazhMap[k] = item.meters;
      } else {
        remain.push(item);
        lastErr = r.error || "Ошибка сохранения";
      }
    } catch (e) {
      remain.push(item);
      lastErr = apiErrorMessage(e);
    }
  }
  setQueue(remain);
  cacheMetrazh(metrazhMap);
  refreshCurrentView();
  updateStats();
  if (showResult) {
    if (!remain.length) toast("Очередь отправлена в таблицу", "success");
    else toast(lastErr || "Не удалось отправить очередь", "error");
  }
  return remain.length === 0;
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
    net.textContent = `Очередь ${q} · нажмите`;
    net.className = "pill warn pill--queue";
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
          <span class="pick-label">${escapeHtml(systemDisplayTitle(sys))}</span>
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

  clearSessionPhotos();
  renderPhotoSession();
  updatePhotoBlockVisibility();
  updateMetersDisplay();
  showScreen("input");
  loadSessionPhotosFromDrive();
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
    if (r.ok) {
      afterLocal();
      await refreshMetrazh();
    } else toast(r.error || "Ошибка", "error");
  } catch (e) {
    setQueue([...getQueue(), payload]);
    afterLocal();
    toast(apiErrorMessage(e) || "В очередь — отправится позже", "queue");
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
  $("stat-net").addEventListener("click", () => {
    if (getQueue().length > 0) flushQueue(true);
    else refreshAppData(true);
  });
  initPullToRefresh();
  $("numpad").addEventListener("click", numpadHandler);
  $("btn-save").addEventListener("click", saveMeters);
  const onPhotoPick = (e) => {
    const file = e.target.files?.[0];
    if (file) uploadPhotoFromFile(file);
    e.target.value = "";
  };
  $("btn-photo-camera")?.addEventListener("click", () => $("photo-input-camera")?.click());
  $("btn-photo-gallery")?.addEventListener("click", () => $("photo-input-gallery")?.click());
  $("photo-input-camera")?.addEventListener("change", onPhotoPick);
  $("photo-input-gallery")?.addEventListener("change", onPhotoPick);
  $("photo-preview")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-photo-idx]");
    if (!btn || !btn.classList.contains("photo-delete")) return;
    e.preventDefault();
    deleteSessionPhoto(parseInt(btn.getAttribute("data-photo-idx"), 10));
  });
  updatePhotoBlockVisibility();

  window.addEventListener("online", () => {
    flushQueue();
    refreshAppData(false).then(() => {
      const active = document.querySelector(".screen.active")?.id?.replace("screen-", "");
      if (active) updateHeader(active);
    });
  });

  try {
    await loadCatalog();
    await syncProjectNameFromApi();
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
