const CONFIG = window.APP_CONFIG || {};
const QUEUE_KEY = "montazh_pending_queue";
const METRAZH_CACHE_KEY = "montazh_metrazh_cache";
const NAV_STATE_KEY = "montazh_nav_state";
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
/** @type {"cable"|"gofra"} */
let inputActiveKind = "cable";
/** @type {{ cable: string, gofra: string }} */
let inputValues = { cable: "", gofra: "" };
/** @type {{ cable: number|null, gofra: number|null }} */
let inputInitial = { cable: null, gofra: null };
const MAX_SESSION_PHOTOS = 5;
let photoLightboxIndex = 0;
/** @type {{ previewUrl: string, driveUrl?: string, fileId?: string }[]} */
let sessionPhotos = [];

const $ = (id) => document.getElementById(id);

/** Совпадает с normalizeCameraCode_ в Apps Script (BK в таблице / ВК в приложении). */
function normalizeCameraCode(code) {
  const s = String(code || "").trim();
  // БР: "ВК ММС №5" / "ВК ПВН №23" / "ВК16" → BK5 / BK23 / BK16
  const mBr = s.match(/^[\u0412\u0432Bb][\u041a\u043aKk]\s*(?:[^\d№]*?)№?\s*(\d+)\s*$/i);
  if (mBr) return `BK${mBr[1]}`;
  const m = s.match(/^([\u0412\u0432Bb])([\u041a\u043aKk])(.*)$/);
  if (m) return `BK${m[3]}`;
  return s;
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
  if (r && r.error) return String(r.error);
  const m = err && err.message ? String(err.message) : "";
  if (/failed to fetch|networkerror|load failed|сеть/i.test(m)) {
    return "Не удалось загрузить PDF. Проверьте интернет и повторите";
  }
  return m || "Не удалось загрузить PDF";
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
  for (const p of sessionPhotos) {
    if (p.previewUrl?.startsWith("blob:") || p.previewUrl?.startsWith("data:")) continue;
    if (p.thumbDataUrl) {
      p.previewUrl = p.thumbDataUrl;
      changed = true;
      continue;
    }
    if (p._hydrating || !p.fileId) continue;
    p._hydrating = true;
    const blobUrl = await fetchPhotoPreviewBlob(p.fileId);
    p._hydrating = false;
    if (blobUrl) {
      p.previewUrl = blobUrl;
      changed = true;
    }
  }
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
  url.searchParams.set("kind", payload.kind || "cable");
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error("Сеть");
  return parseApiResponse(res);
}

const PHOTO_CHUNK_SIZE = 500;
const RD_CHUNK_SIZE = 50000;

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

async function apiPostJson(body) {
  const res = await fetch(CONFIG.API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Сеть");
  return parseApiResponse(res);
}

async function apiUploadRd(payload) {
  const { data, system, systemCode, projectName, fileName } = payload;

  if (data.length <= 6 * 1024 * 1024) {
    try {
      const one = await apiPostJson({
        action: "rd",
        system,
        systemCode,
        projectName,
        fileName,
        data,
      });
      if (one.ok || one.error) return one;
    } catch {
      /* по частям */
    }
  }

  const uploadId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const total = Math.max(1, Math.ceil(data.length / RD_CHUNK_SIZE));
  let last = null;

  for (let part = 0; part < total; part++) {
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
    }
    last = await apiPostJson(body);
    if (!last.ok && !last.pending) throw new Error(last.error || "Загрузка PDF");
    if (typeof apiUploadRd.onProgress === "function") {
      apiUploadRd.onProgress(part + 1, total);
    }
  }
  return last;
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
  return (CONFIG.PHOTO_MAX_MB || 10) * 1024 * 1024;
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

/** До PHOTO_MAX_MB — оригинал; больше — сжатие до лимита. */
async function preparePhotoForUpload(file) {
  const maxBytes = photoMaxBytes();
  if (file.size <= maxBytes) {
    return { blob: file, mimeType: photoMimeType(file), compressed: false };
  }
  const tries = [
    [2560, 0.85],
    [2048, 0.82],
    [2048, 0.7],
    [1600, 0.65],
    [1280, 0.58],
    [1280, 0.48],
    [1024, 0.45],
    [800, 0.4],
  ];
  let lastBlob = null;
  for (const [side, q] of tries) {
    lastBlob = await compressImageToBlob(file, side, q);
    if (lastBlob.size <= maxBytes) {
      return { blob: lastBlob, mimeType: "image/jpeg", compressed: true };
    }
  }
  throw new Error(
    `Не удалось уместить фото в ${CONFIG.PHOTO_MAX_MB || 10} МБ — попробуйте другой снимок`
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
        thumbDataUrl: p.thumbDataUrl || "",
        previewUrl: p.thumbDataUrl || "",
        driveUrl: p.url,
        fileId: p.fileId,
        fromDrive: true,
      });
    }
    renderPhotoSession();
    hydrateSessionPhotoPreviews();
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
    status.textContent = `До ${MAX_SESSION_PHOTOS} фото · до 10 МБ, больше — сожмём · превью — просмотр`;
    preview.classList.add("photo-preview--empty");
    preview.innerHTML = '<span class="photo-preview-empty">Нет фото</span>';
    return;
  }

  status.innerHTML = atMax
    ? `<strong>${n}/${MAX_SESSION_PHOTOS}</strong> · нажмите превью — просмотр · <strong>×</strong> — удалить`
    : `<strong>${n}/${MAX_SESSION_PHOTOS}</strong> · превью — просмотр · <strong>×</strong> — удалить`;

  preview.classList.remove("photo-preview--empty");
  preview.innerHTML = "";
  sessionPhotos.forEach((p, i) => {
    const wrap = document.createElement("div");
    wrap.className = "photo-thumb-wrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "photo-thumb";
    btn.dataset.photoIdx = String(i);
    btn.setAttribute("aria-label", `Открыть фото ${i + 1}`);

    const img = document.createElement("img");
    img.alt = `фото ${i + 1}`;
    img.loading = "lazy";
    img.decoding = "async";
    const src = photoPreviewFromItem(p);
    if (src) img.src = src;
    img.addEventListener("error", async () => {
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
    });

    btn.appendChild(img);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "photo-delete";
    del.dataset.photoIdx = String(i);
    del.setAttribute("aria-label", `Удалить фото ${i + 1}`);
    del.textContent = "×";

    wrap.appendChild(btn);
    wrap.appendChild(del);
    preview.appendChild(wrap);
  });
}

function updatePhotoLightboxView() {
  const p = sessionPhotos[photoLightboxIndex];
  const box = $("photo-lightbox");
  const img = $("photo-lightbox-img");
  const counter = $("photo-lightbox-counter");
  const drive = $("photo-lightbox-drive");
  const prev = $("photo-lightbox-prev");
  const next = $("photo-lightbox-next");
  if (!box || !img || !p) return;

  img.src = photoPreviewFromItem(p);
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
  updatePhotoLightboxView();
  const box = $("photo-lightbox");
  if (box) {
    box.hidden = false;
    document.body.classList.add("photo-lightbox-open");
  }
}

function closePhotoLightbox() {
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
  updatePhotoLightboxView();
}

function initPhotoLightbox() {
  $("photo-lightbox-close")?.addEventListener("click", closePhotoLightbox);
  $("photo-lightbox")?.addEventListener("click", (e) => {
    if (e.target.id === "photo-lightbox") closePhotoLightbox();
  });
  $("photo-lightbox-prev")?.addEventListener("click", (e) => {
    e.stopPropagation();
    stepPhotoLightbox(-1);
  });
  $("photo-lightbox-next")?.addEventListener("click", (e) => {
    e.stopPropagation();
    stepPhotoLightbox(1);
  });
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
    if (!$("photo-lightbox")?.hidden) {
      if (!sessionPhotos.length) closePhotoLightbox();
      else {
        photoLightboxIndex = Math.min(index, sessionPhotos.length - 1);
        updatePhotoLightboxView();
      }
    }
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
  if (!String(file.type || "").toLowerCase().startsWith("image/")) {
    toast("Нужен файл изображения", "error");
    return;
  }

  const status = $("photo-status");
  setPhotoButtonsDisabled(true);
  const needsCompress = file.size > photoMaxBytes();
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
      renderPhotoSession();
      const savedMsg = prepared.compressed
        ? `Фото ${sessionPhotos.length} (сжато) · ${formatCameraCode(cam.camera)}`
        : `Фото ${sessionPhotos.length} сохранено · ${formatCameraCode(cam.camera)}`;
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
  const raw = cam && typeof cam.label === "string" ? cam.label.trim() : "";
  if (raw) return raw;
  return formatCameraCode(cam?.camera || "");
}

/** На экране всегда кириллица ВК; в таблице и API — BK */
function formatCameraCode(code) {
  const n = normalizeCameraCode(code);
  return n.replace(/^BK\s*(?=\d)/i, "ВК ");
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
  persistNavState(name);
  syncRdPanelVisibility();
}

/** Панель РД под шапкой — видна в системе (секции / камеры / ввод). */
function syncRdPanelVisibility() {
  const panel = $("rd-panel");
  if (!panel) return;
  if (!nav.system?.ready) {
    panel.hidden = true;
    return;
  }
  const active = document.querySelector(".screen.active")?.id;
  panel.hidden = active === "screen-systems";
}

function findSystemById(systemId) {
  return catalog.systems.find((s) => s.id === systemId) || null;
}

function findSectionById(system, sectionId) {
  return system?.sections?.find((s) => s.id === sectionId) || null;
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
  if (!nav.system) return;
  const sys = findSystemById(nav.system.id);
  if (!sys?.ready) {
    goSystems();
    return;
  }
  nav.system = sys;
  if (!nav.section) return;
  const sec = findSectionById(sys, nav.section.id);
  if (!sec) {
    nav.section = null;
    goSections(sys);
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
    if (screenName === "input" && selectedCamera) {
      state.camera = selectedCamera.cam.camera;
    }
    sessionStorage.setItem(NAV_STATE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota */
  }
}

/** Вернуть экран после перезагрузки PWA (обновление SW). */
function restoreNavState() {
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
      goCameras(sec);
      return true;
    }
    if (state.screen === "input" && state.camera) {
      const cam = findCameraInSection(sec, state.camera);
      if (!cam) {
        goCameras(sec);
        return true;
      }
      nav.system = sys;
      nav.section = sec;
      openInput(sys, sec, cam);
      return true;
    }
    goSystems();
    return true;
  } catch {
    return false;
  }
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

let rdViewUrl = "";

async function refreshRdPanel(sys) {
  const panel = $("rd-panel");
  const btnOpen = $("btn-rd-open");
  const btnUpload = $("btn-rd-upload");
  const status = $("rd-status");
  if (!panel || !btnUpload) return;

  rdViewUrl = "";
  btnOpen.hidden = true;
  btnOpen.onclick = null;

  if (!sys?.ready) {
    panel.hidden = true;
    return;
  }
  syncRdPanelVisibility();
  if (panel.hidden) return;

  if (!apiConfigured()) {
    status.textContent = "РД: подключите таблицу в config.js";
    btnUpload.disabled = true;
    return;
  }
  btnUpload.disabled = false;
  status.textContent = "Проверка РД…";

  try {
    const r = await apiGet("rdLink", {
      system: sys.id,
      systemCode: sys.code,
      projectName: projectFolderName(),
    });
    if (r.ok && (r.viewUrl || r.url)) {
      rdViewUrl = r.viewUrl || r.url;
      btnOpen.hidden = false;
      btnOpen.onclick = () => window.open(rdViewUrl, "_blank", "noopener,noreferrer");
      status.textContent = r.name ? `На Диске: ${r.name}` : "РД загружена";
    } else {
      status.textContent = r.error || "РД не загружена — выберите PDF";
    }
  } catch {
    status.textContent = "РД не загружена — проверьте интернет";
  }
}

async function uploadRdFromFile(file) {
  const sys = nav.system;
  if (!sys?.ready) return;
  if (!apiConfigured()) {
    toast("Подключите таблицу в config.js", "error");
    return;
  }
  if (!navigator.onLine) {
    toast("Нужен интернет для загрузки РД", "error");
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

  const status = $("rd-status");
  const btnUpload = $("btn-rd-upload");
  const btnOpen = $("btn-rd-open");
  btnUpload.disabled = true;
  btnOpen.hidden = true;
  apiUploadRd.onProgress = (n, total) => {
    status.textContent = total > 1 ? `Загрузка PDF… ${n}/${total}` : "Загрузка PDF…";
  };

  try {
    const data = await blobToBase64(file);
    const r = await apiUploadRd({
      system: sys.id,
      systemCode: sys.code,
      projectName: projectFolderName(),
      fileName: file.name,
      data,
    });
    if (r.ok) {
      toast(`РД загружена: ${r.name || file.name}`, "success");
      await refreshRdPanel(sys);
    } else {
      const msg = rdApiErrorMessage(null, r);
      toast(msg, "error");
      status.textContent = msg;
    }
  } catch (err) {
    const msg = rdApiErrorMessage(err, null);
    toast(msg, "error");
    status.textContent = msg;
  } finally {
    apiUploadRd.onProgress = null;
    btnUpload.disabled = false;
    $("rd-input").value = "";
    if (!rdViewUrl) await refreshRdPanel(sys);
  }
}

function goSystems() {
  nav.system = null;
  nav.section = null;
  const rdPanel = $("rd-panel");
  if (rdPanel) rdPanel.hidden = true;
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
  refreshRdPanel(system);
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

async function loadCatalog(bustCache = false) {
  const url = bustCache ? `catalog.json?t=${Date.now()}` : "catalog.json";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("Нет catalog.json");
    catalog = await res.json();
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
const SILENT_REFRESH_MIN_MS = 60000;

async function refreshAppData(showToast = false) {
  if (refreshAppDataInFlight) return refreshAppDataInFlight;
  refreshAppDataInFlight = (async () => {
    try {
      await loadCatalog(true);
    } catch {
      /* офлайн — остаётся текущий каталог */
    }
    await syncProjectNameFromApi();
    await refreshMetrazh();
    await flushQueue(false);
    refreshCurrentView();
    updateStats();
    const active = document.querySelector(".screen.active")?.id;
    if (active === "screen-input" && selectedCamera) {
      await loadSessionPhotosFromDrive();
    }
    const activeName = document.querySelector(".screen.active")?.id?.replace("screen-", "");
    if (activeName) updateHeader(activeName);
    if (showToast) toast("Данные обновлены", "success");
  })();
  try {
    await refreshAppDataInFlight;
  } finally {
    refreshAppDataInFlight = null;
  }
}

function getActiveScrollEl() {
  const screen = document.querySelector(".screen.active");
  if (!screen) return null;
  return screen.querySelector(".tile-grid, .camera-list") || screen;
}

function initPullToRefresh() {
  const indicator = $("pull-refresh");
  if (!indicator) return;

  const THRESH = 88;
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
    if (!scrollEl || scrollEl.scrollTop > 0) return;
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
      await refreshAppData(false);
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
    refreshCurrentView();
    updateStats();
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
  refreshCurrentView();
  updateStats();
}

const AUTO_REFRESH_MS = 45000;
let swRegistration = null;
let appReloadScheduled = false;

/** Новая версия PWA: активировать service worker и один раз перезагрузить страницу. */
function initServiceWorkerUpdates() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (appReloadScheduled) return;
    appReloadScheduled = true;
    window.location.reload();
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
  else if (active === "screen-input" && nav.system && nav.section) renderCameras();
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
    const g = metrazhMap[gofraKey(sys.id, cam.camera)];
    const done = Boolean(m);
    let badgeHtml = "ввод";
    if (m && g) badgeHtml = `${escapeHtml(String(m))} / ${escapeHtml(String(g))}`;
    else if (m) badgeHtml = `${escapeHtml(String(m))} м`;
    else if (g) badgeHtml = `г ${escapeHtml(String(g))}`;
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
      <div class="badge ${done ? "done" : "pending"}">${badgeHtml}</div>
    `;
    btn.addEventListener("click", () => openInput(sys, sec, cam));
    root.appendChild(btn);
  });
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

function setInputActiveKind(kind, focusInput = true) {
  inputActiveKind = kind === "gofra" ? "gofra" : "cable";
  document.querySelectorAll(".meter-field").forEach((el) => {
    const active = el.dataset.kind === inputActiveKind;
    el.classList.toggle("meter-field--active", active);
  });
  if (focusInput) {
    const el = meterInputEl(inputActiveKind);
    if (!el) return;
    el.focus();
    try {
      const len = el.value.length;
      el.setSelectionRange(len, len);
    } catch {
      /* iOS */
    }
  }
}

function updateOverwriteHint() {
  const hint = $("overwrite-hint");
  if (!hint) return;
  hint.classList.remove("show");
  hint.textContent = "";
}

function openInput(system, section, cam) {
  selectedCamera = { system, section, cam };
  inputActiveKind = "cable";
  loadInputValues();
  setInputActiveKind("cable");

  $("input-system").textContent = `${catalog.site.name} · ${system.code} · ${section.name}`;
  $("input-code").textContent = cameraDisplayName(cam);
  $("input-info").textContent = [cam.floor, cam.place, cam.cable].filter(Boolean).join(" · ");

  updateOverwriteHint();

  clearSessionPhotos();
  renderPhotoSession();
  updatePhotoBlockVisibility();
  updateMetersDisplay();
  showScreen("input");
  loadSessionPhotosFromDrive();
  requestAnimationFrame(() => setInputActiveKind("cable", true));
}

function isMetersValid(n) {
  if (n === 0) return true;
  return n >= 1 && n <= (CONFIG.MAX_METERS || 500);
}

function getPendingMeterSaves() {
  const pending = [];
  for (const kind of ["cable", "gofra"]) {
    const raw = inputValues[kind];
    if (!raw) continue;
    const n = parseInt(raw, 10);
    if (!isMetersValid(n)) continue;
    const init = inputInitial[kind];
    if (n === 0) {
      if (init == null) continue;
      pending.push({ kind, meters: 0, clearing: true });
      continue;
    }
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
    const hint = $(`hint-${kind}`);
    const field = document.querySelector(`.meter-field[data-kind="${kind}"]`);
    const raw = inputValues[kind];
    const init = inputInitial[kind];
    if (el) {
      const n = raw ? parseInt(raw, 10) : NaN;
      el.classList.toggle("meter-field__input--clear", raw !== "" && n === 0);
      el.classList.toggle("meter-field__input--invalid", raw !== "" && !isMetersValid(n));
    }
    if (hint) {
      hint.textContent =
        init != null ? `В таблице: ${init} м` : "Пусто — введите или оставьте";
    }
    if (field) {
      field.classList.toggle(
        "meter-field--pending-clear",
        Boolean(raw) && parseInt(raw, 10) === 0 && init != null
      );
    }
  }

  const pending = getPendingMeterSaves();
  const btn = $("btn-save");
  const invalid = hasInvalidMeterInput();
  btn.disabled = !pending.length || invalid;
  const onlyClear = pending.length > 0 && pending.every((p) => p.clearing);
  btn.textContent = onlyClear ? "СТЕРЕТЬ" : "СОХРАНИТЬ";
  btn.classList.toggle("save-btn--clear", onlyClear);
}

function numpadHandler(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  const digit = btn.dataset.digit;
  const action = btn.dataset.action;
  let val = inputValues[inputActiveKind];
  if (digit !== undefined) {
    if (val.length >= 3) return;
    val = val === "0" ? digit : val + digit;
  } else if (action === "back") val = val.slice(0, -1);
  else if (action === "clear") val = "";
  inputValues[inputActiveKind] = val;
  const inp = meterInputEl(inputActiveKind);
  if (inp) inp.value = val;
  updateMetersDisplay();
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

/** После сохранения — остаёмся на камере, поля = актуальные значения из таблицы. */
function afterMetersSaved() {
  loadInputValues();
  updateOverwriteHint();
  updateMetersDisplay();
  if (nav.system && nav.section) renderCameras();
  updateStats();
  persistNavState("input");
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
    toast(`Введите 0 (стереть) или от 1 до ${CONFIG.MAX_METERS || 500} м`, "error");
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
      await refreshMetrazh();
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
  initTheme();
  if (!apiConfigured()) $("setup-banner").classList.add("show");

  $("nav-back").addEventListener("click", goBack);
  $("stat-net").addEventListener("click", () => {
    if (getQueue().length > 0) flushQueue(true);
    else refreshAppData(true);
  });
  initPullToRefresh();
  $("btn-rd-upload")?.addEventListener("click", () => $("rd-input")?.click());
  $("rd-input")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) uploadRdFromFile(file);
  });
  for (const kind of ["cable", "gofra"]) {
    const inp = meterInputEl(kind);
    inp?.addEventListener("input", () => updateMetersDisplay());
    inp?.addEventListener("focus", () => setInputActiveKind(kind, false));
    inp?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (kind === "cable") setInputActiveKind("gofra", true);
        else saveMeters();
      }
    });
  }
  document.querySelectorAll(".meter-field").forEach((field) => {
    field.addEventListener("click", (e) => {
      if (e.target.closest("input")) return;
      const kind = field.dataset.kind;
      if (!kind) return;
      setInputActiveKind(kind);
    });
  });
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
  initPhotoLightbox();
  $("photo-preview")?.addEventListener("click", (e) => {
    const del = e.target.closest(".photo-delete");
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      deleteSessionPhoto(parseInt(del.getAttribute("data-photo-idx"), 10));
      return;
    }
    const thumb = e.target.closest(".photo-thumb");
    if (thumb) {
      e.preventDefault();
      openPhotoLightbox(parseInt(thumb.getAttribute("data-photo-idx"), 10));
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
    await syncProjectNameFromApi();
    metrazhMap = loadCachedMetrazh();
    await refreshMetrazh();
    await flushQueue();
    if (!restoreNavState()) goSystems();
  } catch {
    $("systems-root").innerHTML =
      '<p class="empty-msg">Нет catalog.json — в папке montazh-pwa: npm run export</p>';
  }

  initServiceWorkerUpdates();
  initAutoRefresh();

  setInterval(() => {
    if (document.visibilityState === "visible") flushQueue(false).catch(() => {});
  }, 30000);
}

init();
