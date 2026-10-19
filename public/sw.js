/* CarbonWMS service worker — phone/computer alerts only (owner 2026-10-19).
 *
 * Shows the push sent by lib/server/web-push.ts (Shopify orders, Studio
 * night-batch results), tells every open WMS page to play its sound, and opens
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
    icon: "/carbon-box-icon.png",
    badge: "/carbon-box-icon.png",
    vibrate: data.sound === "orders" ? [120, 60, 120, 60, 240] : [200, 100, 200],
    data: { url: data.url || "/", sound: data.sound || null },
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      /* Open WMS pages play the alert's own sound (cash register / chime). */
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) =>
        list.forEach((c) => c.postMessage({ type: "wms-alert", sound: data.sound || null, title, body: options.body })),
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
