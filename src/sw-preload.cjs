// Runs inside chat.google.com's own service worker, before its script
// executes (registered as a "service-worker" type preload script in
// main.js). Electron's "persistent" notification path
// (ServiceWorkerRegistration.showNotification, called here as
// self.registration.showNotification()) has a longstanding implementation
// gap and silently rejects: electron/electron#13041. This is what real
// background push messages use. `new Notification()` isn't legal inside a
// service worker, so on failure this asks any open window (kept alive by
// hiding rather than closing — see main.js) to construct it instead.
//
// Best-effort only: Electron runs "service-worker" type preload scripts in
// an extremely early context where even `self` isn't defined yet, so this
// may never get a chance to patch anything. main.js's unread-count-based
// notification (fired from the main process, which is proven to work) is
// the reliable fallback if this never applies.
try {
  console.log("[sw-preload] installed");

  function patchShowNotification() {
    if (typeof ServiceWorkerRegistration === "undefined") return false;

    console.log("[sw-preload] patching showNotification");
    const nativeShowNotification = ServiceWorkerRegistration.prototype.showNotification;

    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      console.log("[sw-preload] showNotification called:", title);
      return nativeShowNotification.call(this, title, options).then(
        (result) => {
          console.log("[sw-preload] native showNotification succeeded");
          return result;
        },
        async (error) => {
          console.log("[sw-preload] native showNotification failed, falling back:", error);
          const fallbackOptions = { ...options };
          delete fallbackOptions.actions; // only supported for persistent notifications
          const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
          console.log("[sw-preload] posting fallback to", clients.length, "window client(s)");
          for (const client of clients) {
            client.postMessage({ __swNotificationFallback: true, title, options: fallbackOptions });
          }
        },
      );
    };
    return true;
  }

  if (!patchShowNotification()) {
    if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
      // "install" only fires once the SW's global scope is fully set up.
      self.addEventListener("install", () => patchShowNotification());
    } else if (typeof queueMicrotask === "function") {
      // self isn't even defined yet — poll a bounded number of microtasks.
      let attempts = 0;
      const retry = () => {
        attempts += 1;
        if (patchShowNotification() || attempts > 50) return;
        queueMicrotask(retry);
      };
      queueMicrotask(retry);
    } else {
      console.log("[sw-preload] no way to defer patching in this context, giving up");
    }
  }
} catch (error) {
  console.log("[sw-preload] setup failed:", error);
}
