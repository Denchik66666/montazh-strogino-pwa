/**
 * Web Push для montazh-pwa — схема как money-tracker:
 * push (SW) + poll (вкладка открыта), broadcast всем подписчикам.
 */
(function () {
  const INSTALLER_KEY = "montazh_installer_name";
  const PUSH_OK_KEY = "montazh_push_ok";
  const POLL_SINCE_KEY = "montazh_notify_since";
  const SEEN_IDS_KEY = "montazh_notify_seen";

  let pollTimer = null;
  let seenIds = new Set();
  let sinceIso = "";
  let deps = { apiUrl: "", enabled: true, toast: null, onDataChange: null };

  function toast(msg, kind) {
    if (typeof deps.toast === "function") deps.toast(msg, kind);
  }

  function apiConfigured() {
    return Boolean(String(deps.apiUrl || "").trim());
  }

  function getInstallerName() {
    return String(localStorage.getItem(INSTALLER_KEY) || "").trim() || "Монтажник";
  }

  function setInstallerName(name) {
    const n = String(name || "").trim().slice(0, 40);
    if (n) localStorage.setItem(INSTALLER_KEY, n);
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function apiGet(action, params) {
    const url = new URL(deps.apiUrl);
    url.searchParams.set("action", action);
    for (const [k, v] of Object.entries(params || {})) {
      if (v != null && v !== "") url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) throw new Error("Сеть");
    return res.json();
  }

  async function apiPost(body) {
    const res = await fetch(deps.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("Сеть");
    return res.json();
  }

  async function fetchVapidPublicKey() {
    const fromConfig = String(window.APP_CONFIG?.PUSH_VAPID_PUBLIC || "").trim();
    if (fromConfig) return fromConfig;
    try {
      const r = await apiGet("pushVapid");
      if (r.ok && r.publicKey) return String(r.publicKey).trim();
    } catch {
      /* Apps Script ещё без Notify.gs */
    }
    throw new Error("Нет VAPID — обновите приложение или см. PUSH.md");
  }

  async function getSwRegistration() {
    if (!("serviceWorker" in navigator)) return null;
    return navigator.serviceWorker.ready;
  }

  async function showSystemNotification(title, body, url, tag, urgent) {
    const reg = await getSwRegistration();
    if (!reg) return;
    const origin = self.location?.origin || window.location.origin;
    await reg.showNotification(title || "Монтажник", {
      body: body || "",
      icon: origin + "/icons/icon-192.png",
      badge: origin + "/icons/notify-badge.png",
      tag: tag || url || "montazh",
      data: { url: url || "./index.html" },
      vibrate: urgent !== false ? [180, 80, 180] : [100, 50, 100],
      renotify: true,
      silent: false,
    });
  }

  function loadSeenIds() {
    try {
      const raw = sessionStorage.getItem(SEEN_IDS_KEY);
      if (raw) JSON.parse(raw).forEach((id) => seenIds.add(id));
    } catch {
      /* ignore */
    }
    sinceIso = localStorage.getItem(POLL_SINCE_KEY) || new Date(Date.now() - 60000).toISOString();
  }

  function persistSince(iso) {
    sinceIso = iso;
    localStorage.setItem(POLL_SINCE_KEY, iso);
  }

  function markSeen(id) {
    seenIds.add(id);
    try {
      const arr = [...seenIds].slice(-200);
      sessionStorage.setItem(SEEN_IDS_KEY, JSON.stringify(arr));
    } catch {
      /* ignore */
    }
  }

  function showInAppBanner(title, body) {
    const el = document.getElementById("notify-banner");
    if (!el) return;
    el.hidden = false;
    el.querySelector(".notify-banner__title").textContent = title || "Обновление";
    el.querySelector(".notify-banner__body").textContent = body || "";
  }

  function hideInAppBanner() {
    const el = document.getElementById("notify-banner");
    if (el) el.hidden = true;
  }

  async function handleNewEvent(ev) {
    if (!ev?.id || seenIds.has(ev.id)) return;
    markSeen(ev.id);

    const myName = getInstallerName();
    const isSelf = ev.actor && ev.actor === myName;
    const hidden = document.hidden;

    if (hidden || !isSelf) {
      await showSystemNotification(ev.title, ev.body, ev.url, ev.kind + ":" + ev.id, true);
    }

    if (!hidden) {
      if (!isSelf) {
        showInAppBanner(ev.title, ev.body);
        toast(ev.body || ev.title, "queue");
      }
      if (typeof deps.onDataChange === "function") {
        deps.onDataChange(ev.kind);
      }
    }
  }

  async function pollOnce() {
    if (!apiConfigured()) return;
    try {
      const r = await apiGet("notifyPoll", { since: sinceIso });
      if (!r.ok) return;
      if (r.serverTime) persistSince(r.serverTime);
      for (const ev of r.events || []) {
        await handleNewEvent(ev);
      }
    } catch {
      /* офлайн */
    }
  }

  function startPoll() {
    stopPoll();
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      pollOnce();
    };
    tick();
    pollTimer = setInterval(tick, 8000);
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function registerWebPush(force) {
    if (!deps.enabled || !apiConfigured()) {
      toast("Подключите таблицу в config.js", "error");
      return false;
    }
    if (!("Notification" in window) || !("PushManager" in window)) {
      toast("Браузер не поддерживает push", "error");
      return false;
    }

    let perm = Notification.permission;
    if (perm === "default" || force) {
      perm = await Notification.requestPermission();
    }
    if (perm !== "granted") {
      toast("Разрешите уведомления в настройках браузера", "warn");
      return false;
    }

    const publicKey = await fetchVapidPublicKey();
    const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    const name = getInstallerName();
    const r = await apiPost({
      action: "pushSubscribe",
      subscription: sub.toJSON(),
      label: name,
    });
    if (!r.ok) throw new Error(r.error || "Подписка не сохранена — обновите Apps Script (Notify.gs)");

    localStorage.setItem(PUSH_OK_KEY, "1");
    updatePushUi(true);
    if (r.count != null) {
      toast(`Push включён · подписчиков: ${r.count}`, "success");
    } else {
      toast("Push включён — все увидят изменения", "success");
    }
    return true;
  }

  async function sendTestPush() {
    const r = await apiPost({ action: "pushTest", label: getInstallerName() });
    if (!r.ok) throw new Error(r.error || "Ошибка");
    toast("Тест отправлен всем подписчикам", "success");
  }

  function updatePushUi(on) {
    const btn = document.getElementById("btn-push");
    if (!btn) return;
    btn.classList.toggle("pill--push-on", Boolean(on));
    btn.title = on ? "Push включён · нажмите для теста" : "Включить push-уведомления";
    btn.textContent = on ? "🔔" : "🔕";
  }

  function promptInstallerName() {
    if (getInstallerName() !== "Монтажник") return;
    const name = window.prompt("Ваше имя для уведомлений (кто что изменил):", "");
    if (name && String(name).trim()) setInstallerName(String(name).trim());
  }

  function bindUi() {
    const btn = document.getElementById("btn-push");
    if (btn) {
      btn.addEventListener("click", async () => {
        try {
          if (localStorage.getItem(PUSH_OK_KEY) === "1") {
            await sendTestPush();
          } else {
            promptInstallerName();
            await registerWebPush(true);
          }
        } catch (e) {
          toast(String(e.message || e), "error");
        }
      });
    }
    document.getElementById("notify-banner-close")?.addEventListener("click", hideInAppBanner);

    navigator.serviceWorker?.addEventListener("message", (e) => {
      if (e.data?.type === "notify-navigate") {
        hideInAppBanner();
        if (typeof deps.onDataChange === "function") deps.onDataChange("navigate");
      }
    });
  }

  async function init(options) {
    deps = { ...deps, ...options };
    if (!deps.enabled || !apiConfigured()) return;

    loadSeenIds();
    bindUi();
    promptInstallerName();

    if (localStorage.getItem(PUSH_OK_KEY) === "1") {
      updatePushUi(true);
      try {
        await registerWebPush(false);
      } catch {
        localStorage.removeItem(PUSH_OK_KEY);
        updatePushUi(false);
      }
    } else {
      updatePushUi(false);
      setTimeout(() => {
        if (Notification.permission === "default") {
          toast("Включите 🔔 — чтобы видеть изменения всей бригады", "queue");
        }
      }, 2500);
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pollOnce();
    });
    startPoll();
  }

  window.MontazhPush = {
    init,
    getInstallerName,
    setInstallerName,
    registerWebPush,
    showSystemNotification,
    pollOnce,
  };
})();
