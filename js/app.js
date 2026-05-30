const CONFIG = window.APP_CONFIG || {};

function appVersionLabel() {
  const v = String(CONFIG.APP_VERSION || "").trim();
  return v || "";
}

function appWindowTitle() {
  const v = appVersionLabel();
  return v ? `Монтажник · ${v}` : "Монтажник";
}

function applyAppVersionTitle() {
  document.title = appWindowTitle();
}
const QUEUE_KEY = "montazh_pending_queue";
const METRAZH_CACHE_KEY = "montazh_metrazh_cache";
/** Резерв метража на телефоне — если сервер вернул пусто/обрезано, не теряем СОТ/БР. */
const METRAZH_SNAPSHOT_KEY = "montazh_metrazh_snapshot";
const NAV_STATE_KEY = "montazh_nav_state";
const PHOTO_STATUS_KEY = "montazh_photo_status";
const PHOTO_COUNT_KEY = "montazh_photo_count";
const THEME_KEY = "montazh_theme";
const THEME_COLORS = { dark: "#0f172a", light: "#e3e4ea" };

let catalog = { site: { id: "", name: "" }, systems: [] };

/** Порядок и заглушки — системы никогда не пропадают с экрана, даже при устаревшем catalog.json. */
const CANONICAL_SYSTEM_ORDER = ["cot", "br", "rf", "spd", "df", "sin-br"];
const CANONICAL_SYSTEM_STUBS = [
  {
    id: "cot",
    code: "СОТ",
    title: "СОТ — Система охранного телевидения",
    ready: false,
    note: "Нет данных каталога",
    sections: [],
    cameraCount: 0,
  },
  {
    id: "br",
    code: "БР",
    title: "Безопасный регион",
    ready: false,
    note: "Нет данных каталога",
    sections: [],
    cameraCount: 0,
  },
  {
    id: "rf",
    code: "РФ",
    title: "РФ — распределительный щит",
    ready: false,
    note: "Таблица ещё не подключена",
    sections: [],
    cameraCount: 0,
  },
  {
    id: "spd",
    code: "СПД",
    title: "СПД",
    ready: false,
    note: "Таблица ещё не подключена",
    sections: [],
    cameraCount: 0,
  },
  {
    id: "df",
    code: "ДФ",
    title: "ДФ — дымоудаление",
    ready: false,
    note: "Таблица ещё не подключена",
    sections: [],
    cameraCount: 0,
  },
  {
    id: "sin-br",
    code: "СИН",
    title: "СИН-1.1-Р-БР2.1",
    ready: false,
    note: "вынесено в систему БР",
    sections: [],
    cameraCount: 0,
  },
];

function mergeCatalogSystems(systems) {
  const byId = new Map();
  for (const s of systems || []) {
    if (s?.id) byId.set(s.id, s);
  }
  for (const stub of CANONICAL_SYSTEM_STUBS) {
    if (!byId.has(stub.id)) byId.set(stub.id, { ...stub });
  }
  return CANONICAL_SYSTEM_ORDER.map((id) => byId.get(id)).filter(Boolean);
}
/** @type {Record<string, number|string>} */
let metrazhMap = {};

/** Последний успешно загруженный каталог — не сбрасываем навигацию при сбое сети. */
let catalogBackup = null;

const nav = {
  system: null,
  section: null,
};

/** История экранов для «назад / вперёд» (свайпы и кнопка ←). */
const navHistory = { stack: [{ screen: "systems", systemId: null, sectionId: null, sheet: null }], index: 0 };
let suppressHistoryPush = false;


let selectedCamera = null;
let camSheetOpen = false;
/** @type {Record<string, "done"|"skip">} */
let photoStatusMap = {};
/** @type {Record<string, number>} */
let photoCountMap = {};
let sectionPhotoProbeToken = 0;
/** @type {{ cable: string, gofra: string }} */
let inputValues = { cable: "", gofra: "" };
/** @type {{ cable: number|null, gofra: number|null }} */
let inputInitial = { cable: null, gofra: null };
const MAX_SESSION_PHOTOS = 5;
let photoLightboxIndex = 0;
let photoSheetIndex = 0;
let photoLbZoom = 1;
const PHOTO_LB_ZOOM = 2.5;
let photoLbTapTimer = null;
let photoLbLastTap = 0;
/** @type {{ previewUrl: string, driveUrl?: string, fileId?: string }[]} */
let sessionPhotos = [];
let photoSessionLoading = false;

const $ = (id) => document.getElementById(id);

function pushActor() {
  return window.MontazhPush?.getInstallerName?.() || "Монтажник";
}

/** Совпадает с normalizeCameraCode_ в Apps Script (BK в таблице / ВК в приложении). */
function normalizeCameraCode(code) {
  const s = String(code || "").trim();
  // БР: "ВК ММС № 5" / "ВК ПВН № 23" / "ВК16" → BK5 / BK23 / BK16
  const mBr = s.match(/^[\u0412\u0432Bb][\u041a\u043aKk]\s*(?:[^\d№]*?)№?\s*(\d+)\s*$/i);
  if (mBr) return `BK${mBr[1]}`;
  const m = s.match(/^([\u0412\u0432Bb])([\u041a\u043aKk])(.*)$/i);
  if (m) return `BK${String(m[3]).replace(/\s+/g, "")}`;
  return s.replace(/\s+/g, "");
}

/** Ключи metrazhMap — всегда с нормализованным кодом (без пробелов). */
function normalizeMetrazhKey(key) {
  const gofra = key.endsWith(":gofra");
  const base = gofra ? key.slice(0, -6) : key;
  const idx = base.indexOf(":");
  if (idx < 0) return key;
  const sys = base.slice(0, idx);
  const cam = base.slice(idx + 1);
  return `${sys}:${normalizeCameraCode(cam)}${gofra ? ":gofra" : ""}`;
}

function normalizeMetrazhMap(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    out[normalizeMetrazhKey(k)] = v;
  }
  return out;
}

/** Единый вид: «ВК 2.11.1», «ВК ММС № 5» — как в таблице после правок. */
function formatCameraLabelDisplay(text) {
  let s = String(text || "").trim();
  if (!s) return s;
  const m = s.match(/^([\u0412\u0432Bb])([\u041a\u043aKk])\s*(.+)$/i);
  if (!m) return s;
  const tail = m[3].trim();
  const compact = tail.replace(/\s+/g, "");
  if (/^[\d.]/.test(compact)) return `ВК ${compact}`;
  return `ВК ${tail.replace(/№\s*/g, "№ ")}`;
}

function metrazhKey(systemId, camera) {
  return `${systemId}:${normalizeCameraCode(camera)}`;
}

function gofraKey(systemId, camera) {
  return `${metrazhKey(systemId, camera)}:gofra`;
}

function mapKeyForKind(systemId, camera, kind) {
  return kind === "gofra" ? gofraKey(systemId, camera) : metrazhKey(systemId, camera);
}

function kindLabel(kind) {
  return kind === "gofra" ? "гофру" : "кабель";
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

function rdApiErrorMessage(err, r) {
  if (r && r.needDriveAuth) {
    return "Нужен Диск: в таблице Метраж → Разрешить фото на Диске";
  }
  if (r && r.error) {
    return String(r.error).replace(/^Exception:\s*/i, "").trim();
  }
  const m = err && err.message ? String(err.message) : "";
  if (/failed to fetch|networkerror|load failed|сеть/i.test(m)) {
    return "Не удалось загрузить PDF. Проверьте интернет и повторите";
  }
  return m || "Не удалось загрузить PDF";
}

function isRdSessionExpiredError(msg) {
  return /сессия загрузки истекла/i.test(String(msg || ""));
}

/** URL превью через Apps Script (запасной вариант). */
function photoThumbSrc(fileId) {
  if (!fileId || !apiConfigured()) return "";
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set("action", "photoThumb");
  url.searchParams.set("fileId", fileId);
  return url.toString();
}

function photoPreviewFromItem(p) {
  if (p.thumbDataUrl) return p.thumbDataUrl;
  if (p.previewUrl) return p.previewUrl;
  if (p.fileId) return photoThumbSrc(p.fileId);
  return "";
}

/** Полноразмерное превью для просмотра (blob/data приоритетнее миниатюры). */
function photoFullFromItem(p) {
  if (p.previewUrl && (p.previewUrl.startsWith("blob:") || p.previewUrl.startsWith("data:"))) {
    return p.previewUrl;
  }
  if (p.driveUrl) return p.driveUrl;
  if (p.fileId) return `https://drive.google.com/uc?export=view&id=${encodeURIComponent(p.fileId)}`;
  return photoPreviewFromItem(p);
}

function bindPhotoImg(img, p) {
  img.alt = "фото";
  img.loading = "lazy";
  img.decoding = "async";
  img.draggable = false;
  const src = photoPreviewFromItem(p);
  if (src) img.src = src;
  img.onerror = async () => {
    if (img.dataset.retry === "1") return;
    img.dataset.retry = "1";
    if (p.thumbDataUrl && img.src !== p.thumbDataUrl) {
      img.src = p.thumbDataUrl;
      return;
    }
    const blobUrl = await fetchPhotoPreviewBlob(p.fileId);
    if (blobUrl) {
      p.previewUrl = blobUrl;
      img.src = blobUrl;
    }
  };
}

/** Загрузить превью через fetch → blob: (если data URL нет). */
async function fetchPhotoPreviewBlob(fileId) {
  if (!fileId || !apiConfigured()) return "";
  try {
    const res = await fetch(photoThumbSrc(fileId), { redirect: "follow" });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) return "";
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return "";
  }
}

async function hydrateSessionPhotoPreviews() {
  let changed = false;
  const needFetch = [];
  for (const p of sessionPhotos) {
    if (p.previewUrl?.startsWith("blob:") || p.previewUrl?.startsWith("data:")) continue;
    if (p.thumbDataUrl) {
      p.previewUrl = p.thumbDataUrl;
      changed = true;
      continue;
    }
    if (p._hydrating || !p.fileId) continue;
    needFetch.push(p);
  }
  await Promise.all(
    needFetch.map(async (p) => {
      p._hydrating = true;
      const blobUrl = await fetchPhotoPreviewBlob(p.fileId);
      p._hydrating = false;
      if (blobUrl) {
        p.previewUrl = blobUrl;
        changed = true;
      }
    })
  );
  if (changed) renderPhotoSession();
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

function countSystemMetrazhKeys(map, systemId) {
  const prefix = `${systemId}:`;
  let n = 0;
  for (const k of Object.keys(map || {})) {
    if (k.startsWith(prefix) && !k.endsWith(":gofra")) n++;
  }
  return n;
}

/** Сервер дополняет локальный кэш; пустой ответ API не затирает уже введённый метраж. */
function mergeMetrazhMaps(local, remote) {
  const merged = { ...(local || {}) };
  for (const [k, v] of Object.entries(remote || {})) {
    if (v === "" || v === null || v === undefined) continue;
    merged[k] = v;
  }
  return merged;
}

function loadMetrazhSnapshot() {
  try {
    const raw = localStorage.getItem(METRAZH_SNAPSHOT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && typeof o.map === "object" ? o : null;
  } catch {
    return null;
  }
}

function updateMetrazhSnapshot(map) {
  const cot = countSystemMetrazhKeys(map, "cot");
  const br = countSystemMetrazhKeys(map, "br");
  if (cot + br === 0) return;
  try {
    localStorage.setItem(
      METRAZH_SNAPSHOT_KEY,
      JSON.stringify({ at: new Date().toISOString(), cot, br, map })
    );
  } catch {
    /* localStorage quota */
  }
}

/** Если после ответа API резко пропал метраж СОТ — подмешиваем снимок с телефона. */
function recoverMetrazhIfRegressed(before, merged) {
  const snap = loadMetrazhSnapshot();
  if (!snap?.map) return merged;
  for (const sysId of ["cot", "br"]) {
    const was = countSystemMetrazhKeys(before, sysId);
    const now = countSystemMetrazhKeys(merged, sysId);
    const snapN = countSystemMetrazhKeys(snap.map, sysId);
    if (was >= 3 && now < was * 0.5 && snapN > now) {
      return mergeMetrazhMaps(merged, snap.map);
    }
  }
  return merged;
}

function cacheMetrazh(map) {
  localStorage.setItem(METRAZH_CACHE_KEY, JSON.stringify(map));
  updateMetrazhSnapshot(map);
}

function loadCachedMetrazh() {
  try {
    return normalizeMetrazhMap(JSON.parse(localStorage.getItem(METRAZH_CACHE_KEY) || "{}"));
  } catch {
    return {};
  }
}

function loadPhotoStatusMap() {
  try {
    photoStatusMap = JSON.parse(localStorage.getItem(PHOTO_STATUS_KEY) || "{}");
  } catch {
    photoStatusMap = {};
  }
  try {
    photoCountMap = JSON.parse(localStorage.getItem(PHOTO_COUNT_KEY) || "{}");
  } catch {
    photoCountMap = {};
  }
}

function savePhotoStatusMap() {
  try {
    localStorage.setItem(PHOTO_STATUS_KEY, JSON.stringify(photoStatusMap));
    localStorage.setItem(PHOTO_COUNT_KEY, JSON.stringify(photoCountMap));
  } catch {
    /* quota */
  }
}

function photoStatusStorageKey(systemId, camera) {
  return `${systemId}:${normalizeCameraCode(camera)}`;
}

function getPhotoStatus(systemId, camera) {
  return photoStatusMap[photoStatusStorageKey(systemId, camera)] || null;
}

function getPhotoCount(systemId, camera) {
  const n = photoCountMap[photoStatusStorageKey(systemId, camera)];
  return typeof n === "number" && n > 0 ? n : 0;
}

function setPhotoStatus(systemId, camera, status, count) {
  const key = photoStatusStorageKey(systemId, camera);
  if (status === "done") {
    photoStatusMap[key] = "done";
    if (typeof count === "number") photoCountMap[key] = count;
  } else if (status === "skip") {
    photoStatusMap[key] = "skip";
    delete photoCountMap[key];
  } else {
    delete photoStatusMap[key];
    delete photoCountMap[key];
  }
  savePhotoStatusMap();
}

function getPhotoReportDisplay(sys, cam) {
  const count = getPhotoCount(sys.id, cam.camera);
  const status = getPhotoStatus(sys.id, cam.camera);
  if (count > 0) {
    const label = count === 1 ? "1 фото" : `${count} фото`;
    return { cls: "done", text: label };
  }
  if (status === "done") {
    return { cls: "done", text: "Фото есть" };
  }
  if (status === "skip") {
    return { cls: "skip", text: "Без фото" };
  }
  const hasCable = Boolean(metrazhMap[metrazhKey(sys.id, cam.camera)]);
  if (hasCable) {
    return { cls: "need", text: "Нужно фото" };
  }
  return { cls: "none", text: "Фото —" };
}

function updatePhotoReportBadge() {
  const badge = $("photo-report-badge");
  if (!badge || !selectedCamera) return;
  const { system, cam } = selectedCamera;
  const n = sessionPhotos.length;

  if (n > 0) {
    badge.textContent = n === 1 ? "1 фото" : `${n} фото`;
    badge.className = "photo-report-badge photo-report-badge--done";
    return;
  }

  if (camSheetOpen) {
    if (photoSessionLoading) {
      badge.textContent = "Загрузка…";
      badge.className = "photo-report-badge photo-report-badge--loading";
      return;
    }
    const count = getPhotoCount(system.id, cam.camera);
    if (count > 0) {
      badge.textContent = count === 1 ? "1 на Диске" : `${count} на Диске`;
      badge.className = "photo-report-badge photo-report-badge--done";
      return;
    }
  }

  const d = getPhotoReportDisplay(system, cam);
  badge.textContent = d.text;
  badge.className = `photo-report-badge photo-report-badge--${d.cls}`;
}

const PHOTO_PROBE_CONCURRENCY = 4;

function cameraNeedsPhotoProbe(sys, cam) {
  const st = getPhotoStatus(sys.id, cam.camera);
  return st !== "skip" && st !== "done";
}

async function probeOneCameraPhotos(sys, sec, cam) {
  const r = await apiGet("listPhotos", {
    system: sys.id,
    systemCode: sys.code,
    camera: normalizeCameraCode(cam.camera),
    sectionFolder: sectionFolderName(sec),
    projectName: projectFolderName(),
  });
  if (r.ok && Array.isArray(r.photos) && r.photos.length) {
    setPhotoStatus(sys.id, cam.camera, "done", r.photos.length);
    return true;
  }
  return false;
}

/** Фоновая проверка фото на Диске — не блокирует открытие списка камер. */
async function probeSectionPhotos(sys, sec) {
  if (!photosEnabled() || !apiConfigured() || !navigator.onLine) return;
  const token = ++sectionPhotoProbeToken;
  const pending = (sec.cameras || []).filter((cam) => cameraNeedsPhotoProbe(sys, cam));
  if (!pending.length) return;

  for (let i = 0; i < pending.length; i += PHOTO_PROBE_CONCURRENCY) {
    if (token !== sectionPhotoProbeToken) return;
    const chunk = pending.slice(i, i + PHOTO_PROBE_CONCURRENCY);
    await Promise.all(
      chunk.map((cam) =>
        probeOneCameraPhotos(sys, sec, cam).catch(() => false)
      )
    );
  }
  if (token === sectionPhotoProbeToken) scheduleViewRefresh();
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
  const body = { ...payload, actor: pushActor() };
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
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
  url.searchParams.set("kind", payload.kind || "cable");
  url.searchParams.set("actor", pushActor());
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error("Сеть");
  return parseApiResponse(res);
}

const PHOTO_CHUNK_SIZE = 500;
/** ~2 МБ base64 за запрос — на сервере во временную папку Диска (не в кэш 100 КБ). */
const RD_CHUNK_SIZE = 2 * 1024 * 1024;
/** PDF до ~16 МБ — одним POST (10–12 МБ обычно < 1 мин). */
const RD_SINGLE_MAX_B64 = 22 * 1024 * 1024;
const RD_IDB_NAME = "montazh_rd";
const RD_IDB_STORE = "pending";
/** Старше — не возобновляем (кэш сессии на сервере ~1 ч). */
const RD_RESUME_MAX_AGE_MS = 50 * 60 * 1000;

let rdUploadActive = false;

async function apiUploadPhoto(payload) {
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "photo", actor: pushActor(), ...payload }),
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
      params.actor = pushActor();
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
  return apiGet("deletePhoto", { fileId, actor: pushActor() });
}

async function apiPostJson(body) {
  const res = await fetch(CONFIG.API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Сеть");
  return parseApiResponse(res);
}

function newRdUploadId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function rdIdbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RD_IDB_NAME, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(RD_IDB_STORE, { keyPath: "uploadId" });
    };
  });
}

async function rdIdbPut(record) {
  const db = await rdIdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RD_IDB_STORE, "readwrite");
    tx.objectStore(RD_IDB_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function rdIdbGet(uploadId) {
  const db = await rdIdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RD_IDB_STORE, "readonly");
    const req = tx.objectStore(RD_IDB_STORE).get(uploadId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function rdIdbGetFirstPending() {
  const db = await rdIdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RD_IDB_STORE, "readonly");
    const req = tx.objectStore(RD_IDB_STORE).openCursor();
    req.onsuccess = () => resolve(req.result?.value || null);
    req.onerror = () => reject(req.error);
  });
}

async function rdIdbDel(uploadId) {
  const db = await rdIdbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RD_IDB_STORE, "readwrite");
    tx.objectStore(RD_IDB_STORE).delete(uploadId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Удалить просроченные / завершённые черновики загрузки PDF в IndexedDB. */
async function rdIdbClearStale(maxAgeMs = RD_RESUME_MAX_AGE_MS) {
  const db = await rdIdbOpen();
  const now = Date.now();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RD_IDB_STORE, "readwrite");
    const store = tx.objectStore(RD_IDB_STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const v = cursor.value;
      const done = v.nextPart >= v.total;
      const old = !v.updatedAt || now - v.updatedAt > maxAgeMs;
      if (done || old) cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function rdUploadProgressText(done, total) {
  if (!total || total <= 1) return "Загрузка PDF…";
  const pct = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
  return `Загрузка PDF… ${pct}%`;
}

function setRdUploadUi(active, text = "") {
  rdUploadActive = active;
  const fileBtn = $("btn-rd-open");
  const fileEmpty = $("rd-file-empty");
  const replace = $("btn-rd-replace");
  if (active) {
    if (fileBtn) {
      fileBtn.hidden = false;
      fileBtn.textContent = text || "Загрузка…";
      fileBtn.disabled = true;
    }
    if (fileEmpty) fileEmpty.hidden = true;
    if (replace) replace.disabled = true;
  } else {
    if (fileBtn) fileBtn.disabled = false;
    if (replace) replace.disabled = false;
  }
}

function setRdFileDisplay(fileName, hasUrl) {
  const fileBtn = $("btn-rd-open");
  const fileEmpty = $("rd-file-empty");
  if (!fileBtn || !fileEmpty) return;
  if (hasUrl && fileName) {
    fileBtn.hidden = false;
    fileBtn.textContent = fileName;
    fileBtn.title = `Открыть: ${fileName}`;
    fileEmpty.hidden = true;
  } else {
    fileBtn.hidden = true;
    fileEmpty.hidden = false;
    fileEmpty.textContent = "нет PDF";
  }
}

async function apiUploadRd(payload, opts = {}) {
  const { data, system, systemCode, projectName, fileName } = payload;
  const onProgress = opts.onProgress || apiUploadRd.onProgress;
  let uploadId = opts.uploadId || newRdUploadId();
  let startPart = opts.startPart || 0;

  const report = (done, total, label) => {
    const t = label || rdUploadProgressText(done, total);
    setRdUploadUi(true, t);
    if (typeof onProgress === "function") onProgress(done, total);
  };

  if (data.length <= RD_SINGLE_MAX_B64) {
    report(0, 1, "Загрузка PDF… 0%");
    try {
      const one = await apiPostJson({
        action: "rd",
        system,
        systemCode,
        projectName,
        fileName,
        data,
        actor: pushActor(),
      });
      if (one.ok) {
        report(1, 1, "Загрузка PDF… 100%");
        return one;
      }
      if (one.error && !/слишком|large|limit/i.test(String(one.error))) return one;
    } catch {
      /* крупными частями через Диск */
    }
  }

  const total = Math.max(1, Math.ceil(data.length / RD_CHUNK_SIZE));
  if (startPart === 0) report(0, total);
  let last = null;

  const idbRecord = {
    uploadId,
    data,
    system,
    systemCode,
    projectName,
    fileName,
    nextPart: startPart,
    total,
    updatedAt: Date.now(),
  };
  await rdIdbPut(idbRecord);

  for (let part = startPart; part < total; part++) {
    const chunk = data.slice(part * RD_CHUNK_SIZE, (part + 1) * RD_CHUNK_SIZE);
    const body = {
      action: "rdChunk",
      uploadId,
      part,
      total,
      chunk,
    };
    if (part === 0) {
      body.system = system;
      body.systemCode = systemCode;
      body.projectName = projectName;
      body.fileName = fileName;
      body.actor = pushActor();
    }
    report(part + 1, total);
    last = await apiPostJson(body);
    if (!last.ok && !last.pending) throw new Error(last.error || "Загрузка PDF");
    idbRecord.nextPart = part + 1;
    idbRecord.updatedAt = Date.now();
    await rdIdbPut(idbRecord);
  }

  await rdIdbDel(uploadId);
  report(total, total, "Загрузка PDF… 100%");
  return last;
}

async function runRdUploadJob(record, opts = {}) {
  const restartFromStart = Boolean(opts.restartFromStart);
  const sys =
    catalog.systems.find((s) => s.id === record.system) ||
    (nav.system?.id === record.system ? nav.system : null);
  if (!sys?.ready) {
    await rdIdbDel(record.uploadId);
    return;
  }

  const startPart = restartFromStart ? 0 : record.nextPart || 0;
  if (restartFromStart) {
    record.nextPart = 0;
    await rdIdbPut(record);
  }

  setRdUploadUi(true, "Загрузка PDF…");
  try {
    const r = await apiUploadRd(
      {
        data: record.data,
        system: record.system,
        systemCode: record.systemCode,
        projectName: record.projectName,
        fileName: record.fileName,
      },
      { uploadId: record.uploadId, startPart }
    );
    if (r.ok) {
      toast(`РД загружена: ${r.name || record.fileName}`, "success");
      const uploaded = catalog.systems.find((s) => s.id === record.system);
      if (uploaded?.ready) {
        if (nav.system?.ready) await refreshRdPanel(nav.system);
      }
    } else {
      const errMsg = rdApiErrorMessage(null, r);
      if (isRdSessionExpiredError(errMsg) && !restartFromStart && startPart > 0) {
        return runRdUploadJob(record, { restartFromStart: true });
      }
      if (isRdSessionExpiredError(errMsg)) {
        await rdIdbDel(record.uploadId);
      }
      toast(errMsg, "error");
      if (nav.system?.ready) await refreshRdPanel(nav.system);
    }
  } catch (err) {
    const errMsg = rdApiErrorMessage(err, null);
    if (isRdSessionExpiredError(errMsg) && !restartFromStart && startPart > 0) {
      return runRdUploadJob(record, { restartFromStart: true });
    }
    if (isRdSessionExpiredError(errMsg)) {
      await rdIdbDel(record.uploadId);
    }
    toast(errMsg, "error");
    if (nav.system?.ready) await refreshRdPanel(nav.system);
  } finally {
    setRdUploadUi(false);
    const replace = $("btn-rd-replace");
    if (replace) replace.disabled = false;
  }
}

async function tryResumeRdUpload() {
  let removedStale = false;
  try {
    const db = await rdIdbOpen();
    const before = await rdIdbGetFirstPending();
    await rdIdbClearStale(RD_RESUME_MAX_AGE_MS);
    const after = await rdIdbGetFirstPending();
    removedStale = Boolean(before && !after);
  } catch {
    /* private mode */
  }

  const record = await rdIdbGetFirstPending();
  if (!record?.data || !record.uploadId) {
    if (removedStale && document.querySelector("#screen-systems.active")) {
      if (nav.system?.ready) await refreshRdPanel(nav.system);
    }
    return;
  }
  if (record.nextPart >= record.total) {
    await rdIdbDel(record.uploadId);
    return;
  }

  const age = Date.now() - (record.updatedAt || 0);
  if (age > RD_RESUME_MAX_AGE_MS) {
    await rdIdbDel(record.uploadId);
    if (nav.system?.ready) await refreshRdPanel(nav.system);
    return;
  }

  toast("Продолжаем загрузку PDF…", "queue");
  runRdUploadJob(record);
}

function photosEnabled() {
  return CONFIG.PHOTOS_ENABLED !== false && apiConfigured();
}

function updatePhotoBlockVisibility() {
  const block = $("photo-block");
  if (!block) return;
  block.hidden = !photosEnabled();
}

function photoMaxBytes() {
  return (CONFIG.PHOTO_MAX_MB || 2) * 1024 * 1024;
}

function photoMinWarnBytes() {
  return (CONFIG.PHOTO_MIN_WARN_KB || 250) * 1024;
}

function photoMaxSide() {
  return CONFIG.PHOTO_MAX_SIDE || 1920;
}

function photoJpegQuality() {
  const q = Number(CONFIG.PHOTO_JPEG_QUALITY);
  return Number.isFinite(q) && q > 0 && q <= 1 ? q : 0.88;
}

function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
}

async function readImageMeta(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const meta = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return meta;
  } catch {
    return { width: 0, height: 0 };
  }
}

function photoMimeType(file) {
  const t = String(file.type || "").toLowerCase();
  if (t.includes("png")) return "image/png";
  if (t.includes("webp")) return "image/webp";
  if (t.includes("heic") || t.includes("heif")) return "image/heic";
  if (t.startsWith("image/")) return t;
  return "image/jpeg";
}

async function compressImageToBlob(file, maxSide, quality) {
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
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Сжатие не удалось"))),
      "image/jpeg",
      quality
    );
  });
}

/** Нормализация: макс. 1080p (1920 px) и PHOTO_MAX_MB; если больше — сжимаем. */
async function preparePhotoForUpload(file) {
  const maxBytes = photoMaxBytes();
  const maxSide = photoMaxSide();
  const mime = photoMimeType(file);
  const isJpeg = mime.includes("jpeg");
  const meta = await readImageMeta(file);
  const longSide = Math.max(meta.width, meta.height);

  if (isJpeg && file.size <= maxBytes && longSide <= maxSide) {
    return {
      blob: file,
      mimeType: mime,
      compressed: false,
      bytes: file.size,
      width: meta.width,
      height: meta.height,
    };
  }

  const tries = [
    [maxSide, photoJpegQuality()],
    [maxSide, 0.82],
    [maxSide, 0.76],
    [maxSide, 0.7],
    [maxSide, 0.64],
    [maxSide, 0.58],
    [maxSide, 0.52],
    [Math.round(maxSide * 0.85), 0.5],
    [1280, 0.48],
  ];
  let lastBlob = null;
  for (const [side, q] of tries) {
    lastBlob = await compressImageToBlob(file, side, q);
    if (lastBlob.size <= maxBytes) {
      const outMeta = await readImageMeta(lastBlob);
      return {
        blob: lastBlob,
        mimeType: "image/jpeg",
        compressed: true,
        bytes: lastBlob.size,
        width: outMeta.width,
        height: outMeta.height,
      };
    }
  }
  throw new Error(
    `Не удалось уместить фото в ${CONFIG.PHOTO_MAX_MB || 2} МБ — попробуйте другой снимок`
  );
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

let photoLoadToken = 0;

async function loadSessionPhotosFromDrive() {
  if (!photosEnabled() || !selectedCamera) {
    photoSessionLoading = false;
    return;
  }
  const token = ++photoLoadToken;
  photoSessionLoading = true;
  renderPhotoSession();
  updatePhotoReportBadge();

  const { system, section, cam } = selectedCamera;
  const finish = () => {
    if (token !== photoLoadToken) return;
    photoSessionLoading = false;
    renderPhotoSession();
    updatePhotoReportBadge();
    if (selectedCamera) renderCameras();
  };

  try {
    const r = await Promise.race([
      apiGet("listPhotos", {
        system: system.id,
        systemCode: system.code,
        sectionFolder: sectionFolderName(section),
        projectName: projectFolderName(),
        camera: normalizeCameraCode(cam.camera),
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 12000)
      ),
    ]);
    if (token !== photoLoadToken) return;
    if (!r.ok) {
      const status = $("photo-status");
      if (status) {
        status.textContent = r.needDriveAuth
          ? "Нужно разрешить Диск в таблице (меню Метраж)"
          : "Не удалось загрузить список фото";
      }
      return;
    }
    if (!Array.isArray(r.photos) || !r.photos.length) {
      setPhotoStatus(system.id, cam.camera, null);
      return;
    }
    clearSessionPhotos();
    for (const p of r.photos) {
      sessionPhotos.push({
        thumbDataUrl: p.thumbDataUrl || "",
        previewUrl: p.thumbDataUrl || "",
        driveUrl: p.url,
        fileId: p.fileId,
        fromDrive: true,
      });
    }
    setPhotoStatus(system.id, cam.camera, "done", r.photos.length);
    renderPhotoSession();
    updatePhotoReportBadge();
    renderCameras();
    hydrateSessionPhotoPreviews();
  } catch {
    if (token !== photoLoadToken) return;
    const status = $("photo-status");
    if (status) status.textContent = "Нет связи — фото на Диске, обновите позже";
  } finally {
    finish();
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
    photoSheetIndex = 0;
    preview.classList.add("photo-preview--empty");
    if (photoSessionLoading) {
      status.textContent = "Загрузка фото с Диска…";
      preview.innerHTML =
        '<span class="photo-preview-empty">Загрузка с Диска…</span>';
    } else if (selectedCamera) {
      const { system, cam } = selectedCamera;
      const count = getPhotoCount(system.id, cam.camera);
      if (count > 0) {
        status.textContent = "Фото на Диске — не удалось показать превью";
        preview.innerHTML =
          '<span class="photo-preview-empty">Обновите страницу или снимите заново</span>';
      } else {
        status.textContent = `До ${MAX_SESSION_PHOTOS} фото на камеру`;
        preview.innerHTML =
          '<span class="photo-preview-empty">Нет фото — снимите или «Без фото»</span>';
      }
    } else {
      status.textContent = `До ${MAX_SESSION_PHOTOS} фото на камеру`;
      preview.innerHTML =
        '<span class="photo-preview-empty">Нет фото — снимите или «Без фото»</span>';
    }
    updatePhotoReportBadge();
    return;
  }

  photoSheetIndex = Math.min(photoSheetIndex, n - 1);
  status.innerHTML = atMax
    ? `<strong>${n}/${MAX_SESSION_PHOTOS}</strong> · нажмите фото — на весь экран`
    : `<strong>${n}/${MAX_SESSION_PHOTOS}</strong> · нажмите фото — на весь экран`;

  preview.classList.remove("photo-preview--empty");
  preview.innerHTML = "";

  const p = sessionPhotos[photoSheetIndex];
  const hero = document.createElement("button");
  hero.type = "button";
  hero.className = "photo-hero";
  hero.dataset.photoIdx = String(photoSheetIndex);
  hero.setAttribute("aria-label", `Фото ${photoSheetIndex + 1} — открыть на весь экран`);

  const heroImg = document.createElement("img");
  bindPhotoImg(heroImg, p);
  hero.appendChild(heroImg);

  const heroHint = document.createElement("span");
  heroHint.className = "photo-hero__hint";
  heroHint.textContent = "На весь экран";
  hero.appendChild(heroHint);

  preview.appendChild(hero);

  if (n > 1) {
    const strip = document.createElement("div");
    strip.className = "photo-strip";
    strip.setAttribute("role", "tablist");
    sessionPhotos.forEach((item, i) => {
      const t = document.createElement("button");
      t.type = "button";
      t.className = `photo-strip__thumb${i === photoSheetIndex ? " is-active" : ""}`;
      t.setAttribute("role", "tab");
      t.setAttribute("aria-selected", i === photoSheetIndex ? "true" : "false");
      t.setAttribute("aria-label", `Фото ${i + 1}`);
      const simg = document.createElement("img");
      bindPhotoImg(simg, item);
      t.appendChild(simg);
      t.addEventListener("click", (e) => {
        e.stopPropagation();
        photoSheetIndex = i;
        renderPhotoSession();
      });
      strip.appendChild(t);
    });
    preview.appendChild(strip);
  }

  const toolbar = document.createElement("div");
  toolbar.className = "photo-toolbar";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "photo-toolbar__delete";
  del.dataset.photoIdx = String(photoSheetIndex);
  del.setAttribute("aria-label", `Удалить фото ${photoSheetIndex + 1}`);
  del.textContent = "Удалить фото";
  toolbar.appendChild(del);
  preview.appendChild(toolbar);

  updatePhotoReportBadge();
}

function markPhotoSkipped() {
  if (!selectedCamera) return;
  const { system, cam } = selectedCamera;
  setPhotoStatus(system.id, cam.camera, "skip");
  renderCameras();
  updatePhotoReportBadge();
  toast("Отчёт отмечен: без фото", "queue");
}

function resetPhotoLightboxZoom() {
  photoLbZoom = 1;
  const vp = $("photo-lightbox-viewport");
  const img = $("photo-lightbox-img");
  const hint = $("photo-lightbox-hint");
  if (img) {
    img.style.transform = "";
    img.style.transformOrigin = "center center";
  }
  vp?.classList.remove("is-zoomed");
  if (hint) hint.textContent = "Нажмите — закрыть · двойное — увеличить";
}

function togglePhotoLightboxZoom(clientX, clientY) {
  const vp = $("photo-lightbox-viewport");
  const img = $("photo-lightbox-img");
  const hint = $("photo-lightbox-hint");
  if (!vp || !img) return;

  if (photoLbZoom > 1) {
    resetPhotoLightboxZoom();
    return;
  }

  photoLbZoom = PHOTO_LB_ZOOM;
  const rect = img.getBoundingClientRect();
  const w = rect.width || 1;
  const h = rect.height || 1;
  const ox = Math.max(0, Math.min(100, ((clientX - rect.left) / w) * 100));
  const oy = Math.max(0, Math.min(100, ((clientY - rect.top) / h) * 100));
  img.style.transformOrigin = `${ox}% ${oy}%`;
  img.style.transform = `scale(${PHOTO_LB_ZOOM})`;
  vp.classList.add("is-zoomed");
  if (hint) hint.textContent = "Двойное — уменьшить";
}

function handlePhotoLightboxTap(e) {
  if (
    e.target.closest(
      ".photo-lightbox__close, .photo-lightbox__delete, .photo-lightbox__nav, .photo-lightbox__drive, .photo-lightbox__counter"
    )
  ) {
    return;
  }

  const x = e.clientX ?? e.changedTouches?.[0]?.clientX ?? 0;
  const y = e.clientY ?? e.changedTouches?.[0]?.clientY ?? 0;
  const now = Date.now();

  if (now - photoLbLastTap < 320) {
    clearTimeout(photoLbTapTimer);
    photoLbTapTimer = null;
    photoLbLastTap = 0;
    e.preventDefault();
    togglePhotoLightboxZoom(x, y);
    return;
  }

  photoLbLastTap = now;
  clearTimeout(photoLbTapTimer);
  photoLbTapTimer = setTimeout(() => {
    photoLbTapTimer = null;
    if (photoLbZoom <= 1) closePhotoLightbox();
    photoLbLastTap = 0;
  }, 320);
}

function updatePhotoLightboxView() {
  const p = sessionPhotos[photoLightboxIndex];
  const img = $("photo-lightbox-img");
  const counter = $("photo-lightbox-counter");
  const drive = $("photo-lightbox-drive");
  const prev = $("photo-lightbox-prev");
  const next = $("photo-lightbox-next");
  if (!img || !p) return;

  resetPhotoLightboxZoom();
  img.src = photoFullFromItem(p);
  if (counter) {
    counter.textContent = `${photoLightboxIndex + 1} / ${sessionPhotos.length}`;
  }
  if (drive) {
    if (p.driveUrl) {
      drive.href = p.driveUrl;
      drive.hidden = false;
    } else {
      drive.hidden = true;
    }
  }
  if (prev) prev.disabled = photoLightboxIndex <= 0;
  if (next) next.disabled = photoLightboxIndex >= sessionPhotos.length - 1;
}

function openPhotoLightbox(index) {
  if (!sessionPhotos[index]) return;
  photoLightboxIndex = index;
  photoSheetIndex = index;
  updatePhotoLightboxView();
  const box = $("photo-lightbox");
  if (box) {
    box.hidden = false;
    document.body.classList.add("photo-lightbox-open");
  }
}

function closePhotoLightbox() {
  clearTimeout(photoLbTapTimer);
  photoLbTapTimer = null;
  photoLbLastTap = 0;
  resetPhotoLightboxZoom();
  const box = $("photo-lightbox");
  if (box) box.hidden = true;
  document.body.classList.remove("photo-lightbox-open");
  const img = $("photo-lightbox-img");
  if (img) img.removeAttribute("src");
}

function stepPhotoLightbox(delta) {
  const next = photoLightboxIndex + delta;
  if (next < 0 || next >= sessionPhotos.length) return;
  photoLightboxIndex = next;
  photoSheetIndex = next;
  updatePhotoLightboxView();
}

function initPhotoLightbox() {
  $("photo-lightbox-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closePhotoLightbox();
  });
  $("photo-lightbox-backdrop")?.addEventListener("click", closePhotoLightbox);
  const vp = $("photo-lightbox-viewport");
  vp?.addEventListener("click", handlePhotoLightboxTap);
  $("photo-lightbox-prev")?.addEventListener("click", (e) => {
    e.stopPropagation();
    stepPhotoLightbox(-1);
  });
  $("photo-lightbox-next")?.addEventListener("click", (e) => {
    e.stopPropagation();
    stepPhotoLightbox(1);
  });
  $("photo-lightbox-delete")?.addEventListener("click", (e) => {
    e.stopPropagation();
    requestPhotoDelete(photoLightboxIndex);
  });
}

let pendingPhotoDeleteIndex = null;

function closePhotoDeleteConfirm() {
  pendingPhotoDeleteIndex = null;
  const el = $("photo-delete-confirm");
  if (el) el.hidden = true;
  document.body.classList.remove("photo-delete-confirm-open");
}

function requestPhotoDelete(index) {
  if (!sessionPhotos[index]) return;
  const p = sessionPhotos[index];
  const msg = p.fileId
    ? "Удалить это фото?\n\nФото будет удалено с Google Диска. Восстановить будет нельзя."
    : "Убрать это фото из списка?";

  const el = $("photo-delete-confirm");
  if (!el) {
    if (!window.confirm(msg)) return;
    deleteSessionPhoto(index, true);
    return;
  }

  pendingPhotoDeleteIndex = index;
  const desc = $("photo-delete-desc");
  if (desc) {
    desc.textContent = p.fileId
      ? "Фото будет удалено с Google Диска без возможности восстановления."
      : "Фото ещё не на Диске — будет убрано из списка.";
  }
  el.hidden = false;
  document.body.classList.add("photo-delete-confirm-open");
  $("photo-delete-cancel")?.focus();
}

function initPhotoDeleteConfirm() {
  $("photo-delete-cancel")?.addEventListener("click", closePhotoDeleteConfirm);
  $("photo-delete-cancel-backdrop")?.addEventListener("click", closePhotoDeleteConfirm);
  $("photo-delete-ok")?.addEventListener("click", () => {
    const idx = pendingPhotoDeleteIndex;
    closePhotoDeleteConfirm();
    if (idx != null) deleteSessionPhoto(idx, true);
  });
}

async function deleteSessionPhoto(index, confirmed = false) {
  if (!confirmed) {
    requestPhotoDelete(index);
    return;
  }
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
    photoSheetIndex = Math.min(photoSheetIndex, Math.max(0, sessionPhotos.length - 1));
    if (!$("photo-lightbox")?.hidden) {
      if (!sessionPhotos.length) closePhotoLightbox();
      else {
        photoLightboxIndex = Math.min(index, sessionPhotos.length - 1);
        updatePhotoLightboxView();
      }
    }
    const { system, cam } = selectedCamera;
    if (!sessionPhotos.length) {
      if (getPhotoStatus(system.id, cam.camera) !== "skip") {
        setPhotoStatus(system.id, cam.camera, null);
      }
    } else {
      setPhotoStatus(system.id, cam.camera, "done", sessionPhotos.length);
    }
    renderPhotoSession();
    renderCameras();
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
    toast(`Максимум ${MAX_SESSION_PHOTOS} фото — удалите лишнее (🗑)`, "error");
    return;
  }
  if (!navigator.onLine) {
    toast("Нужен интернет для фото", "error");
    return;
  }
  if (!String(file.type || "").toLowerCase().startsWith("image/")) {
    toast("Нужен файл изображения", "error");
    return;
  }

  const status = $("photo-status");
  setPhotoButtonsDisabled(true);
  const srcMeta = await readImageMeta(file);
  const srcLong = Math.max(srcMeta.width, srcMeta.height);
  if (file.size < photoMinWarnBytes() || (srcLong > 0 && srcLong < 1280)) {
    toast(
      `Файл маленький (${formatFileSize(file.size)}${srcLong ? `, ${srcLong}px` : ""}) — для отчёта лучше «Галерея»`,
      "warn"
    );
  }
  const needsCompress =
    file.size > photoMaxBytes() ||
    srcLong > photoMaxSide() ||
    !photoMimeType(file).includes("jpeg");
  status.textContent = needsCompress ? "Сжатие фото…" : "Отправка фото…";
  apiUploadPhoto.onProgress = (n, total) => {
    status.textContent =
      total > 1 ? `Отправка фото… ${n}/${total}` : "Отправка фото…";
  };

  try {
    const prepared = await preparePhotoForUpload(file);
    if (prepared.compressed) status.textContent = "Отправка фото (сжато)…";
    const data = await blobToBase64(prepared.blob);
    const { system, section, cam } = selectedCamera;
    const r = await apiUploadPhoto({
      system: system.id,
      systemCode: system.code,
      projectName: projectFolderName(),
      sectionFolder: sectionFolderName(section),
      camera: normalizeCameraCode(cam.camera),
      row: cam.row,
      data,
      mimeType: prepared.mimeType,
    });
    if (r.ok) {
      sessionPhotos.push({
        previewUrl: URL.createObjectURL(prepared.blob),
        driveUrl: r.url,
        fileId: r.fileId,
        fromDrive: false,
      });
      photoSheetIndex = sessionPhotos.length - 1;
      setPhotoStatus(system.id, cam.camera, "done", sessionPhotos.length);
      renderPhotoSession();
      renderCameras();
      const savedMsg = prepared.compressed
        ? `Фото ${sessionPhotos.length} · ${formatFileSize(prepared.bytes)} (сжато) · ${formatCameraCode(cam.camera)}`
        : `Фото ${sessionPhotos.length} · ${formatFileSize(prepared.bytes)} · ${formatCameraCode(cam.camera)}`;
      toast(savedMsg, "success");
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

function cameraDisplayName(cam) {
  if (cam?.label) return formatCameraLabelDisplay(cam.label);
  return formatCameraLabelDisplay(cam?.camera || "");
}

/** На экране кириллица ВК с пробелами как в таблице. */
function formatCameraCode(code) {
  return formatCameraLabelDisplay(code);
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

function currentNavSnap() {
  const active = document.querySelector(".screen.active")?.id?.replace("screen-", "") || "systems";
  return {
    screen: active,
    systemId: nav.system?.id ?? null,
    sectionId: nav.section?.id ?? null,
    sheet: camSheetOpen && selectedCamera?.cam ? selectedCamera.cam.camera : null,
  };
}

function snapsEqual(a, b) {
  return (
    a.screen === b.screen &&
    a.systemId === b.systemId &&
    a.sectionId === b.sectionId &&
    a.sheet === b.sheet
  );
}

function pushNavHistory() {
  if (suppressHistoryPush) return;
  const snap = currentNavSnap();
  const cur = navHistory.stack[navHistory.index];
  if (cur && snapsEqual(cur, snap)) return;
  navHistory.stack = navHistory.stack.slice(0, navHistory.index + 1);
  navHistory.stack.push(snap);
  navHistory.index = navHistory.stack.length - 1;
  if (navHistory.stack.length > 40) {
    navHistory.stack.shift();
    navHistory.index = navHistory.stack.length - 1;
  }
}

function resetNavHistoryFromCurrent() {
  navHistory.stack = [currentNavSnap()];
  navHistory.index = 0;
}

function applyNavSnap(snap) {
  if (!snap) return;
  suppressHistoryPush = true;
  closeCamSheet(false);

  if (snap.screen === "systems" || !snap.systemId) {
    goSystems();
    suppressHistoryPush = false;
    return;
  }

  const sys = findSystemById(snap.systemId);
  if (!sys?.ready) {
    goSystems();
    suppressHistoryPush = false;
    return;
  }

  if (snap.screen === "sections") {
    goSections(sys);
    suppressHistoryPush = false;
    return;
  }

  const sec = snap.sectionId ? findSectionById(sys, snap.sectionId) : null;
  if (!sec) {
    goSections(sys);
    suppressHistoryPush = false;
    return;
  }

  goCameras(sec, sys);
  if (snap.sheet) {
    const cam = findCameraInSection(sec, snap.sheet);
    if (cam) openCamSheet(sys, sec, cam);
  }
  suppressHistoryPush = false;
}

function navGoBack() {
  if (camSheetOpen) {
    closeCamSheet();
    return true;
  }
  if (navHistory.index > 0) {
    navHistory.index -= 1;
    applyNavSnap(navHistory.stack[navHistory.index]);
    return true;
  }
  return false;
}

function navGoForward() {
  if (camSheetOpen) return false;
  if (navHistory.index < navHistory.stack.length - 1) {
    navHistory.index += 1;
    applyNavSnap(navHistory.stack[navHistory.index]);
    return true;
  }
  return false;
}

function showScreen(name) {
  if (name !== "cameras") closeCamSheet(false);
  document.querySelectorAll(".screen").forEach((el) => el.classList.remove("active"));
  const screen = document.getElementById(`screen-${name}`);
  if (screen) screen.classList.add("active");

  const back = $("nav-back");
  if (back) back.hidden = name === "systems";

  updateHeader(name);
  persistNavState(name);
  syncRdPanelVisibility();
}

function syncRdPanelVisibility() {
  const bar = $("header-rd");
  if (!bar) return;
  const active = document.querySelector(".screen.active")?.id;
  const show =
    (active === "screen-sections" || active === "screen-cameras") && Boolean(nav.system?.ready);
  bar.hidden = !show;
}

function findSystemById(systemId) {
  if (!systemId) return null;
  const hit = catalog.systems.find((s) => s.id === systemId);
  if (hit) return hit;
  return catalogBackup?.systems?.find((s) => s.id === systemId) || null;
}

/** Элементы вне списка — свайп/pull не перехватываем. Карточки (.pick-card) — можно тянуть вниз. */
function isOutsideScreensGesture(node) {
  if (!node?.closest) return true;
  return Boolean(
    node.closest(
      ".app-header, .cam-sheet, .photo-lightbox, .refresh-overlay, #toast, #notify-banner, #setup-banner"
    )
  );
}

function openSystem(systemId) {
  const sys = findSystemById(systemId);
  if (!sys) {
    toast("Система не найдена — потяните вниз для обновления", "error");
    return;
  }
  if (!sys.ready) {
    toast(sys.note || "Таблица для этой системы ещё не подключена", "queue");
    return;
  }
  if (!Array.isArray(sys.sections) || !sys.sections.length) {
    toast(`Нет секций для «${sys.code || systemId}» — обновите каталог`, "error");
    return;
  }
  goSections(sys);
}

function openSection(section) {
  const sys = findSystemById(nav.system?.id) || nav.system;
  if (!sys?.ready) {
    toast("Сначала выберите систему", "error");
    goSystems();
    return;
  }
  goCameras(section, sys);
}

function findSectionById(system, sectionId) {
  if (!system?.sections || !sectionId) return null;
  const direct = system.sections.find((s) => s.id === sectionId);
  if (direct) return direct;
  const legacy = String(sectionId).match(/^sec-(\d+)$/);
  if (legacy && system.id) {
    return system.sections.find((s) => s.id === `${system.id}-sec-${legacy[1]}`) || null;
  }
  return null;
}

function findSystemForSection(section) {
  if (!section?.id) return nav.system || null;
  if (nav.system && findSectionById(nav.system, section.id)) return nav.system;
  let found = null;
  for (const sys of catalog.systems || []) {
    if (!findSectionById(sys, section.id)) continue;
    if (found) return nav.system && findSectionById(nav.system, section.id) ? nav.system : null;
    found = sys;
  }
  return found;
}

function ensureNavSystem(system) {
  const sys = system || nav.system;
  if (sys) nav.system = sys;
  return sys || null;
}

function bindSectionToSystem(system, section) {
  if (!system?.ready || !section) return null;
  return findSectionById(system, section.id);
}

function findCameraInSection(section, cameraCode) {
  const norm = normalizeCameraCode(cameraCode);
  return (
    section?.cameras?.find(
      (c) => c.camera === cameraCode || normalizeCameraCode(c.camera) === norm
    ) || null
  );
}

/** После loadCatalog — ссылки на system/section/camera из свежего каталога. */
function rebindNavFromCatalog() {
  if (!nav.system && nav.section) {
    const inferred = findSystemForSection(nav.section);
    if (inferred) nav.system = inferred;
  }
  if (!nav.system) return;

  const sys = findSystemById(nav.system.id);
  const localOk =
    nav.system?.ready && Array.isArray(nav.system.sections) && nav.system.sections.length > 0;

  if (!sys?.ready || !sys.sections?.length) {
    if (localOk) return;
    if (document.querySelector("#screen-systems.active")) return;
    suppressHistoryPush = true;
    goSystems();
    suppressHistoryPush = false;
    resetNavHistoryFromCurrent();
    return;
  }

  nav.system = sys;
  if (!nav.section) return;
  const sec = findSectionById(sys, nav.section.id);
  if (!sec) {
    nav.section = null;
    const active = document.querySelector(".screen.active")?.id;
    if (active === "screen-cameras") {
      suppressHistoryPush = true;
      goSections(sys);
      suppressHistoryPush = false;
      resetNavHistoryFromCurrent();
    }
    return;
  }
  nav.section = sec;
  if (!selectedCamera) return;
  const cam = findCameraInSection(sec, selectedCamera.cam.camera);
  if (cam) selectedCamera = { system: sys, section: sec, cam };
}

function persistNavState(screenName) {
  try {
    const state = { screen: screenName };
    if (nav.system) state.systemId = nav.system.id;
    if (nav.section) state.sectionId = nav.section.id;
    if (screenName === "cameras" && camSheetOpen && selectedCamera) {
      state.camera = selectedCamera.cam.camera;
      state.sheet = true;
    }
    sessionStorage.setItem(NAV_STATE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota */
  }
}

/** Вернуть экран после перезагрузки PWA (обновление SW). */
function restoreNavState() {
  suppressHistoryPush = true;
  try {
    const raw = sessionStorage.getItem(NAV_STATE_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    if (!state?.screen || state.screen === "systems") {
      goSystems();
      return true;
    }
    const sys = state.systemId ? findSystemById(state.systemId) : null;
    if (!sys?.ready) {
      goSystems();
      return true;
    }
    if (state.screen === "sections") {
      goSections(sys);
      return true;
    }
    const sec = state.sectionId ? findSectionById(sys, state.sectionId) : null;
    if (!sec) {
      goSections(sys);
      return true;
    }
    if (state.screen === "cameras") {
      goCameras(sec, sys);
      if (state.camera && state.sheet) {
        const cam = findCameraInSection(sec, state.camera);
        if (cam) openCamSheet(sys, sec, cam);
      }
      return true;
    }
    if (state.screen === "input" && state.camera) {
      const cam = findCameraInSection(sec, state.camera);
      nav.system = sys;
      nav.section = sec;
      goCameras(sec, sys);
      if (cam) openCamSheet(sys, sec, cam);
      return true;
    }
    goSystems();
    return true;
  } catch {
    return false;
  } finally {
    suppressHistoryPush = false;
  }
}

function updateHeader(screenName) {
  const site = catalog.site?.name || CONFIG.PROJECT_NAME || "Объект";
  const sysTitle = nav.system ? systemDisplayTitle(nav.system) : "";
  const titleEl = $("screen-title");
  if (titleEl) {
    titleEl.textContent = screenName === "systems" ? site : sysTitle || "Монтажник";
    titleEl.classList.remove("screen-title--hidden");
  }
  const crumbs = [];
  if (nav.section && screenName === "cameras") {
    const info = parseSectionName(nav.section.name);
    crumbs.push(info.num ? `Сек. ${info.num}` : nav.section.name);
  }
  $("breadcrumb").textContent = crumbs.join(" › ");

  const meta = document.querySelector(".header-meta");
  if (meta) meta.hidden = screenName === "systems";

  syncRdPanelVisibility();
}

let rdViewUrl = "";

async function refreshRdPanel(sys) {
  const btnOpen = $("btn-rd-open");
  const btnReplace = $("btn-rd-replace");
  if (!btnOpen || !btnReplace) return;

  rdViewUrl = "";
  btnOpen.onclick = null;

  if (!sys?.ready) return;
  syncRdPanelVisibility();
  if ($("header-rd")?.hidden) return;

  if (rdUploadActive) return;

  if (!apiConfigured()) {
    setRdFileDisplay("", false);
    btnReplace.hidden = true;
    return;
  }
  btnReplace.hidden = false;
  btnReplace.title = "Загрузить или заменить PDF";

  try {
    const r = await apiGet("rdLink", {
      system: sys.id,
      systemCode: sys.code,
      projectName: projectFolderName(),
    });
    if (r.ok && (r.viewUrl || r.url)) {
      rdViewUrl = r.viewUrl || r.url;
      const name = r.name ? String(r.name) : "PDF";
      setRdFileDisplay(name, true);
      btnOpen.onclick = () => window.open(rdViewUrl, "_blank", "noopener,noreferrer");
      btnReplace.title = `Заменить: ${name}`;
    } else {
      setRdFileDisplay("", false);
      btnReplace.title = "Загрузить PDF";
    }
  } catch {
    setRdFileDisplay("", false);
    $("rd-file-empty").textContent = "нет связи";
    btnReplace.title = "Загрузить PDF";
  }
}

async function uploadRdFromFile(file) {
  const sys = nav.system;
  if (!sys?.ready) {
    toast("Сначала выберите систему", "error");
    return;
  }
  if (!apiConfigured()) {
    toast("Подключите таблицу в config.js", "error");
    return;
  }
  if (!navigator.onLine) {
    toast("Нужен интернет для загрузки РД", "error");
    return;
  }
  if (rdUploadActive) {
    toast("Уже идёт загрузка PDF — дождитесь или обновите страницу", "queue");
    return;
  }
  const maxMb = CONFIG.RD_MAX_MB || 30;
  if (file.size > maxMb * 1024 * 1024) {
    toast(`PDF больше ${maxMb} МБ — сожмите или разбейте`, "error");
    return;
  }
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    toast("Нужен файл PDF", "error");
    return;
  }

  const btnReplace = $("btn-rd-replace");
  if (btnReplace) btnReplace.disabled = true;
  setRdUploadUi(true, "Подготовка PDF… 0%");

  const uploadId = newRdUploadId();
  let data;
  try {
    data = await blobToBase64(file);
  } catch {
    setRdUploadUi(false);
    if (btnReplace) btnReplace.disabled = false;
    toast("Не удалось прочитать файл", "error");
    $("rd-input").value = "";
    return;
  }

  const record = {
    uploadId,
    data,
    system: sys.id,
    systemCode: sys.code,
    projectName: projectFolderName(),
    fileName: file.name,
    nextPart: 0,
    total: Math.max(1, Math.ceil(data.length / RD_CHUNK_SIZE)),
    updatedAt: Date.now(),
  };

  if (data.length > RD_SINGLE_MAX_B64) {
    try {
      await rdIdbPut(record);
    } catch {
      /* продолжим без IDB */
    }
  }

  $("rd-input").value = "";
  runRdUploadJob(record);
}

function goSystems() {
  nav.system = null;
  nav.section = null;
  showScreen("systems");
  renderSystems();
  updateStats();
  pushNavHistory();
}

function goSections(system) {
  const sys = findSystemById(system?.id) || system;
  if (!sys?.ready || !sys.sections?.length) {
    toast("Система недоступна — обновите каталог", "error");
    goSystems();
    return;
  }
  nav.system = sys;
  nav.section = null;
  showScreen("sections");
  renderSections();
  updateStats();
  void refreshRdPanel(sys);
  pushNavHistory();
}

function goCameras(section, system) {
  const sys = system || nav.system;
  if (!sys?.ready) {
    goSystems();
    return;
  }
  const sec = bindSectionToSystem(sys, section);
  if (!sec) {
    toast("Секция не найдена — обновите список", "error");
    goSections(sys);
    return;
  }
  nav.system = sys;
  nav.section = sec;
  showScreen("cameras");
  renderCameras();
  pushNavHistory();
  queueMicrotask(() => {
    probeSectionPhotos(sys, sec).catch(() => {});
  });
  if (sys.ready) void refreshRdPanel(sys);
}

function goBack() {
  if (!navGoBack()) {
    const active = document.querySelector(".screen.active")?.id;
    if (active === "screen-cameras" && nav.system) goSections(nav.system);
    else if (active === "screen-sections") goSystems();
  }
}

async function loadCatalog(bustCache = false) {
  const url = bustCache ? `catalog.json?t=${Date.now()}` : "catalog.json";
  const res = await fetch(url, bustCache ? { cache: "no-store" } : {});
  if (!res.ok) throw new Error("Нет catalog.json");
  const next = await res.json();
  next.systems = mergeCatalogSystems(next.systems);
  catalog = next;
  catalogBackup = {
    site: catalog.site ? { ...catalog.site } : { id: "", name: "" },
    systems: catalog.systems,
  };
  rebindNavFromCatalog();
}

/** Название объекта в шапке и на Диске = имя Google-таблицы. */
async function syncProjectNameFromApi() {
  // Если название задано вручную (строительная площадка) — не перетираем названием Google-таблицы.
  if (CONFIG.PROJECT_NAME) return;
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

let refreshAppDataInFlight = null;
let lastSilentRefreshAt = 0;
const SILENT_REFRESH_MIN_MS = 120000;

async function refreshAppData(showToast = false) {
  if (refreshAppDataInFlight) return refreshAppDataInFlight;
  refreshAppDataInFlight = (async () => {
    try {
      await loadCatalog(showToast);
    } catch {
      /* офлайн — остаётся текущий каталог */
    }
    await syncProjectNameFromApi();
    loadPhotoStatusMap();
    await refreshMetrazh();
    await flushQueue(false);
    scheduleViewRefresh();
    if (camSheetOpen && selectedCamera) {
      void loadSessionPhotosFromDrive();
    }
    const activeName = document.querySelector(".screen.active")?.id?.replace("screen-", "");
    if (activeName) updateHeader(activeName);
    const activeScreen = document.querySelector(".screen.active")?.id;
    if (
      nav.system?.ready &&
      (activeScreen === "screen-sections" || activeScreen === "screen-cameras")
    ) {
      void refreshRdPanel(nav.system);
    }
    if (showToast) toast("Данные обновлены", "success");
  })();
  try {
    await refreshAppDataInFlight;
  } finally {
    refreshAppDataInFlight = null;
  }
}

function showRefreshOverlay(message = "Загрузка данных…") {
  const el = $("refresh-overlay");
  const sub = $("refresh-overlay-sub");
  if (sub) sub.textContent = message;
  if (el) {
    el.hidden = false;
    document.body.classList.add("refresh-overlay-open");
  }
}

function hideRefreshOverlay() {
  const el = $("refresh-overlay");
  if (el) el.hidden = true;
  document.body.classList.remove("refresh-overlay-open");
}

/** Pull-to-refresh: данные и каталог без перезагрузки страницы (метраж не теряется). */
async function pullRefreshApp() {
  showRefreshOverlay("Отправка очереди…");
  try {
    await flushQueue(true);
    showRefreshOverlay("Загрузка с сервера…");
    await refreshAppData(true);
    toast("Данные обновлены", "success");
  } finally {
    hideRefreshOverlay();
  }
}

function getActiveScrollEl() {
  const screen = document.querySelector(".screen.active");
  if (!screen) return null;
  return screen.querySelector(".tile-grid, .camera-list") || screen;
}

function ptrGestureBlocked() {
  return (
    document.body.classList.contains("cam-sheet-open") ||
    document.body.classList.contains("photo-lightbox-open") ||
    document.body.classList.contains("photo-delete-confirm-open") ||
    document.body.classList.contains("refresh-overlay-open") ||
    Boolean($("refresh-overlay") && !$("refresh-overlay").hidden)
  );
}

function atScrollTopForPtr() {
  const screen = document.querySelector(".screen.active");
  if (!screen) return true;
  const scrollEls = screen.querySelectorAll(".tile-grid, .camera-list");
  if (!scrollEls.length) return screen.scrollTop <= 12;
  for (const el of scrollEls) {
    if (el.scrollTop > 12) return false;
  }
  return true;
}

function chooseGestureAxis(dx, dy) {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < 6 && ady < 6) return null;
  if (atScrollTopForPtr() && dy > 0) {
    if (adx > ady * 1.45 && adx > 18) return "x";
    return "y";
  }
  if (adx > ady * 1.12) return "x";
  return null;
}

function initScreenGestures() {
  const indicator = $("pull-refresh");
  const screens = $("screens");
  if (!screens) return;

  const PTR_SLOP = 14;
  const PTR_TRIGGER = 34;
  const PTR_MAX_VISUAL = 72;
  const SWIPE_TRIGGER = 52;
  const SWIPE_MAX_VISUAL = 44;

  let startX = 0;
  let startY = 0;
  let axis = null;
  let activePointerId = null;
  let ptrEngaged = false;
  let ptrRefreshing = false;
  let lastRawDy = 0;
  let lastRawDx = 0;
  let touchPullActive = false;
  let touchStartY = 0;
  let touchStartX = 0;
  let pointerCaptured = false;
  let blockClicksUntil = 0;

  const gestureOpts = { capture: true };

  const atScrollTop = atScrollTopForPtr;

  const gestureTargetOk = (e) => {
    const t = e.target;
    if (!t?.closest) return false;
    if (isOutsideScreensGesture(t)) return false;
    return Boolean(t.closest("#screens"));
  };

  const clearTransform = (animate) => {
    if (animate) {
      screens.classList.add("gesture-reset");
      const onDone = () => {
        screens.removeEventListener("transitionend", onDone);
        screens.classList.remove("gesture-reset", "ptr-dragging", "ptr-pulling", "gesture-swipe");
        screens.style.transform = "";
      };
      screens.addEventListener("transitionend", onDone);
    } else {
      screens.classList.remove("gesture-reset", "ptr-dragging", "ptr-pulling", "gesture-swipe");
      screens.style.transform = "";
    }
  };

  const setPullVisual = (rawDy, dragging) => {
    if (!indicator) return;
    lastRawDy = rawDy;
    const beyond = Math.max(0, rawDy - PTR_SLOP);
    const pullPx = Math.min(beyond * 0.62, PTR_MAX_VISUAL);
    const ready = rawDy >= PTR_TRIGGER;
    screens.style.transform = `translateY(${pullPx}px)`;
    screens.classList.toggle("ptr-dragging", Boolean(dragging));
    screens.classList.toggle("ptr-pulling", pullPx > 6);
    indicator.style.setProperty("--pull-rotate", `${Math.min(rawDy / PTR_TRIGGER, 1) * 300}deg`);
    indicator.classList.toggle("pull-refresh--visible", pullPx > 8);
    indicator.classList.toggle("pull-refresh--ready", ready);
    indicator.setAttribute("aria-hidden", pullPx > 8 ? "false" : "true");
    const label = indicator.querySelector(".pull-refresh__label");
    if (label && !ptrRefreshing) {
      if (rawDy < PTR_SLOP) label.textContent = "Потяните вниз";
      else if (!ready) label.textContent = "Ещё чуть-чуть…";
      else label.textContent = "Отпустите — обновить";
    }
  };

  const setSwipeVisual = (rawDx, dragging) => {
    lastRawDx = rawDx;
    const canBack = navHistory.index > 0 || camSheetOpen;
    const canFwd = navHistory.index < navHistory.stack.length - 1;
    let dx = rawDx;
    if (dx > 0 && !canBack) dx *= 0.25;
    if (dx < 0 && !canFwd) dx *= 0.25;
    const tx = Math.sign(dx) * Math.min(Math.abs(dx) * 0.45, SWIPE_MAX_VISUAL);
    screens.style.transform = tx ? `translateX(${tx}px)` : "";
    screens.classList.toggle("gesture-swipe", Boolean(dragging));
  };

  const resetGesture = (animate = true) => {
    axis = null;
    ptrEngaged = false;
    lastRawDy = 0;
    lastRawDx = 0;
    activePointerId = null;
    touchPullActive = false;
    pointerCaptured = false;
    if (indicator) indicator.classList.remove("pull-refresh--loading");
    clearTransform(animate);
  };

  const finishPtr = async () => {
    if (ptrRefreshing) return;
    if (!ptrEngaged || lastRawDy < PTR_TRIGGER) {
      resetGesture(true);
      return;
    }
    ptrRefreshing = true;
    blockClicksUntil = Date.now() + 500;
    indicator?.classList.add("pull-refresh--loading", "pull-refresh--visible");
    const label = indicator?.querySelector(".pull-refresh__label");
    if (label) label.textContent = "Обновление…";
    screens.classList.remove("ptr-dragging");
    try {
      await pullRefreshApp();
    } catch (err) {
      console.error("pull refresh failed", err);
      hideRefreshOverlay();
      toast("Не удалось обновить", "error");
    } finally {
      ptrRefreshing = false;
      resetGesture(true);
    }
  };

  const finishSwipe = () => {
    const dx = lastRawDx;
    resetGesture(true);
    if (Math.abs(dx) < SWIPE_TRIGGER) return;
    if (dx > 0) {
      if (!navGoBack()) {
        const active = document.querySelector(".screen.active")?.id;
        if (active === "screen-cameras" && nav.system) goSections(nav.system);
        else if (active === "screen-sections") goSystems();
      }
    } else if (!navGoForward()) {
      /* некуда вперёд — без сообщения */
    }
  };

  const onPtrUp = (e) => {
    if (touchPullActive) {
      if (e.pointerId === activePointerId) {
        activePointerId = null;
        pointerCaptured = false;
      }
      return;
    }
    if (e.pointerId !== activePointerId) return;
    if (pointerCaptured) {
      try {
        screens.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      pointerCaptured = false;
    }
    if (axis === "y") finishPtr();
    else if (axis === "x") finishSwipe();
    else resetGesture(true);
    activePointerId = null;
    axis = null;
  };

  screens.addEventListener(
    "touchstart",
    (e) => {
      if (ptrRefreshing || ptrGestureBlocked() || e.touches.length !== 1) return;
      if (!gestureTargetOk(e)) return;
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      touchPullActive = atScrollTopForPtr();
    },
    { passive: true, capture: true }
  );

  screens.addEventListener(
    "touchmove",
    (e) => {
      if (!touchPullActive || ptrRefreshing || e.touches.length !== 1) return;
      if (!atScrollTopForPtr()) {
        touchPullActive = false;
        if (axis === "y") resetGesture(false);
        return;
      }
      const dy = e.touches[0].clientY - touchStartY;
      const dx = e.touches[0].clientX - touchStartX;
      if (dy <= 0) return;
      if (Math.abs(dx) > dy * 1.35 && Math.abs(dx) > 22) {
        touchPullActive = false;
        return;
      }
      axis = "y";
      ptrEngaged = dy >= PTR_SLOP;
      if (e.cancelable) e.preventDefault();
      setPullVisual(dy, true);
    },
    { passive: false, capture: true }
  );

  const onTouchEnd = () => {
    if (!touchPullActive) return;
    const wasPull = axis === "y" && ptrEngaged;
    touchPullActive = false;
    activePointerId = null;
    pointerCaptured = false;
    if (wasPull) finishPtr();
    else resetGesture(true);
  };

  screens.addEventListener("touchend", onTouchEnd, { passive: true, capture: true });
  screens.addEventListener("touchcancel", onTouchEnd, { passive: true, capture: true });

  screens.addEventListener(
    "pointerdown",
    (e) => {
      if (touchPullActive || activePointerId != null || ptrRefreshing || ptrGestureBlocked()) return;
      if (e.button !== 0) return;
      if (!gestureTargetOk(e)) return;

      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      axis = null;
      ptrEngaged = false;
      pointerCaptured = false;
      lastRawDy = 0;
      lastRawDx = 0;
    },
    { passive: true, capture: true }
  );

  screens.addEventListener(
    "pointermove",
    (e) => {
      if (touchPullActive || e.pointerId !== activePointerId || ptrRefreshing) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!axis) {
        const nextAxis = chooseGestureAxis(dx, dy);
        if (!nextAxis) return;
        axis = nextAxis;
        if (!pointerCaptured) {
          try {
            screens.setPointerCapture(e.pointerId);
            pointerCaptured = true;
          } catch {
            /* ignore */
          }
        }
      }

      if (axis === "x") {
        if (e.cancelable) e.preventDefault();
        setSwipeVisual(dx, true);
        return;
      }

      if (axis === "y") {
        if (!atScrollTop()) {
          if (!ptrEngaged) {
            resetGesture(false);
            return;
          }
        }
        if (dy <= 0) {
          if (ptrEngaged) setPullVisual(0, true);
          ptrEngaged = false;
          return;
        }
        ptrEngaged = dy >= PTR_SLOP;
        if (e.cancelable) e.preventDefault();
        setPullVisual(dy, true);
      }
    },
    { passive: false, capture: true }
  );

  screens.addEventListener("pointerup", onPtrUp, gestureOpts);
  screens.addEventListener("pointercancel", onPtrUp, gestureOpts);

  screens.addEventListener(
    "click",
    (e) => {
      if (Date.now() < blockClicksUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
}

async function refreshMetrazh() {
  const local = loadCachedMetrazh();
  if (!apiConfigured()) {
    metrazhMap = local;
    scheduleViewRefresh();
    return;
  }
  try {
    const data = await apiGet("metrazh");
    if (data.ok && data.metrazh) {
      let merged = mergeMetrazhMaps(local, normalizeMetrazhMap(data.metrazh));
      const recovered = recoverMetrazhIfRegressed(local, merged);
      if (recovered !== merged) {
        merged = recovered;
        toast("Восстановлен метраж из резервной копии на телефоне", "warn");
      }
      metrazhMap = merged;
      cacheMetrazh(metrazhMap);
    } else {
      metrazhMap = local;
    }
  } catch {
    metrazhMap = local;
  }
  scheduleViewRefresh();
}

const AUTO_REFRESH_MS = 90000;
let swRegistration = null;
let appReloadScheduled = false;

/** Новая версия PWA: активировать SW без перезагрузки посреди работы (обновление — pull-to-refresh). */
function initServiceWorkerUpdates() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (appReloadScheduled) return;
    appReloadScheduled = true;
    toast("Доступна новая версия — потяните вниз для обновления", "queue");
  });

  navigator.serviceWorker
    .register("./sw.js", { updateViaCache: "none", scope: "./" })
    .then((reg) => {
      swRegistration = reg;

      const activateWaiting = (worker) => {
        if (!worker) return;
        worker.postMessage({ type: "SKIP_WAITING" });
      };

      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state !== "installed") return;
          if (navigator.serviceWorker.controller) activateWaiting(worker);
        });
      });

      if (reg.waiting && navigator.serviceWorker.controller) activateWaiting(reg.waiting);

      setInterval(() => reg.update().catch(() => {}), 5 * 60 * 1000);
    })
    .catch(() => {});
}

function initAutoRefresh() {
  const runSilentRefresh = (force = false) => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (!force && now - lastSilentRefreshAt < SILENT_REFRESH_MIN_MS) return;
    lastSilentRefreshAt = now;
    refreshAppData(false).catch(() => {});
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      swRegistration?.update().catch(() => {});
      runSilentRefresh(false);
    }
  });

  window.addEventListener("pageshow", (e) => {
    if (e.persisted) runSilentRefresh(true);
  });

  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    refreshMetrazh().catch(() => {});
    flushQueue(false).catch(() => {});
  }, AUTO_REFRESH_MS);
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
        const k = mapKeyForKind(item.system, item.camera, item.kind || "cable");
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
  scheduleViewRefresh();
  if (showResult) {
    if (!remain.length) toast("Очередь отправлена в таблицу", "success");
    else toast(lastErr || "Не удалось отправить очередь", "error");
  }
  return remain.length === 0;
}

let viewRefreshScheduled = false;

function scheduleViewRefresh() {
  if (viewRefreshScheduled) return;
  viewRefreshScheduled = true;
  requestAnimationFrame(() => {
    viewRefreshScheduled = false;
    refreshCurrentView();
    updateStats();
  });
}

function refreshCurrentView() {
  const active = document.querySelector(".screen.active")?.id;
  if (active === "screen-systems") renderSystems();
  else if (active === "screen-sections") renderSections();
  else if (active === "screen-cameras") renderCameras();
}

function countAllSystemsDone() {
  let done = 0;
  let total = 0;
  for (const s of catalog.systems.filter((x) => x.ready)) {
    const c = countDone(s);
    done += c.done;
    total += c.total;
  }
  return { done, total };
}

function updateStats() {
  let allDone = 0;
  let allTotal = 0;
  const scope =
    nav.system?.ready ? [nav.system] : catalog.systems.filter((x) => x.ready);
  for (const s of scope) {
    const c = countDone(s);
    allDone += c.done;
    allTotal += c.total;
  }
  $("stat-done").textContent = `Готово ${allDone}/${allTotal}`;

  const project = countAllSystemsDone();
  const readiness = $("stat-readiness");
  if (readiness) {
    if (!project.total) {
      readiness.textContent = "Готовность объекта —";
      readiness.className = "stat-readiness";
    } else {
      const pct = Math.round((project.done / project.total) * 100);
      readiness.textContent = `Готовность объекта ${pct}%`;
      readiness.className = "stat-readiness";
      if (pct >= 100) readiness.classList.add("stat-readiness--done");
      else if (pct > 0) readiness.classList.add("stat-readiness--progress");
    }
    readiness.title = project.total
      ? `Камер с метражом: ${project.done} из ${project.total} по всем системам`
      : "Доля камер с введённым метражом по всем системам";
  }

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

function appendSystemPickCard(root, sys, toneIndex) {
  const btn = document.createElement("button");
  btn.type = "button";

  if (sys.ready) {
    const { done, total } = countDone(sys);
    const pct = total ? Math.round((done / total) * 100) : 0;
    btn.className = `pick-card pick-card--system ${pickTone(toneIndex)} ${pickStatus(done, total)}`;
    btn.innerHTML = `
      <span class="pick-card__main">
        <span class="pick-num pick-num--code">${escapeHtml(sys.code)}</span>
        <span class="pick-body">
          <span class="pick-label">${escapeHtml(systemDisplayTitle(sys))}</span>
          <span class="pick-sub">${total} камер</span>
        </span>
        <span class="pick-side">
          <span class="pick-fraction">${done}<span>/${total}</span></span>
          <span class="pick-status">${escapeHtml(statusLabel(done, total))}</span>
        </span>
      </span>
      <span class="pick-bar pick-bar--full"><span style="width:${pct}%"></span></span>
    `;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      openSystem(sys.id);
    });
  } else {
    btn.className = `pick-card pick-card--system pick-card--disabled ${pickTone(toneIndex)}`;
    const sub = sys.cameraCount
      ? `${sys.cameraCount} камер · скоро`
      : sys.note || "Скоро";
    btn.innerHTML = `
      <span class="pick-card__main">
        <span class="pick-num pick-num--code">${escapeHtml(sys.code)}</span>
        <span class="pick-body">
          <span class="pick-label">${escapeHtml(sys.title)}</span>
          <span class="pick-sub pick-sub--warn">${escapeHtml(sub)}</span>
        </span>
        <span class="pick-side">
          <span class="pick-status pick-status--soon">Скоро</span>
        </span>
      </span>
    `;
    btn.addEventListener("click", () =>
      toast(sys.note || "Таблица для этой системы ещё не подключена", "queue")
    );
  }
  root.appendChild(btn);
}

function renderSystems() {
  const root = $("systems-root");
  if (!root) return;
  root.innerHTML = "";
  const list = mergeCatalogSystems(catalog.systems);
  const readyList = list.filter((s) => s.ready);
  const pendingList = list.filter((s) => !s.ready);

  if (readyList.length) {
    const head = document.createElement("p");
    head.className = "systems-block-title";
    head.textContent = "В работе";
    root.appendChild(head);
    readyList.forEach((sys, i) => appendSystemPickCard(root, sys, i));
  }

  if (pendingList.length) {
    const head = document.createElement("p");
    head.className = "systems-block-title systems-block-title--pending";
    head.textContent =
      pendingList.length > 1
        ? `Все системы объекта · ${pendingList.length} скоро`
        : "Скоро на объекте";
    root.appendChild(head);
    pendingList.forEach((sys, i) => appendSystemPickCard(root, sys, readyList.length + i));
  }
}

function renderSections() {
  const root = $("sections-root");
  if (!root) return;
  root.innerHTML = "";
  const sys = findSystemById(nav.system?.id) || nav.system;
  if (!sys?.ready) {
    root.innerHTML =
      '<p class="empty-msg">Система недоступна. Назад → выберите СОТ или БР снова.</p>';
    return;
  }
  nav.system = sys;

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
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      openSection(sec);
    });
    root.appendChild(btn);
  });
}

function renderCameras() {
  const root = $("cameras-root");
  if (!root) return;
  const sys = nav.system;
  if (!sys?.ready) {
    root.innerHTML = "";
    return;
  }
  const sec = nav.section ? bindSectionToSystem(sys, nav.section) : null;
  if (!sec) {
    root.innerHTML =
      '<p class="empty-msg">Секция не найдена. Назад → выберите секцию снова.</p>';
    return;
  }
  if (sec !== nav.section) nav.section = sec;
  const cameras = Array.isArray(sec.cameras) ? sec.cameras : [];
  if (!cameras.length) {
    root.innerHTML = '<p class="empty-msg">Список камер пуст. Назад → секция → снова, или потяните вниз для обновления.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  cameras.forEach((cam, i) => {
    const m = metrazhMap[metrazhKey(sys.id, cam.camera)];
    const g = metrazhMap[gofraKey(sys.id, cam.camera)];
    const done = Boolean(m);
    let badgeHtml = "—";
    if (m && g) badgeHtml = `${escapeHtml(String(m))} / ${escapeHtml(String(g))}`;
    else if (m) badgeHtml = `${escapeHtml(String(m))} м`;
    else if (g) badgeHtml = `г ${escapeHtml(String(g))}`;
    const photo = getPhotoReportDisplay(sys, cam);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `camera-btn ${done ? "camera-btn--done" : "camera-btn--pending"} ${
      i % 2 ? "camera-btn--alt" : ""
    }`;
    btn.innerHTML = `
      <span class="cam-dot" aria-hidden="true"></span>
      <div class="cam-main">
        <div class="code">${escapeHtml(cameraDisplayName(cam))}</div>
        <div class="meta">${escapeHtml(cam.floor)} · ${escapeHtml(cam.place)}</div>
      </div>
      <div class="cam-side">
        <div class="badge ${done ? "done" : "pending"}">${badgeHtml}</div>
        <span class="cam-photo cam-photo--${photo.cls}">${escapeHtml(photo.text)}</span>
      </div>
    `;
    btn.addEventListener("click", () => openCamSheet(sys, sec, cam));
    frag.appendChild(btn);
  });
  root.replaceChildren(frag);
}

function mapMetersForKind(systemId, camera, kind) {
  const key = mapKeyForKind(systemId, camera, kind);
  const existing = metrazhMap[key];
  if (existing == null || existing === "") return null;
  const n = parseInt(String(existing).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function meterInputEl(kind) {
  return $(`input-meter-${kind}`);
}

let meterKeyboardLock = 0;

function isMeterEnterKey(e) {
  return e.key === "Enter" || e.key === "Go" || e.key === "Done" || e.keyCode === 13;
}

function triggerMeterKeyboardAction(kind) {
  const now = Date.now();
  if (now - meterKeyboardLock < 280) return;
  meterKeyboardLock = now;
  readMeterFields();
  updateMetersDisplay();
  if (kind === "cable") {
    meterInputEl("gofra")?.focus();
    return;
  }
  meterInputEl("cable")?.blur();
  meterInputEl("gofra")?.blur();
  if ($("btn-save")?.disabled) {
    toast("Измените кабель или гофру для сохранения", "error");
    return;
  }
  saveMeters();
}

function onMeterKeyboardAction(e, kind) {
  if (!isMeterEnterKey(e)) return;
  e.preventDefault();
  e.stopPropagation();
  triggerMeterKeyboardAction(kind);
}

function initMeterForm() {
  $("meter-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const ae = document.activeElement;
    if (ae?.id === "input-meter-cable") triggerMeterKeyboardAction("cable");
    else triggerMeterKeyboardAction("gofra");
  });
  for (const kind of ["cable", "gofra"]) {
    const inp = meterInputEl(kind);
    inp?.addEventListener("input", () => updateMetersDisplay());
    inp?.addEventListener("keydown", (e) => onMeterKeyboardAction(e, kind));
    inp?.addEventListener("keyup", (e) => onMeterKeyboardAction(e, kind));
  }
  document.querySelectorAll(".meter-field__clear").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const kind = btn.getAttribute("data-clear-kind");
      if (kind === "cable" || kind === "gofra") clearMeterKind(kind);
    });
  });
}

function readMeterFields() {
  for (const kind of ["cable", "gofra"]) {
    const el = meterInputEl(kind);
    if (!el) continue;
    let v = el.value.replace(/\D/g, "").slice(0, 3);
    if (el.value !== v) el.value = v;
    inputValues[kind] = v;
  }
}

function writeMeterFields() {
  for (const kind of ["cable", "gofra"]) {
    const el = meterInputEl(kind);
    if (el) el.value = inputValues[kind] || "";
  }
}

function loadInputValues() {
  if (!selectedCamera) {
    inputValues = { cable: "", gofra: "" };
    inputInitial = { cable: null, gofra: null };
    writeMeterFields();
    return;
  }
  const { system, cam } = selectedCamera;
  for (const kind of ["cable", "gofra"]) {
    const n = mapMetersForKind(system.id, cam.camera, kind);
    inputInitial[kind] = n;
    inputValues[kind] = n != null ? String(n) : "";
  }
  writeMeterFields();
}

function clearMeterKind(kind) {
  inputValues[kind] = "";
  const el = meterInputEl(kind);
  if (el) el.value = "";
  updateMetersDisplay();
}

async function openCamSheet(system, section, cam) {
  selectedCamera = { system, section, cam };
  loadInputValues();
  writeMeterFields();

  $("input-code").textContent = cameraDisplayName(cam);
  $("input-info").textContent = [cam.floor, cam.place, cam.cable].filter(Boolean).join(" · ");

  clearSessionPhotos();
  photoSessionLoading = photosEnabled() && apiConfigured();

  const sheet = $("cam-sheet");
  if (sheet) {
    sheet.hidden = false;
    sheet.setAttribute("aria-hidden", "false");
  }
  camSheetOpen = true;
  document.body.classList.add("cam-sheet-open");

  renderPhotoSession();
  updatePhotoBlockVisibility();
  updateMetersDisplay();
  updatePhotoReportBadge();
  persistNavState("cameras");

  const details = $("photo-details");
  if (details) {
    const photo = getPhotoReportDisplay(system, cam);
    details.open =
      photo.cls === "need" ||
      sessionPhotos.length > 0 ||
      getPhotoCount(system.id, cam.camera) > 0;
  }

  void loadSessionPhotosFromDrive();
  requestAnimationFrame(() => meterInputEl("cable")?.focus());
  pushNavHistory();
}

function closeCamSheet(rerender = true) {
  photoLoadToken++;
  photoSessionLoading = false;
  const sheet = $("cam-sheet");
  if (sheet) {
    sheet.hidden = true;
    sheet.setAttribute("aria-hidden", "true");
  }
  camSheetOpen = false;
  document.body.classList.remove("cam-sheet-open");
  selectedCamera = null;
  if (rerender && nav.system && nav.section) renderCameras();
  persistNavState("cameras");
}

function goNextCamera() {
  if (!selectedCamera) return;
  const { system, section, cam } = selectedCamera;
  const idx = section.cameras.findIndex((c) => c.camera === cam.camera);
  if (idx < 0 || idx >= section.cameras.length - 1) {
    toast("Последняя камера в секции", "queue");
    closeCamSheet();
    return;
  }
  openCamSheet(system, section, section.cameras[idx + 1]);
}

function isMetersValid(n) {
  return n >= 1 && n <= (CONFIG.MAX_METERS || 500);
}

function getPendingMeterSaves() {
  const pending = [];
  for (const kind of ["cable", "gofra"]) {
    const raw = inputValues[kind];
    const init = inputInitial[kind];
    if (raw === "") {
      if (init != null) pending.push({ kind, meters: 0, clearing: true });
      continue;
    }
    const n = parseInt(raw, 10);
    if (!isMetersValid(n)) continue;
    if (n === init) continue;
    pending.push({ kind, meters: n, clearing: false });
  }
  return pending;
}

function hasInvalidMeterInput() {
  for (const kind of ["cable", "gofra"]) {
    const raw = inputValues[kind];
    if (!raw) continue;
    const n = parseInt(raw, 10);
    if (!isMetersValid(n)) return true;
  }
  return false;
}

function updateMetersDisplay() {
  readMeterFields();
  for (const kind of ["cable", "gofra"]) {
    const el = meterInputEl(kind);
    const raw = inputValues[kind];
    if (el) {
      const n = raw ? parseInt(raw, 10) : NaN;
      el.classList.toggle("meter-field__input--invalid", raw !== "" && !isMetersValid(n));
    }
  }

  const pending = getPendingMeterSaves();
  const btn = $("btn-save");
  const invalid = hasInvalidMeterInput();
  btn.disabled = !pending.length || invalid;
  const onlyClear = pending.length > 0 && pending.every((p) => p.clearing);
  btn.textContent = onlyClear ? "Стереть" : "Сохранить";
  btn.classList.toggle("save-btn--clear", onlyClear);
}

function buildMeterPayload(system, cam, item) {
  return {
    system: system.id,
    sheet: system.sheet,
    camera: cam.camera,
    row: cam.row,
    meters: item.meters,
    kind: item.kind,
    clear: item.clearing,
    at: new Date().toISOString(),
  };
}

function applyMeterLocal(systemId, camera, item) {
  const key = mapKeyForKind(systemId, camera, item.kind);
  if (item.clearing) delete metrazhMap[key];
  else metrazhMap[key] = item.meters;
}

function formatSavedMeterParts(items) {
  return items
    .map((p) =>
      p.clearing ? `${kindLabel(p.kind)} стёрт` : `${kindLabel(p.kind)} ${p.meters} м`
    )
    .join(", ");
}

/** После сохранения — закрываем окно, список камер обновлён. */
function afterMetersSaved() {
  loadInputValues();
  writeMeterFields();
  updateMetersDisplay();
  updatePhotoReportBadge();
  if (nav.system && nav.section) renderCameras();
  updateStats();
  persistNavState("cameras");
  closeCamSheet();
}

async function saveMeters() {
  if (!selectedCamera) return;
  readMeterFields();
  const { system, cam } = selectedCamera;
  const pending = getPendingMeterSaves();
  if (!pending.length) {
    toast("Измените кабель или гофру для сохранения", "error");
    return;
  }
  if (hasInvalidMeterInput()) {
    toast(`Введите от 1 до ${CONFIG.MAX_METERS || 500} м или очистите поле (×)`, "error");
    return;
  }

  const payloads = pending.map((item) => buildMeterPayload(system, cam, item));
  const code = formatCameraCode(cam.camera);

  if (!apiConfigured()) {
    for (const item of pending) applyMeterLocal(system.id, cam.camera, item);
    cacheMetrazh(metrazhMap);
    toast(`✓ ${code}: ${formatSavedMeterParts(pending)}`, "success");
    afterMetersSaved();
    return;
  }

  $("btn-save").disabled = true;
  const offline = !navigator.onLine;

  const afterAllLocal = (queued) => {
    for (const item of pending) applyMeterLocal(system.id, cam.camera, item);
    cacheMetrazh(metrazhMap);
    const detail = formatSavedMeterParts(pending);
    const msg = queued
      ? `Сохранено — отправится в сеть (${detail})`
      : `✓ ${code}: ${detail}`;
    toast(msg, queued ? "queue" : "success");
    afterMetersSaved();
  };

  if (offline) {
    setQueue([...getQueue(), ...payloads]);
    afterAllLocal(true);
    $("btn-save").disabled = false;
    return;
  }

  const queued = [];
  let saved = 0;
  let lastErr = "";
  try {
    for (const payload of payloads) {
      try {
        const r = await apiSave(payload);
        if (r.ok) {
          applyMeterLocal(system.id, cam.camera, {
            kind: payload.kind,
            meters: payload.meters,
            clearing: payload.clear,
          });
          saved++;
        } else {
          lastErr = r.error || "Ошибка";
          queued.push(payload);
        }
      } catch (e) {
        lastErr = apiErrorMessage(e);
        queued.push(payload);
      }
    }
    cacheMetrazh(metrazhMap);
    if (queued.length) setQueue([...getQueue(), ...queued]);
    if (!saved) {
      toast(lastErr || "Ошибка", "error");
    } else if (queued.length) {
      afterMetersSaved();
      toast(`Часть сохранена, остальное в очереди`, "queue");
    } else {
      toast(`✓ ${code}: ${formatSavedMeterParts(pending)}`, "success");
      afterMetersSaved();
      void refreshMetrazh();
    }
  } finally {
    $("btn-save").disabled = false;
    updateMetersDisplay();
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
  if (theme !== "light" && theme !== "dark") theme = "light";
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
  applyAppVersionTitle();
  sessionStorage.removeItem("montazh_sw_reloading");
  if (sessionStorage.getItem("montazh_ptr_done")) {
    sessionStorage.removeItem("montazh_ptr_done");
    setTimeout(() => toast("Приложение обновлено", "success"), 400);
  }
  initTheme();
  if (!apiConfigured()) $("setup-banner").classList.add("show");

  $("nav-back").addEventListener("click", goBack);
  $("stat-net").addEventListener("click", async () => {
    if (getQueue().length > 0) {
      showRefreshOverlay("Отправка очереди…");
      try {
        await flushQueue(true);
      } finally {
        hideRefreshOverlay();
      }
      return;
    }
    showRefreshOverlay("Загрузка данных…");
    try {
      await refreshAppData(true);
    } finally {
      hideRefreshOverlay();
    }
  });
  initScreenGestures();
  $("btn-rd-replace")?.addEventListener("click", () => $("rd-input")?.click());
  $("rd-input")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) uploadRdFromFile(file);
  });
  initMeterForm();
  $("cam-sheet-backdrop")?.addEventListener("click", () => closeCamSheet());
  $("cam-sheet-close")?.addEventListener("click", () => closeCamSheet());
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("photo-lightbox")?.hidden) {
      closePhotoLightbox();
      return;
    }
    if (camSheetOpen) closeCamSheet();
  });
  $("btn-next-cam")?.addEventListener("click", goNextCamera);
  $("btn-photo-skip")?.addEventListener("click", markPhotoSkipped);
  const onPhotoPick = (e) => {
    const file = e.target.files?.[0];
    if (file) uploadPhotoFromFile(file);
    e.target.value = "";
  };
  $("btn-photo-camera")?.addEventListener("click", () => $("photo-input-camera")?.click());
  $("btn-photo-gallery")?.addEventListener("click", () => $("photo-input-gallery")?.click());
  $("photo-input-camera")?.addEventListener("change", onPhotoPick);
  $("photo-input-gallery")?.addEventListener("change", onPhotoPick);
  initPhotoLightbox();
  initPhotoDeleteConfirm();
  $("photo-preview")?.addEventListener("click", (e) => {
    const del = e.target.closest(".photo-toolbar__delete, .photo-delete");
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      requestPhotoDelete(parseInt(del.dataset.photoIdx ?? del.getAttribute("data-photo-idx"), 10));
      return;
    }
    const hero = e.target.closest(".photo-hero");
    if (hero) {
      e.preventDefault();
      openPhotoLightbox(parseInt(hero.getAttribute("data-photo-idx"), 10));
    }
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
    loadPhotoStatusMap();
    metrazhMap = loadCachedMetrazh();
    if (!restoreNavState()) goSystems();
    else scheduleViewRefresh();
    resetNavHistoryFromCurrent();
    updateStats();
    void (async () => {
      await syncProjectNameFromApi();
      await refreshMetrazh();
      await flushQueue();
      scheduleViewRefresh();
      updateStats();
    })();
  } catch {
    $("systems-root").innerHTML =
      '<p class="empty-msg">Нет catalog.json — в папке montazh-pwa: npm run export</p>';
  }

  initServiceWorkerUpdates();
  initAutoRefresh();
  if (window.MontazhPush && CONFIG.PUSH_ENABLED !== false) {
    MontazhPush.init({
      apiUrl: CONFIG.API_URL,
      enabled: true,
      toast,
      onDataChange: () => {
        refreshMetrazh().catch(() => {});
        scheduleViewRefresh();
        updateStats();
      },
    });
  }
  setRdUploadUi(false);
  tryResumeRdUpload();

  window.addEventListener("beforeunload", (e) => {
    if (rdUploadActive) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  setInterval(() => {
    if (document.visibilityState === "visible") flushQueue(false).catch(() => {});
  }, 30000);
}

init().catch((err) => {
  console.error("init failed", err);
  const root = $("systems-root");
  if (root) {
    root.innerHTML =
      '<p class="empty-msg">Ошибка запуска. Обновите страницу (Ctrl+Shift+R).</p>';
  }
});

window.addEventListener("error", (e) => {
  console.error("app error", e.error || e.message);
});
