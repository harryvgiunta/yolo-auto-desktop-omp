import { FitAddon } from "../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs";
import { WebLinksAddon } from "../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs";
import { Terminal } from "../../node_modules/@xterm/xterm/lib/xterm.mjs";

const bridge = window.ompDesktop;
const elements = {
  activeSubtitle: document.querySelector("#active-subtitle"),
  activeTitle: document.querySelector("#active-title"),
  chooseWorkspace: document.querySelector("#choose-workspace"),
  copyOutput: document.querySelector("#copy-output"),
  docsLink: document.querySelector("#docs-link"),
  emptyStart: document.querySelector("#empty-start"),
  emptyState: document.querySelector("#empty-state"),
  launchArgs: document.querySelector("#launch-args"),
  newSession: document.querySelector("#new-session"),
  openWorkspaceFolder: document.querySelector("#open-workspace-folder"),
  restartSession: document.querySelector("#restart-session"),
  runtimeLabel: document.querySelector("#runtime-label"),
  runtimePill: document.querySelector("#runtime-pill"),
  sessionCount: document.querySelector("#session-count"),
  sessionList: document.querySelector("#session-list"),
  statusIndicator: document.querySelector("#status-indicator"),
  statusMessage: document.querySelector("#status-message"),
  stopSession: document.querySelector("#stop-session"),
  terminalStack: document.querySelector("#terminal-stack"),
  toastRegion: document.querySelector("#toast-region"),
  windowTitle: document.querySelector("#window-title"),
  workspaceName: document.querySelector("#workspace-name"),
  workspacePath: document.querySelector("#workspace-path"),
};

const sessions = new Map();
const disposables = [];
let activeSessionId = null;
let runtimeAvailable = false;
let workspace = localStorage.getItem("ompDesktop.workspace") || "";
let nextSessionNumber = 1;

function leafName(filePath) {
  const normalized = filePath.replace(/[\\/]+$/u, "");
  const parts = normalized.split(/[\\/]/u);
  return parts.at(-1) || normalized;
}

function compactPath(filePath, maximum = 52) {
  if (filePath.length <= maximum) {
    return filePath;
  }
  return `…${filePath.slice(-(maximum - 1))}`;
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /u, "");
}

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  window.setTimeout(() => item.remove(), 4200);
}

function setStatus(message, state = "idle") {
  elements.statusMessage.textContent = message;
  elements.statusIndicator.className = `status-indicator ${state}`;
}

function setWorkspace(directory) {
  workspace = directory;
  if (directory) {
    localStorage.setItem("ompDesktop.workspace", directory);
    elements.workspaceName.textContent = leafName(directory);
    elements.workspacePath.textContent = compactPath(directory, 36);
    elements.workspacePath.title = directory;
    elements.openWorkspaceFolder.disabled = false;
  } else {
    localStorage.removeItem("ompDesktop.workspace");
    elements.workspaceName.textContent = "Choose a project";
    elements.workspacePath.textContent = "OMP runs inside this folder";
    elements.workspacePath.removeAttribute("title");
    elements.openWorkspaceFolder.disabled = true;
  }
  updateControls();
}

function activeSession() {
  return activeSessionId ? sessions.get(activeSessionId) || null : null;
}

function elapsedLabel(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderSessionList() {
  elements.sessionList.replaceChildren();
  for (const session of sessions.values()) {
    const item = document.createElement("div");
    item.tabIndex = 0;
    item.className = `session-item${session.id === activeSessionId ? " active" : ""}${session.state === "exited" ? " exited" : ""}`;
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", String(session.id === activeSessionId));
    item.title = session.cwd;

    const state = document.createElement("span");
    state.className = "session-state";
    state.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "session-item-copy";
    const title = document.createElement("strong");
    title.textContent = session.title;
    const detail = document.createElement("small");
    detail.textContent = session.state === "exited" ? "Exited" : `${session.state === "starting" ? "Starting" : "Running"} · ${elapsedLabel(session.startedAt)}`;
    copy.append(title, detail);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "session-close";
    close.textContent = "×";
    close.title = "Close session";
    close.setAttribute("aria-label", `Close ${session.title}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void closeSession(session.id);
    });

    item.append(state, copy, close);
    item.addEventListener("click", () => setActiveSession(session.id));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setActiveSession(session.id);
      }
    });
    elements.sessionList.append(item);
  }
  elements.sessionCount.textContent = String(sessions.size);
}

function updateControls() {
  const session = activeSession();
  const running = session && (session.state === "running" || session.state === "starting");
  elements.copyOutput.disabled = !session;
  elements.restartSession.disabled = !session || session.state === "starting";
  elements.stopSession.disabled = !running;
  elements.newSession.disabled = !runtimeAvailable || !workspace;
  elements.emptyStart.disabled = !runtimeAvailable;

  if (!session) {
    elements.emptyState.classList.remove("hidden");
    elements.activeTitle.textContent = "OMP terminal";
    elements.activeSubtitle.textContent = "No active session";
    elements.windowTitle.textContent = workspace ? leafName(workspace) : "Ready";
    setStatus(
      runtimeAvailable ? "Select a workspace, then start OMP" : "OMP runtime is unavailable",
      runtimeAvailable ? "idle" : "error",
    );
    return;
  }

  elements.emptyState.classList.add("hidden");
  elements.activeTitle.textContent = session.title;
  elements.activeSubtitle.textContent = session.cwd;
  elements.windowTitle.textContent = `${session.title} — ${leafName(session.cwd)}`;
  if (session.state === "running") {
    setStatus(`OMP running in ${session.cwd}`, "running");
  } else if (session.state === "starting") {
    setStatus("Starting the OMP runtime…", "idle");
  } else {
    setStatus(session.exitLabel || "OMP session exited", "idle");
  }
}

function fitSession(session) {
  if (!session || session.id !== activeSessionId || session.state === "disposed") {
    return;
  }
  try {
    session.fitAddon.fit();
    bridge.resize(session.id, session.terminal.cols, session.terminal.rows);
  } catch {
    // The host is between layout states; the ResizeObserver will retry.
  }
}

function setActiveSession(id) {
  if (!sessions.has(id)) {
    return;
  }
  activeSessionId = id;
  for (const session of sessions.values()) {
    session.host.classList.toggle("active", session.id === id);
  }
  renderSessionList();
  updateControls();
  const session = sessions.get(id);
  requestAnimationFrame(() => {
    fitSession(session);
    session.terminal.focus();
  });
}

async function copySelection() {
  const session = activeSession();
  if (!session) {
    return;
  }
  const selection = session.terminal.getSelection();
  if (!selection) {
    toast("Select terminal text before copying.");
    return;
  }
  await bridge.writeClipboard(selection);
  toast("Terminal selection copied.");
}

async function pasteClipboard(session = activeSession()) {
  if (!session || session.state === "exited") {
    return;
  }
  const text = await bridge.readClipboard();
  if (text) {
    session.terminal.paste(text);
  }
}

function createTerminalSession({ id, cwd, args }) {
  const host = document.createElement("div");
  host.className = "terminal-host";
  host.dataset.sessionId = id;
  elements.terminalStack.append(host);

  const terminal = new Terminal({
    allowProposedApi: false,
    allowTransparency: true,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    fontWeight: "400",
    fontWeightBold: "650",
    letterSpacing: 0,
    lineHeight: 1.22,
    minimumContrastRatio: 4.5,
    rightClickSelectsWord: true,
    scrollback: 20_000,
    smoothScrollDuration: 110,
    theme: {
      background: "#080b0f",
      foreground: "#d6dee7",
      cursor: "#c7f36a",
      cursorAccent: "#080b0f",
      selectionBackground: "#314233",
      selectionForeground: "#f3f7fb",
      black: "#11161d",
      red: "#ff7b72",
      green: "#c7f36a",
      yellow: "#f4c15d",
      blue: "#79a9ff",
      magenta: "#d19bf4",
      cyan: "#64d7e7",
      white: "#d6dee7",
      brightBlack: "#637080",
      brightRed: "#ff9a93",
      brightGreen: "#d7ff80",
      brightYellow: "#ffd982",
      brightBlue: "#9bbfff",
      brightMagenta: "#e3b7ff",
      brightCyan: "#8ce9f3",
      brightWhite: "#ffffff",
    },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon((_event, uri) => bridge.openExternal(uri)));
  terminal.open(host);

  const session = {
    id,
    terminal,
    fitAddon,
    host,
    cwd,
    args,
    title: `${leafName(cwd)} · ${nextSessionNumber}`,
    state: "starting",
    startedAt: Date.now(),
    exitLabel: "",
  };
  nextSessionNumber += 1;
  sessions.set(id, session);

  terminal.onData((data) => bridge.write(id, data));
  terminal.onResize(({ cols, rows }) => bridge.resize(id, cols, rows));
  terminal.attachCustomKeyEventHandler((event) => {
    const primary = event.ctrlKey || event.metaKey;
    if (event.type !== "keydown" || !primary || !event.shiftKey) {
      return true;
    }
    if (event.key.toLowerCase() === "c") {
      void copySelection();
      return false;
    }
    if (event.key.toLowerCase() === "v") {
      void pasteClipboard(session);
      return false;
    }
    return true;
  });
  host.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void pasteClipboard(session);
  });
  return session;
}

async function startSession(overrides = {}) {
  const cwd = overrides.cwd || workspace;
  const args = overrides.args ?? elements.launchArgs.value.trim();
  if (!cwd) {
    await chooseWorkspace(true);
    return;
  }
  if (!runtimeAvailable) {
    toast("The OMP runtime is unavailable. Run npm run runtime:prepare.", "error");
    return;
  }

  const id = crypto.randomUUID();
  const session = createTerminalSession({ id, cwd, args });
  setActiveSession(id);
  requestAnimationFrame(() => fitSession(session));

  try {
    const result = await bridge.startSession({
      id,
      cwd,
      args,
      cols: terminalSize(session).cols,
      rows: terminalSize(session).rows,
    });
    session.state = "running";
    session.startedAt = result.startedAt;
    session.runtime = result.runtime;
    renderSessionList();
    updateControls();
    session.terminal.focus();
  } catch (error) {
    const message = cleanError(error);
    session.state = "exited";
    session.exitLabel = `Launch failed: ${message}`;
    session.terminal.writeln(`\r\n\x1b[31mOMP failed to start:\x1b[0m ${message}`);
    renderSessionList();
    updateControls();
    toast(message, "error");
  }
}

function terminalSize(session) {
  return {
    cols: Math.max(20, session.terminal.cols || 120),
    rows: Math.max(8, session.terminal.rows || 40),
  };
}

async function stopActiveSession() {
  const session = activeSession();
  if (!session || session.state === "exited") {
    return;
  }
  try {
    await bridge.stopSession(session.id);
    session.state = "exited";
    session.exitLabel = "Stopped by user";
    session.terminal.writeln("\r\n\x1b[90mOMP session stopped.\x1b[0m");
    renderSessionList();
    updateControls();
  } catch (error) {
    toast(cleanError(error), "error");
  }
}

async function closeSession(id) {
  const session = sessions.get(id);
  if (!session) {
    return;
  }
  if (session.state !== "exited") {
    try {
      await bridge.stopSession(id);
    } catch {
      // Closing the local terminal remains valid after an external process exit.
    }
  }
  session.state = "disposed";
  session.terminal.dispose();
  session.host.remove();
  sessions.delete(id);

  if (activeSessionId === id) {
    const remaining = [...sessions.keys()];
    activeSessionId = remaining.at(-1) || null;
    if (activeSessionId) {
      setActiveSession(activeSessionId);
    }
  }
  renderSessionList();
  updateControls();
}

async function restartActiveSession() {
  const session = activeSession();
  if (!session) {
    return;
  }
  const options = { cwd: session.cwd, args: session.args };
  await closeSession(session.id);
  await startSession(options);
}

async function chooseWorkspace(startAfter = false) {
  try {
    const directory = await bridge.chooseWorkspace();
    if (!directory) {
      return;
    }
    setWorkspace(directory);
    if (startAfter) {
      await startSession({ cwd: directory });
    }
  } catch (error) {
    toast(cleanError(error), "error");
  }
}

function handleExit({ id, exitCode, signal }) {
  const session = sessions.get(id);
  if (!session || session.state === "disposed") {
    return;
  }
  session.state = "exited";
  session.exitLabel = signal
    ? `OMP exited after signal ${signal}`
    : `OMP exited with code ${exitCode}`;
  session.terminal.writeln(`\r\n\x1b[90m${session.exitLabel}.\x1b[0m`);
  renderSessionList();
  updateControls();
}

function handleCommand(command) {
  if (command === "new-session") {
    void startSession();
  } else if (command === "open-workspace") {
    void chooseWorkspace(false);
  } else if (command === "close-session" && activeSessionId) {
    void closeSession(activeSessionId);
  } else if (command === "restart-session") {
    void restartActiveSession();
  }
}

async function initialize() {
  if (!bridge) {
    elements.runtimePill.className = "runtime-pill error";
    elements.runtimeLabel.textContent = "Desktop bridge unavailable";
    setStatus("Launch this interface through Electron", "error");
    return;
  }

  disposables.push(bridge.onData(({ id, data }) => sessions.get(id)?.terminal.write(data)));
  disposables.push(bridge.onExit(handleExit));
  disposables.push(bridge.onCommand(handleCommand));

  try {
    const runtime = await bridge.runtimeInfo();
    runtimeAvailable = runtime.available;
    elements.runtimePill.className = `runtime-pill ${runtime.available ? "ready" : "error"}`;
    elements.runtimeLabel.textContent = runtime.available ? runtime.label : "OMP runtime missing";
    elements.runtimePill.title = runtime.available ? `${runtime.label} · ${runtime.targetKey}` : runtime.message;
    if (!runtime.available) {
      toast(runtime.message, "error");
    }
  } catch (error) {
    runtimeAvailable = false;
    elements.runtimePill.className = "runtime-pill error";
    elements.runtimeLabel.textContent = "Runtime check failed";
    toast(cleanError(error), "error");
  }

  if (!workspace) {
    try {
      workspace = await bridge.initialWorkspace();
    } catch {
      workspace = "";
    }
  }
  setWorkspace(workspace);
  elements.launchArgs.value = localStorage.getItem("ompDesktop.launchArgs") || "";
  updateControls();
}

elements.chooseWorkspace.addEventListener("click", () => void chooseWorkspace(false));
elements.openWorkspaceFolder.addEventListener("click", () => {
  if (workspace) {
    void bridge.openWorkspace(workspace).catch((error) => toast(cleanError(error), "error"));
  }
});
elements.newSession.addEventListener("click", () => void startSession());
elements.emptyStart.addEventListener("click", () => void startSession());
elements.stopSession.addEventListener("click", () => void stopActiveSession());
elements.restartSession.addEventListener("click", () => void restartActiveSession());
elements.copyOutput.addEventListener("click", () => void copySelection());
elements.docsLink.addEventListener("click", (event) => {
  event.preventDefault();
  void bridge.openExternal(elements.docsLink.href);
});
elements.launchArgs.addEventListener("change", () => {
  localStorage.setItem("ompDesktop.launchArgs", elements.launchArgs.value.trim());
});

const resizeObserver = new ResizeObserver(() => fitSession(activeSession()));
resizeObserver.observe(elements.terminalStack);
window.addEventListener("beforeunload", () => {
  resizeObserver.disconnect();
  for (const dispose of disposables) {
    dispose();
  }
});

void initialize();
