const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("docdoc", {
  call: (method, params) => ipcRenderer.invoke("api", method, params || {}),
  openExternal: (id) => ipcRenderer.invoke("open-external", id),
  openFolder: (id) => ipcRenderer.invoke("open-folder", id),
  onEvent: (cb) => ipcRenderer.on("docdoc-event", (_e, data) => cb(data)),
});
