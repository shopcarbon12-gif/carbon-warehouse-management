/* CarbonWMS service worker — phone/computer alerts only (owner 2026-10-19).
 *
 * Shows the push sent by lib/server/web-push.ts (Shopify orders, Studio
 * night-batch results, store visitors), tells every open WMS page to play its sound, and opens
 * the right page when the notification is tapped. No caching, no offline mode:
 * the WMS is always loaded from the network exactly as before.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "CarbonWMS", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "CarbonWMS";
  const options = {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    /* The Carbon hexagon (owner 2026-10-21): white on black for the picture,
       a white outline for the status bar (Android draws badges as a silhouette). */
    icon: "/carbon-notify-icon.png",
    badge: "/carbon-notify-badge.png",
    /* Stays until it is dismissed (computers hide alerts after a few seconds
       otherwise; phones keep them in the notification list anyway). Each
       alert has its own tag, so they stack instead of replacing each other. */
    requireInteraction: true,
    timestamp: Date.now(),
    vibrate: data.sound === "orders" ? [120, 60, 120, 60, 240] : [200, 100, 200],
    data: { url: data.url || "/", sound: data.sound || null },
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      /* Open WMS pages play the alert's own sound (cash register / chime / doorbell)
         and show it as a card in the corner — Windows can hide the banner itself. */
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) =>
        list.forEach((c) => c.postMessage({ type: "wms-alert", sound: data.sound || null, title, body: options.body, url: data.url || "/", tag: data.tag || null })),
      ),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && "focus" in c) {
          return c.focus().then((w) => (w && "navigate" in w ? w.navigate(url) : undefined));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
