// Registered by Settings -> Notifications. Payload is built by
// apps/core/src/notifications/payload.ts (buildPushPayload).

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Valet', {
      body: data.body,
      data: { url: data.url },
      // One live notification per thread: a later one replaces the stale one.
      tag: data.threadId,
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data && event.notification.data.url
  if (!url) return
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === url) return client.focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})
