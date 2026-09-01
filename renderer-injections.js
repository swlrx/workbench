const NATIVE_NOTIFICATION_BRIDGE_SCRIPT = `
  (() => {
    const bridge = window.hermesDesktop;
    if (!bridge || typeof bridge.notifyCompletion !== "function") return false;

    const notify = (title, options = {}) => bridge.notifyCompletion({
      title: String(title || "hermes"),
      body: String(options.body || ""),
      icon: options.icon,
      tag: options.tag
    });

    class HermesNotification {
      constructor(title, options = {}) {
        notify(title, options);
        this.onclick = null;
      }
      close() {}
      static get permission() { return "granted"; }
      static requestPermission() { return Promise.resolve("granted"); }
    }

    try {
      Object.defineProperty(window, "Notification", {
        configurable: true,
        writable: true,
        value: HermesNotification
      });
    } catch {
      window.Notification = HermesNotification;
    }

    const serviceWorkerRegistration = window.ServiceWorkerRegistration?.prototype;
    if (serviceWorkerRegistration) {
      try {
        Object.defineProperty(serviceWorkerRegistration, "showNotification", {
          configurable: true,
          writable: true,
          value(title, options = {}) {
            return Promise.resolve(notify(title, options));
          }
        });
      } catch {
        // The Notification fallback above still forwards native delivery.
      }
    }

    return window.Notification.permission === "granted";
  })();
`;

function injectNativeNotificationBridge(webContents) {
  return webContents.executeJavaScript(NATIVE_NOTIFICATION_BRIDGE_SCRIPT).catch(() => false);
}

module.exports = {
  NATIVE_NOTIFICATION_BRIDGE_SCRIPT,
  injectNativeNotificationBridge
};
