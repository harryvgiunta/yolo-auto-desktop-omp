const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("ompDesktop", {
  runtimeInfo: () => ipcRenderer.invoke("runtime:info"),
  initialWorkspace: () => ipcRenderer.invoke("workspace:initial"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  openWorkspace: (directory) => ipcRenderer.invoke("workspace:open", directory),
  startSession: (options) => ipcRenderer.invoke("terminal:start", options),
  stopSession: (id) => ipcRenderer.invoke("terminal:stop", id),
  write: (id, data) => ipcRenderer.send("terminal:write", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send("terminal:resize", { id, cols, rows }),
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  writeClipboard: (value) => ipcRenderer.invoke("clipboard:write", value),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  onData: (callback) => subscribe("terminal:data", callback),
  onExit: (callback) => subscribe("terminal:exit", callback),
  onCommand: (callback) => subscribe("app:command", callback),
});
