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
  shell,
} = require("electron");
const pty = require("node-pty");
const { parseCommandLine } = require("./argv.cjs");
const { resolveRuntime } = require("./runtime.cjs");

const sessions = new Map();
let mainWindow = null;

if (/^\d{2,5}$/u.test(process.env.OMP_DESKTOP_DEBUG_PORT || "")) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.OMP_DESKTOP_DEBUG_PORT);
}

function clampInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
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
  if (value.length > 4096) {
    throw new Error("Launch arguments may not exceed 4096 characters.");
  }
  const args = parseCommandLine(value);
  if (args.length > 64) {
    throw new Error("Launch arguments may not contain more than 64 values.");
  }
  return args;
}

function startSession(options) {
  if (!options || typeof options !== "object") {
    throw new Error("Invalid OMP session options.");
  }

  const runtime = activeRuntime();
  if (!runtime.available) {
    throw new Error(runtime.message);
  }

  const cwd = workspaceDirectory(options.cwd);
  const extraArgs = launchArguments(typeof options.args === "string" ? options.args : "");
  const cols = clampInteger(options.cols, 20, 500, 120);
  const rows = clampInteger(options.rows, 8, 300, 40);
  const id =
    typeof options.id === "string" && /^[0-9a-f-]{36}$/iu.test(options.id)
      ? options.id
      : randomUUID();
  if (sessions.has(id)) {
    throw new Error("The requested OMP session already exists.");
  }
  const terminal = pty.spawn(runtime.command, [...runtime.args, ...extraArgs], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      PWD: cwd,
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
      TERM: "xterm-256color",
      TERM_PROGRAM: "yolo-auto-desktop-omp",
      TERM_PROGRAM_VERSION: app.getVersion(),
    },
  });

  const session = {
    id,
    terminal,
    cwd,
    args: typeof options.args === "string" ? options.args : "",
    startedAt: Date.now(),
  };
  sessions.set(id, session);

  terminal.onData((data) => {
    send("terminal:data", { id, data });
  });
  terminal.onExit(({ exitCode, signal }) => {
    sessions.delete(id);
    send("terminal:exit", { id, exitCode, signal });
  });

  return {
    id,
    cwd,
    args: session.args,
    runtime: {
      label: runtime.label,
      mode: runtime.mode,
      version: runtime.version,
    },
    startedAt: session.startedAt,
  };
}

function sessionFor(id) {
  if (typeof id !== "string") {
    return null;
  }
  return sessions.get(id) || null;
}

function stopSession(id) {
  const session = sessionFor(id);
  if (!session) {
    return false;
  }
  session.terminal.kill();
  sessions.delete(id);
  return true;
}

function stopAllSessions() {
  for (const session of sessions.values()) {
    try {
      session.terminal.kill();
    } catch {
      // The process already exited.
    }
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
    const safeDirectory = workspaceDirectory(directory);
    const error = await shell.openPath(safeDirectory);
    if (error) {
      throw new Error(error);
    }
    return true;
  });

  ipcMain.handle("terminal:start", (_event, options) => startSession(options));
  ipcMain.on("terminal:write", (_event, payload) => {
    const session = sessionFor(payload?.id);
    if (session && typeof payload.data === "string" && payload.data.length <= 65_536) {
      session.terminal.write(payload.data);
    }
  });
  ipcMain.on("terminal:resize", (_event, payload) => {
    const session = sessionFor(payload?.id);
    if (!session) {
      return;
    }
    const cols = clampInteger(payload.cols, 20, 500, null);
    const rows = clampInteger(payload.rows, 8, 300, null);
    if (cols && rows) {
      session.terminal.resize(cols, rows);
    }
  });
  ipcMain.handle("terminal:stop", (_event, id) => stopSession(id));
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
          label: "New OMP Session",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => send("app:command", "new-session"),
        },
        {
          label: "Open Workspace…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => send("app:command", "open-workspace"),
        },
        { type: "separator" },
        {
          label: "Close Session",
          accelerator: "CmdOrCtrl+Shift+W",
          click: () => send("app:command", "close-session"),
        },
        ...(process.platform === "darwin" ? [] : [{ type: "separator" }, { role: "quit" }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Restart OMP Session",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => send("app:command", "restart-session"),
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
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
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
      shell.openExternal(url);
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
