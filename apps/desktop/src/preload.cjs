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
  chooseSession: () => ipcRenderer.invoke("session:choose"),
  chooseAttachment: () => ipcRenderer.invoke("attachment:choose"),
  startChat: (options) => ipcRenderer.invoke("chat:start", options),
  request: (sessionId, command) => ipcRenderer.invoke("chat:request", { sessionId, command }),
  stopChat: (sessionId) => ipcRenderer.invoke("chat:stop", sessionId),
  sendFrame: (sessionId, frame) => ipcRenderer.send("chat:send-frame", { sessionId, frame }),
  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  writeClipboard: (value) => ipcRenderer.invoke("clipboard:write", value),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  onChatEvent: (callback) => subscribe("chat:event", callback),
  onChatExit: (callback) => subscribe("chat:exit", callback),
  onCommand: (callback) => subscribe("app:command", callback),
});
