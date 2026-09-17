const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("docdoc", {
  call: (method, params) => ipcRenderer.invoke("api", method, params || {}),
  importFiles: (options) => ipcRenderer.invoke("import-files", options || {}),
  backup: () => ipcRenderer.invoke("backup"),
  exportPdf: (id) => ipcRenderer.invoke("export-pdf", id),
  openExternal: (id) => ipcRenderer.invoke("open-external", id),
  onEvent: (cb) => ipcRenderer.on("docdoc-event", (_e, data) => cb(data)),
});
