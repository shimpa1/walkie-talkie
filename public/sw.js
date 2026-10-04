const CACHE = "walkie-talkie-shell-v9";
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/voice.js",
  "/token.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Bypass the HTTP cache so a new worker never stores a shell file the
      // browser kept from before the deploy.
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  // Sign-in redirects to GitHub and back must reach the network untouched.
  if (url.pathname.startsWith("/auth/")) return;

  // Network first, revalidating past the HTTP cache, so every launch runs the
  // deployed shell; the cached copy only answers when the network does not.
  event.respondWith(
    fetch(request.url, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) return caches.match(request).then((cached) => cached || response);
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error())),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Walkie-Talkie";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: typeof data.url === "string" && data.url ? data.url : "/" },
  };
  if (typeof data.tag === "string" && data.tag) options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  const url = new URL(target, self.location.origin).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client && client.url.startsWith(self.location.origin)) {
            if ("navigate" in client) client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
