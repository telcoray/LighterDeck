"use strict";
// Service worker for system notifications: on Android the page can't call new Notification(), only a
// service worker can show one. It doesn't touch requests (no fetch handler), so nothing is cached.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
// a tap on the notification brings LighterDeck back to the front, or opens it
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true })
    .then((tabs) => (tabs.length ? tabs[0].focus() : self.clients.openWindow("/"))));
});
