const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
} = require("electron");
const { parseCommandLine } = require("./argv.cjs");
const { resolveRuntime } = require("./runtime.cjs");
const { RpcProcess } = require("./rpc-session.cjs");

const RPC_COMMANDS = new Set([
  "abort",
  "abort_and_prompt",
  "abort_bash",
  "bash",
  "branch",
  "compact",
  "cycle_model",
  "cycle_thinking_level",
  "export_html",
  "follow_up",
  "get_available_commands",
  "get_available_models",
  "get_branch_messages",
  "get_last_assistant_text",
  "get_login_providers",
  "get_messages",
  "get_messages_page",
  "get_session_stats",
  "get_state",
  "get_subagent_messages",
  "get_subagents",
  "handoff",
  "login",
  "new_session",
  "prompt",
  "set_auto_compaction",
  "set_auto_retry",
  "set_fast_mode",
  "set_follow_up_mode",
  "set_host_tools",
  "set_host_uri_schemes",
  "set_interrupt_mode",
  "set_model",
  "set_session_name",
  "set_steering_mode",
  "set_subagent_subscription",
  "set_thinking_level",
  "set_todos",
  "steer",
  "switch_session",
]);
const sessions = new Map();
let mainWindow = null;

if (/^\d{2,5}$/u.test(process.env.OMP_DESKTOP_DEBUG_PORT || "")) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.OMP_DESKTOP_DEBUG_PORT);
}

function activeRuntime() {
  return resolveRuntime({
    desktopDirectory: path.resolve(__dirname, ".."),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function workspaceDirectory(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("Choose a workspace before starting OMP.");
  }
  const directory = fs.realpathSync(candidate);
  if (!fs.statSync(directory).isDirectory()) {
    throw new Error("The selected workspace is not a directory.");
  }
  return directory;
}

function launchArguments(value) {
  if (typeof value !== "string" || value.length > 4096) {
    throw new Error("Launch arguments may not exceed 4096 characters.");
  }
  const args = parseCommandLine(value);
  if (args.length > 64) {
    throw new Error("Launch arguments may not contain more than 64 values.");
  }
  return args;
}

function validSessionId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/iu.test(value);
}

function sessionFor(id) {
  return validSessionId(id) ? sessions.get(id) || null : null;
}

async function startSession(options) {
  if (!options || typeof options !== "object") {
    throw new Error("Invalid OMP chat session options.");
  }
  const id = validSessionId(options.id) ? options.id : randomUUID();
  if (sessions.has(id)) {
    throw new Error("The requested OMP session already exists.");
  }
  const runtime = activeRuntime();
  if (!runtime.available) {
    throw new Error(runtime.message);
  }
  const cwd = workspaceDirectory(options.cwd);
  const extraArgs = launchArguments(typeof options.args === "string" ? options.args : "");
  const rpc = new RpcProcess({
    command: runtime.command,
    args: [...runtime.args, "--mode", "rpc", ...extraArgs],
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
      PI_RPC_EMIT_TITLE: "1",
      TERM: "dumb",
    },
  });
  const session = {
    id,
    rpc,
    cwd,
    args: typeof options.args === "string" ? options.args : "",
    startedAt: Date.now(),
  };
  sessions.set(id, session);
  rpc.on("frame", (frame) => send("chat:event", { sessionId: id, frame }));
  rpc.on("exit", (result) => {
    sessions.delete(id);
    send("chat:exit", { sessionId: id, ...result });
  });

  try {
    const ready = await rpc.start();
    return {
      id,
      cwd,
      args: session.args,
      startedAt: session.startedAt,
      ready,
      runtime: {
        label: runtime.label,
        mode: runtime.mode,
        version: runtime.version,
      },
    };
  } catch (error) {
    sessions.delete(id);
    await rpc.stop();
    throw error;
  }
}

async function requestSession(id, command) {
  const session = sessionFor(id);
  if (!session) {
    throw new Error("The OMP chat session is not running.");
  }
  if (!command || typeof command !== "object" || !RPC_COMMANDS.has(command.type)) {
    throw new Error("Unsupported OMP RPC command.");
  }
  const sanitized = { ...command };
  delete sanitized.id;
  const timeout = command.type === "bash" ? 600_000 : command.type === "login" ? 300_000 : 60_000;
  return session.rpc.request(sanitized, timeout);
}

async function stopSession(id) {
  const session = sessionFor(id);
  if (!session) {
    return false;
  }
  sessions.delete(id);
  await session.rpc.stop();
  return true;
}

function stopAllSessions() {
  for (const session of sessions.values()) {
    void session.rpc.stop();
  }
  sessions.clear();
}

function isSafeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function chooseAttachment() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Attach an image",
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
  if (result.canceled) {
    return null;
  }
  const filePath = result.filePaths[0];
  let image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    throw new Error("The selected image could not be decoded.");
  }
  const originalSize = image.getSize();
  const longestSide = Math.max(originalSize.width, originalSize.height);
  if (longestSide > 1600) {
    const scale = 1600 / longestSide;
    image = image.resize({
      width: Math.max(1, Math.round(originalSize.width * scale)),
      height: Math.max(1, Math.round(originalSize.height * scale)),
      quality: "best",
    });
  }
  let quality = 88;
  let buffer = image.toJPEG(quality);
  while (buffer.length > 650_000 && quality > 52) {
    quality -= 8;
    buffer = image.toJPEG(quality);
  }
  if (buffer.length > 700_000) {
    const size = image.getSize();
    const scale = Math.sqrt(650_000 / buffer.length);
    image = image.resize({
      width: Math.max(320, Math.round(size.width * scale)),
      height: Math.max(320, Math.round(size.height * scale)),
      quality: "best",
    });
    buffer = image.toJPEG(72);
  }
  return {
    name: path.basename(filePath),
    content: {
      type: "image",
      data: buffer.toString("base64"),
      mimeType: "image/jpeg",
    },
    preview: `data:image/jpeg;base64,${buffer.toString("base64")}`,
  };
}

function registerIpc() {
  ipcMain.handle("runtime:info", () => {
    const runtime = activeRuntime();
    return runtime.available
      ? {
          available: true,
          label: runtime.label,
          mode: runtime.mode,
          version: runtime.version,
          targetKey: runtime.targetKey,
        }
      : runtime;
  });
  ipcMain.handle("workspace:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose an OMP workspace",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("workspace:initial", () => app.getPath("home"));
  ipcMain.handle("workspace:open", async (_event, directory) => {
    const error = await shell.openPath(workspaceDirectory(directory));
    if (error) {
      throw new Error(error);
    }
    return true;
  });
  ipcMain.handle("session:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Resume an OMP session",
      defaultPath: path.join(app.getPath("home"), ".omp", "agent", "sessions"),
      properties: ["openFile"],
      filters: [{ name: "OMP sessions", extensions: ["jsonl"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("attachment:choose", chooseAttachment);
  ipcMain.handle("chat:start", (_event, options) => startSession(options));
  ipcMain.handle("chat:request", (_event, payload) => requestSession(payload?.sessionId, payload?.command));
  ipcMain.handle("chat:stop", (_event, id) => stopSession(id));
  ipcMain.on("chat:send-frame", (_event, payload) => {
    const session = sessionFor(payload?.sessionId);
    if (session && payload?.frame?.type === "extension_ui_response") {
      session.rpc.send(payload.frame);
    }
  });
  ipcMain.handle("clipboard:read", () => clipboard.readText());
  ipcMain.handle("clipboard:write", (_event, value) => {
    if (typeof value !== "string" || value.length > 1_000_000) {
      throw new Error("Clipboard text is invalid or too large.");
    }
    clipboard.writeText(value);
    return true;
  });
  ipcMain.handle("external:open", async (_event, url) => {
    if (!isSafeExternalUrl(url)) {
      throw new Error("Only HTTP and HTTPS links may be opened.");
    }
    await shell.openExternal(url);
    return true;
  });
}

function installMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Chat",
          accelerator: "CmdOrCtrl+N",
          click: () => send("app:command", "new-chat"),
        },
        {
          label: "Open Workspace…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => send("app:command", "open-workspace"),
        },
        { type: "separator" },
        ...(process.platform === "darwin" ? [] : [{ role: "quit" }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Command Palette",
          accelerator: "CmdOrCtrl+K",
          click: () => send("app:command", "command-palette"),
        },
        {
          label: "Focus Message",
          accelerator: "CmdOrCtrl+L",
          click: () => send("app:command", "focus-composer"),
        },
        {
          label: "Stop Generation",
          accelerator: "Escape",
          click: () => send("app:command", "abort"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Oh My Pi documentation",
          click: () => shell.openExternal("https://github.com/can1357/oh-my-pi#readme"),
        },
        {
          label: "Desktop wrapper repository",
          click: () => shell.openExternal("https://github.com/harryvgiunta/yolo-auto-desktop-omp"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: "#080b0f",
    icon: path.join(__dirname, "..", "assets", "app-icon.png"),
    title: "YOLO Auto Desktop OMP",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#080b0f",
      symbolColor: "#d9e2ec",
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
}

app.whenReady().then(() => {
  registerIpc();
  installMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", stopAllSessions);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
