const CACHE = "montazh-v122";
const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/app.js",
  "./config.js",
  "./catalog.json",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/notify-badge.png",
  "./js/push-client.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("push", (event) => {
  let data = { title: "Монтажник", body: "", url: "./index.html", tag: "montazh", urgent: true };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    try {
      if (event.data) data.body = event.data.text();
    } catch {
      /* ignore */
    }
  }

  const origin = self.location.origin;
  const urgent = data.urgent !== false;
  event.waitUntil(
    self.registration.showNotification(data.title || "Монтажник", {
      body: data.body || "",
      icon: origin + "/icons/icon-192.png",
      badge: origin + "/icons/notify-badge.png",
      tag: data.tag || data.url || "montazh",
      data: { url: data.url || "./index.html" },
      vibrate: urgent ? [180, 80, 180, 80, 180] : [100, 50, 100],
      renotify: true,
      silent: false,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "./index.html";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          if ("navigate" in client) {
            return client.navigate(url).then(() => client.focus());
          }
          client.postMessage({ type: "notify-navigate", url });
          return client.focus();
        }
      }
      return self.clients.openWindow(new URL(url, self.location.origin).href);
    })
  );
});

function isAppAsset(pathname) {
  return (
    pathname.endsWith(".css") ||
    pathname.endsWith(".js") ||
    pathname.endsWith(".html") ||
    pathname.endsWith("/")
  );
}

function isDataAsset(pathname) {
  return pathname.endsWith(".json") || pathname.includes("config.js");
}

/** Сначала сеть — актуальные catalog.json и скрипты; офлайн — из кэша. */
function networkFirst(request) {
  return fetch(request)
    .then((res) => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(request, clone));
      }
      return res;
    })
    .catch(() => caches.match(request));
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin.includes("script.google.com")) {
    return;
  }
  if (e.request.method !== "GET") return;

  if (isAppAsset(url.pathname) || isDataAsset(url.pathname)) {
    e.respondWith(networkFirst(e.request));
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        fetch(e.request).then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
          return res;
        })
    )
  );
});
