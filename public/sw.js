// Farkle's service worker: turn alerts for online games (Web Push). Nothing is cached here, so
// it never gets between the page and the network; a new deploy is live on the next load.
//
// The Room sends {title, body, url, tag}: see PushNotice in src/net/protocol.ts.

self.addEventListener("install", () => {
  // No cache to migrate, so a new version can take over at once.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let notice = {};
  try {
    notice = event.data ? event.data.json() : {};
  } catch {
    // Not JSON: show the generic alert below rather than nothing (a push must show something).
  }
  event.waitUntil(
    self.registration.showNotification(notice.title || "Farkle", {
      body: notice.body || "It's your turn.",
      // One alert per game: a newer one replaces the last.
      tag: notice.tag || "farkle",
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      data: { url: notice.url || "/" },
    }),
  );
});

// Opens the game the alert is about, reusing the app if it's already open.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url === url) || windows[0];
      if (!open) return self.clients.openWindow(url);
      return (open.url === url ? Promise.resolve(open) : open.navigate(url)).then((client) => (client || open).focus());
    }),
  );
});
