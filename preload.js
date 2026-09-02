const { contextBridge, ipcRenderer } = require("electron");

// Hermes Studio Web UI bridge
contextBridge.exposeInMainWorld("hermesDesktop", {
  // Use the Web UI layout so Petdex renders inside the page. Hermes Studio's
  // official desktop mode expects a separate native pet window, which this
  // lightweight wrapper does not create.
  isDesktop: false,
  notifyCompletion: (payload) => ipcRenderer.invoke("hermes:notify", payload),
  openExternalLink: (url) => ipcRenderer.invoke("link:open-external", url)
});
