import DOMPurify from "../../node_modules/dompurify/dist/purify.es.mjs";
import { marked } from "../../node_modules/marked/lib/marked.esm.js";

marked.setOptions({ gfm: true, breaks: false });

const bridge = window.ompDesktop;
const elements = Object.fromEntries(
  [
    "abort-generation", "active-subtitle", "active-title", "activity-empty", "activity-list", "activity-live",
    "attach-image", "attachment-list", "chat-count", "chat-list", "choose-workspace", "command-palette",
    "connection-status", "context-fill", "context-percent", "context-tokens", "context-window", "conversation",
    "docs-link", "extension-section", "extension-widgets", "fast-toggle", "launch-args", "message-input",
    "message-list", "modal-actions", "modal-backdrop", "modal-close", "modal-content", "modal-message", "modal-title",
    "model-select", "new-chat", "open-command-palette", "open-workspace-folder", "palette-results", "phase-list",
    "plan-count", "plan-section", "queue-label", "runtime-label", "runtime-pill", "send-message", "show-commands",
    "thinking-select", "todo-count", "todo-empty", "todo-list", "toast-region", "welcome", "window-title",
    "workspace-name", "workspace-path",
  ].map((id) => [id.replaceAll("-", "_"), document.querySelector(`#${id}`)]),
);

const sessions = new Map();
const disposables = [];
let activeSessionId = null;
let runtimeAvailable = false;
let workspace = localStorage.getItem("ompDesktop.workspace") || "";
let attachments = [];
let paletteSelection = 0;
let activeModal = null;
let nextChatNumber = 1;

function leafName(filePath) {
  const normalized = filePath.replace(/[\\/]+$/u, "");
  return normalized.split(/[\\/]/u).at(-1) || normalized;
}

function compactPath(filePath, maximum = 46) {
  return filePath.length <= maximum ? filePath : `…${filePath.slice(-(maximum - 1))}`;
}

function cleanError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': Error: /u,
    "",
  );
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  elements.toast_region.append(item);
  window.setTimeout(() => item.remove(), 4500);
}

function activeSession() {
  return activeSessionId ? sessions.get(activeSessionId) || null : null;
}

function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ""), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input", "button"],
  });
}

function textContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.filter((item) => item?.type === "text").map((item) => item.text || "").join("");
}

function thinkingContent(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content.filter((item) => item?.type === "thinking").map((item) => item.thinking || "").join("");
}

function imageContent(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((item) => item?.type === "image" && item.data && item.mimeType)
    .map((item) => `data:${item.mimeType};base64,${item.data}`);
}

function summarize(value, maximum = 1800) {
  let text;
  if (typeof value === "string") {
    text = value;
  } else if (value?.content && Array.isArray(value.content)) {
    text = textContent(value.content);
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (!text) {
    return "";
  }
  return text.length > maximum ? `${text.slice(0, maximum)}\n…` : text;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp || Date.now());
}

function setWorkspace(directory) {
  workspace = directory;
  if (directory) {
    localStorage.setItem("ompDesktop.workspace", directory);
    elements.workspace_name.textContent = leafName(directory);
    elements.workspace_path.textContent = compactPath(directory, 34);
    elements.workspace_path.title = directory;
    elements.open_workspace_folder.disabled = false;
  } else {
    localStorage.removeItem("ompDesktop.workspace");
    elements.workspace_name.textContent = "Choose a project";
    elements.workspace_path.textContent = "OMP works inside this folder";
    elements.open_workspace_folder.disabled = true;
  }
  updateChrome();
}

function createSession(id, cwd, args) {
  const session = {
    id,
    cwd,
    args,
    title: `${leafName(cwd)} · ${nextChatNumber}`,
    status: "connecting",
    startedAt: Date.now(),
    messages: [],
    activeAssistantId: null,
    commands: [],
    models: [],
    state: null,
    tools: new Map(),
    activities: new Map(),
    extensionWidgets: new Map(),
    extensionStatus: new Map(),
    renderScheduled: false,
  };
  nextChatNumber += 1;
  sessions.set(id, session);
  return session;
}

function addMessage(session, message) {
  const normalized = {
    id: message.id || crypto.randomUUID(),
    role: message.role,
    text: message.text || "",
    thinking: message.thinking || "",
    images: message.images || [],
    model: message.model || "",
    timestamp: message.timestamp || Date.now(),
    streaming: Boolean(message.streaming),
    pending: Boolean(message.pending),
    level: message.level || "info",
    tools: message.tools || [],
  };
  session.messages.push(normalized);
  scheduleMessages(session);
  updateChrome();
  return normalized;
}

function assistantFromWire(message) {
  return {
    role: "assistant",
    text: textContent(message?.content),
    thinking: thinkingContent(message?.content),
    model: message?.model || "",
    timestamp: message?.timestamp || Date.now(),
    streaming: message?.stopReason === undefined,
  };
}

function appendHistory(session, wireMessages) {
  session.messages = [];
  for (const message of wireMessages || []) {
    if (message?.role === "user") {
      session.messages.push({
        id: crypto.randomUUID(), role: "user", text: textContent(message.content), images: imageContent(message.content),
        timestamp: message.timestamp || Date.now(), streaming: false, pending: false, tools: [],
      });
    } else if (message?.role === "assistant") {
      session.messages.push({ id: crypto.randomUUID(), ...assistantFromWire(message), streaming: false, tools: [] });
    } else if (message?.role === "toolResult" && message.isError) {
      session.messages.push({
        id: crypto.randomUUID(), role: "notice", text: `${message.toolName}: ${textContent(message.content)}`,
        timestamp: message.timestamp || Date.now(), level: "error", streaming: false, tools: [],
      });
    }
  }
  scheduleMessages(session);
}

function findPendingUser(session, message) {
  const text = textContent(message?.content);
  return [...session.messages].reverse().find((item) => item.role === "user" && item.pending && item.text === text);
}

function currentAssistant(session, wireMessage) {
  let item = session.activeAssistantId
    ? session.messages.find((message) => message.id === session.activeAssistantId)
    : null;
  if (!item) {
    item = addMessage(session, { ...assistantFromWire(wireMessage), streaming: true, tools: [] });
    session.activeAssistantId = item.id;
  }
  return item;
}

function updateAssistant(session, wireMessage, streaming) {
  const item = currentAssistant(session, wireMessage);
  const next = assistantFromWire(wireMessage);
  item.text = next.text;
  item.thinking = next.thinking;
  item.model = next.model;
  item.timestamp = next.timestamp;
  item.streaming = streaming;
  if (!streaming) {
    session.activeAssistantId = null;
  }
  scheduleMessages(session);
}

function toolFor(session, frame) {
  let tool = session.tools.get(frame.toolCallId);
  if (!tool) {
    tool = {
      id: frame.toolCallId,
      name: frame.toolName || "tool",
      args: frame.args,
      intent: frame.intent || "",
      detail: summarize(frame.args, 700),
      activityDetail: frame.intent || summarize(frame.args, 180),
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    session.tools.set(tool.id, tool);
    const assistant = currentAssistant(session, null);
    assistant.tools.push(tool);
  }
  return tool;
}

function updateActivity(session, id, value) {
  session.activities.set(id, { id, updatedAt: Date.now(), ...value });
  renderActivity(session);
}

async function rpc(session, command) {
  const response = await bridge.request(session.id, command);
  if (!response.success) {
    const error = new Error(response.error || `OMP command ${command.type} failed.`);
    error.code = response.code;
    throw error;
  }
  return response.data;
}

async function refreshState(session) {
  if (!session || session.status === "exited") {
    return;
  }
  try {
    session.state = await rpc(session, { type: "get_state" });
    if (session.state?.sessionName) {
      session.title = session.state.sessionName;
    }
    renderState(session);
    renderChatList();
    updateChrome();
  } catch (error) {
    toast(cleanError(error), "error");
  }
}

function handleFrame(session, frame) {
  if (!session) {
    return;
  }
  switch (frame.type) {
    case "available_commands_update":
      session.commands = frame.commands || [];
      renderPalette();
      break;
    case "agent_start":
      session.status = "streaming";
      if (session.state) session.state.isStreaming = true;
      renderState(session);
      renderChatList();
      updateChrome();
      break;
    case "agent_end":
      if (frame.isTerminal !== false) {
        session.status = "ready";
        if (session.state) session.state.isStreaming = false;
        void refreshState(session);
      }
      renderState(session);
      renderChatList();
      updateChrome();
      break;
    case "message_start":
      if (frame.message?.role === "user") {
        const pending = findPendingUser(session, frame.message);
        if (pending) {
          pending.pending = false;
          pending.timestamp = frame.message.timestamp || pending.timestamp;
        } else {
          addMessage(session, {
            role: "user", text: textContent(frame.message.content), images: imageContent(frame.message.content),
            timestamp: frame.message.timestamp,
          });
        }
      } else if (frame.message?.role === "assistant") {
        updateAssistant(session, frame.message, true);
      }
      break;
    case "message_update":
      updateAssistant(session, frame.message, true);
      break;
    case "message_end":
      if (frame.message?.role === "assistant") {
        updateAssistant(session, frame.message, false);
      }
      break;
    case "tool_execution_start": {
      const tool = toolFor(session, frame);
      updateActivity(session, tool.id, { kind: "tool", name: tool.name, detail: tool.activityDetail, status: "running" });
      scheduleMessages(session);
      break;
    }
    case "tool_execution_update": {
      const tool = toolFor(session, frame);
      tool.detail = summarize(frame.partialResult, 900) || tool.detail;
      tool.updatedAt = Date.now();
      updateActivity(session, tool.id, { kind: "tool", name: tool.name, detail: tool.activityDetail, status: "running" });
      scheduleMessages(session);
      break;
    }
    case "tool_execution_end": {
      const tool = toolFor(session, frame);
      tool.detail = summarize(frame.result, 1800) || tool.detail;
      tool.status = frame.isError ? "error" : "complete";
      tool.updatedAt = Date.now();
      updateActivity(session, tool.id, { kind: "tool", name: tool.name, detail: tool.activityDetail, status: tool.status });
      scheduleMessages(session);
      break;
    }
    case "command_output":
      addMessage(session, { role: "output", text: stripAnsi(frame.text), timestamp: Date.now() });
      break;
    case "notice":
      addMessage(session, { role: "notice", text: frame.message || "", level: frame.level || "info", timestamp: Date.now() });
      break;
    case "stderr":
      if (frame.text?.trim()) {
        addMessage(session, { role: "notice", text: frame.text.trim(), level: "warning", timestamp: Date.now() });
      }
      break;
    case "protocol_error":
      addMessage(session, { role: "notice", text: frame.error, level: "error", timestamp: Date.now() });
      break;
    case "model_changed":
    case "thinking_level_changed":
    case "config_update":
      void refreshState(session);
      break;
    case "session_info_update":
      if (frame.title) session.title = frame.title;
      renderChatList();
      updateChrome();
      break;
    case "extension_ui_request":
      handleExtensionRequest(session, frame);
      break;
    case "subagent_lifecycle":
    case "subagent_progress":
    case "subagent_event": {
      const payload = frame.payload || {};
      const id = payload.id || payload.agentId || payload.subagentId || `subagent-${Date.now()}`;
      updateActivity(session, id, {
        kind: "subagent",
        name: payload.agent || payload.name || "Subagent",
        detail: payload.description || payload.task || payload.status || "Working",
        status: payload.status || "running",
      });
      break;
    }
    case "auto_compaction_start":
      updateActivity(session, "compaction", { kind: "system", name: "Compacting context", detail: frame.action, status: "running" });
      break;
    case "auto_compaction_end":
      updateActivity(session, "compaction", { kind: "system", name: "Context compacted", detail: frame.errorMessage || frame.action, status: frame.errorMessage ? "error" : "complete" });
      void refreshState(session);
      break;
    case "auto_retry_start":
      updateActivity(session, "retry", { kind: "system", name: `Retry ${frame.attempt}/${frame.maxAttempts}`, detail: frame.errorMessage, status: "running" });
      break;
    case "auto_retry_end":
      updateActivity(session, "retry", { kind: "system", name: frame.success ? "Retry recovered" : "Retry failed", detail: frame.finalError || "", status: frame.success ? "complete" : "error" });
      break;
    case "todo_reminder":
    case "todo_auto_clear":
      void refreshState(session);
      break;
    default:
      break;
  }
}

function messageNode(item) {
  const node = document.createElement("article");
  node.dataset.messageId = item.id;
  if (item.role === "output") {
    node.className = "command-output markdown";
    node.innerHTML = markdown(item.text);
    return node;
  }
  if (item.role === "notice") {
    node.className = `notice-message ${item.level || ""}`;
    node.textContent = item.text;
    return node;
  }
  node.className = `message ${item.role}`;
  if (item.role !== "user") {
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = "π";
    node.append(avatar);
  }
  const content = document.createElement("div");
  content.className = "message-content";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("strong");
  author.textContent = item.role === "user" ? "You" : "OMP";
  const time = document.createElement("span");
  time.textContent = formatTime(item.timestamp);
  meta.append(author, time);
  const body = document.createElement("div");
  body.className = "markdown";
  content.append(meta, body);
  node.append(content);
  return node;
}

function patchMessage(node, item) {
  if (item.role === "output" || item.role === "notice") {
    const key = `${item.role}:${item.level}:${item.text}`;
    if (node.dataset.renderKey !== key) {
      if (item.role === "output") {
        node.className = "command-output markdown";
        node.innerHTML = markdown(item.text);
      } else {
        node.className = `notice-message ${item.level || ""}`;
        node.textContent = item.text;
      }
      node.dataset.renderKey = key;
    }
    return;
  }
  node.className = `message ${item.role}${item.streaming ? " streaming" : ""}`;
  const content = node.querySelector(".message-content");
  const body = node.querySelector(".markdown");
  const metaTime = node.querySelector(".message-meta span");
  if (metaTime) metaTime.textContent = item.pending ? "Sending…" : formatTime(item.timestamp);
  const key = `${item.text}\u0000${item.thinking}\u0000${item.images.join("\u0001")}\u0000${item.tools.map((tool) => `${tool.id}:${tool.status}:${tool.detail}`).join("\u0001")}`;
  if (node.dataset.renderKey === key) {
    return;
  }
  body.innerHTML = markdown(item.text || (item.streaming ? "" : " "));
  content.querySelector(".thinking-block")?.remove();
  content.querySelector(".message-images")?.remove();
  content.querySelector(".tool-list")?.remove();
  if (item.thinking) {
    const details = document.createElement("details");
    details.className = "thinking-block";
    const summary = document.createElement("summary");
    summary.textContent = item.streaming ? "Thinking…" : "Reasoning";
    const thinking = document.createElement("div");
    thinking.className = "thinking-content";
    thinking.textContent = item.thinking;
    details.append(summary, thinking);
    content.insertBefore(details, body);
  }
  if (item.images.length) {
    const images = document.createElement("div");
    images.className = "message-images";
    for (const source of item.images) {
      const image = document.createElement("img");
      image.src = source;
      image.alt = "Attached image";
      image.style.cssText = "max-width:240px;max-height:180px;border-radius:8px;margin-top:8px;object-fit:cover";
      images.append(image);
    }
    content.append(images);
  }
  if (item.tools.length) {
    const list = document.createElement("div");
    list.className = "tool-list";
    for (const tool of item.tools) {
      const card = document.createElement("details");
      card.className = `tool-card ${tool.status}`;
      const head = document.createElement("summary");
      head.className = "tool-head";
      const icon = document.createElement("span");
      icon.className = "tool-icon";
      icon.textContent = tool.status === "complete" ? "✓" : tool.status === "error" ? "!" : "›";
      const name = document.createElement("strong");
      name.textContent = tool.name;
      const state = document.createElement("span");
      state.textContent = tool.status;
      head.append(icon, name, state);
      const detail = document.createElement("pre");
      detail.className = "tool-detail";
      detail.textContent = tool.detail || tool.intent || "";
      card.append(head, detail);
      list.append(card);
    }
    content.append(list);
  }
  node.dataset.renderKey = key;
}

function scheduleMessages(session) {
  if (session.renderScheduled) return;
  session.renderScheduled = true;
  requestAnimationFrame(() => {
    session.renderScheduled = false;
    if (session.id === activeSessionId) renderMessages(session);
  });
}

function renderMessages(session) {
  const nearBottom = elements.conversation.scrollHeight - elements.conversation.scrollTop - elements.conversation.clientHeight < 120;
  const existing = new Map([...elements.message_list.children].map((node) => [node.dataset.messageId, node]));
  for (const item of session.messages) {
    let node = existing.get(item.id);
    if (!node) {
      node = messageNode(item);
    }
    patchMessage(node, item);
    elements.message_list.append(node);
    existing.delete(item.id);
  }
  for (const node of existing.values()) node.remove();
  elements.welcome.classList.toggle("hidden", session.messages.length > 0);
  if (nearBottom || session.status === "streaming") {
    requestAnimationFrame(() => { elements.conversation.scrollTop = elements.conversation.scrollHeight; });
  }
}

function renderChatList() {
  elements.chat_list.replaceChildren();
  for (const session of sessions.values()) {
    const tab = document.createElement("div");
    tab.className = `chat-tab${session.id === activeSessionId ? " active" : ""}${session.status === "exited" ? " exited" : ""}`;
    tab.tabIndex = 0;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(session.id === activeSessionId));
    const state = document.createElement("span");
    state.className = "chat-tab-state";
    const copy = document.createElement("span");
    copy.className = "chat-tab-copy";
    const title = document.createElement("strong");
    title.textContent = session.title;
    const detail = document.createElement("small");
    detail.textContent = session.status === "streaming" ? "OMP is working" : session.status === "connecting" ? "Connecting" : session.status === "exited" ? "Disconnected" : leafName(session.cwd);
    copy.append(title, detail);
    const close = document.createElement("button");
    close.className = "chat-close";
    close.textContent = "×";
    close.title = "Close chat";
    close.addEventListener("click", (event) => { event.stopPropagation(); void closeChat(session.id); });
    tab.append(state, copy, close);
    tab.addEventListener("click", () => setActiveSession(session.id));
    tab.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveSession(session.id); }
    });
    elements.chat_list.append(tab);
  }
  elements.chat_count.textContent = String(sessions.size);
}

function renderState(session) {
  if (!session || session.id !== activeSessionId) return;
  const state = session.state || {};
  const usage = state.contextUsage || {};
  const percent = Math.max(0, Math.min(100, Number(usage.percent || 0)));
  elements.context_percent.textContent = `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
  elements.context_fill.style.width = `${percent}%`;
  elements.context_tokens.textContent = `${Number(usage.tokens || 0).toLocaleString()} tokens`;
  elements.context_window.textContent = usage.contextWindow ? `${Number(usage.contextWindow).toLocaleString()} window` : "— window";
  elements.fast_toggle.classList.toggle("active", Boolean(state.fastModeEnabled));
  elements.fast_toggle.disabled = session.status === "connecting";
  elements.thinking_select.disabled = session.status === "connecting";
  if (state.thinkingLevel) elements.thinking_select.value = state.thinkingLevel;
  renderModelSelect(session);
  renderTodos(state.todoPhases || []);
  elements.activity_live.classList.toggle("active", session.status === "streaming");
}

function renderModelSelect(session) {
  const current = session.state?.model;
  const currentValue = current ? `${current.provider}\u0000${current.id}` : "";
  const previous = elements.model_select.value;
  elements.model_select.replaceChildren();
  if (!session.models.length && current) session.models = [current];
  for (const model of session.models) {
    const option = document.createElement("option");
    option.value = `${model.provider}\u0000${model.id}`;
    option.textContent = `${model.name || model.id} · ${model.provider}`;
    elements.model_select.append(option);
  }
  elements.model_select.disabled = !session.models.length || session.status === "connecting";
  elements.model_select.value = currentValue || previous;
}

function renderTodos(phases) {
  const populatedPhases = phases.filter((phase) => phase.tasks?.length);
  const tasks = populatedPhases.flatMap((phase) => phase.tasks);
  elements.todo_count.textContent = String(tasks.length);
  elements.todo_empty.hidden = tasks.length > 0;
  elements.todo_list.replaceChildren();
  if (!tasks.length) {
    elements.todo_list.append(elements.todo_empty);
  } else {
    for (const task of tasks) {
      const item = document.createElement("div");
      item.className = `todo-item ${task.status || "pending"}`;
      const check = document.createElement("span");
      check.className = "todo-check";
      check.textContent = task.status === "completed" ? "✓" : task.status === "in_progress" ? "•" : "";
      const text = document.createElement("span");
      text.textContent = task.content;
      item.append(check, text);
      elements.todo_list.append(item);
    }
  }

  const hasPlan =
    populatedPhases.length > 1 ||
    populatedPhases.some((phase) => phase.name && !/^(todos?|to do)$/iu.test(phase.name.trim()));
  elements.plan_section.hidden = !hasPlan;
  elements.plan_count.textContent = `${populatedPhases.length} phase${populatedPhases.length === 1 ? "" : "s"}`;
  elements.phase_list.replaceChildren();
  if (hasPlan) {
    for (const phase of populatedPhases) {
      const completed = phase.tasks.filter((task) => task.status === "completed").length;
      const row = document.createElement("div");
      row.className = "phase-row";
      const name = document.createElement("span");
      name.textContent = phase.name || "Phase";
      const progress = document.createElement("span");
      progress.textContent = `${completed}/${phase.tasks.length}`;
      row.append(name, progress);
      elements.phase_list.append(row);
    }
  }
}

function renderActivity(session) {
  if (!session || session.id !== activeSessionId) return;
  const items = [...session.activities.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 7);
  elements.activity_empty.hidden = items.length > 0;
  elements.activity_list.replaceChildren();
  for (const activity of items) {
    const node = document.createElement("div");
    node.className = `activity-item ${activity.status || ""}`;
    const icon = document.createElement("span");
    icon.className = "activity-icon";
    icon.textContent = activity.kind === "subagent" ? "◆" : activity.kind === "system" ? "◫" : "›";
    const content = document.createElement("div");
    content.className = "activity-copy";
    const head = document.createElement("div");
    head.className = "activity-head";
    const name = document.createElement("strong");
    name.textContent = activity.name;
    const status = document.createElement("span");
    status.textContent = activity.status;
    head.append(name, status);
    const detail = document.createElement("p");
    const fullDetail = stripAnsi(activity.detail || "").replace(/\s+/gu, " ").trim();
    detail.textContent = fullDetail.length > 180 ? `${fullDetail.slice(0, 177)}…` : fullDetail;
    detail.title = fullDetail;
    content.append(head, detail);
    node.append(icon, content);
    elements.activity_list.append(node);
  }
}

function renderExtensionWidgets(session) {
  if (!session || session.id !== activeSessionId) return;
  elements.extension_widgets.replaceChildren();
  for (const [key, lines] of session.extensionWidgets) {
    const widget = document.createElement("div");
    widget.className = "extension-widget";
    widget.dataset.key = key;
    widget.textContent = lines.join("\n");
    elements.extension_widgets.append(widget);
  }
  elements.extension_section.hidden = session.extensionWidgets.size === 0;
}

function updateChrome() {
  const session = activeSession();
  elements.new_chat.disabled = !runtimeAvailable || !workspace;
  const connected = session && session.status !== "connecting" && session.status !== "exited";
  const streaming = session?.status === "streaming";
  const hasPrompt = elements.message_input.value.trim().length > 0 || attachments.length > 0;
  elements.send_message.disabled = !connected || !hasPrompt;
  elements.abort_generation.disabled = !streaming;
  elements.attach_image.disabled = !connected;
  elements.show_commands.disabled = !connected;
  document.querySelectorAll(".quick-grid button").forEach((button) => { button.disabled = !connected; });
  if (!session) {
    elements.active_title.textContent = "OMP";
    elements.active_subtitle.textContent = "Start a chat to connect";
    elements.window_title.textContent = "Chat workspace";
    elements.connection_status.className = "";
    elements.connection_status.lastChild.textContent = " Not connected";
    elements.welcome.classList.remove("hidden");
    elements.message_list.replaceChildren();
    renderTodos([]);
    elements.activity_list.replaceChildren();
    elements.activity_empty.hidden = false;
    elements.activity_live.classList.remove("active");
    elements.context_percent.textContent = "0%";
    elements.context_fill.style.width = "0%";
    elements.context_tokens.textContent = "0 tokens";
    elements.context_window.textContent = "— window";
    elements.extension_section.hidden = true;
    return;
  }
  elements.active_title.textContent = session.title;
  elements.active_subtitle.textContent = session.cwd;
  elements.window_title.textContent = `${session.title} — ${leafName(session.cwd)}`;
  elements.connection_status.className = streaming ? "streaming" : connected ? "connected" : "";
  elements.connection_status.lastChild.textContent = streaming ? " OMP is working" : session.status === "connecting" ? " Connecting…" : session.status === "exited" ? " Disconnected" : " Connected";
  elements.queue_label.textContent = session.state?.queuedMessageCount ? `${session.state.queuedMessageCount} queued` : "";
  renderState(session);
}

function setActiveSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  activeSessionId = id;
  renderChatList();
  renderMessages(session);
  renderState(session);
  renderActivity(session);
  renderExtensionWidgets(session);
  renderPalette();
  updateChrome();
  elements.message_input.focus();
}

async function startChat({ initialMessage } = {}) {
  if (!workspace) {
    await chooseWorkspace();
    if (!workspace) return null;
  }
  if (!runtimeAvailable) {
    toast("OMP runtime is unavailable.", "error");
    return null;
  }
  const id = crypto.randomUUID();
  const args = elements.launch_args.value.trim();
  const session = createSession(id, workspace, args);
  setActiveSession(id);
  renderChatList();
  updateChrome();
  try {
    const result = await bridge.startChat({ id, cwd: workspace, args });
    session.status = "ready";
    session.startedAt = result.startedAt;
    session.runtime = result.runtime;
    const [state, commands, models, messages] = await Promise.all([
      rpc(session, { type: "get_state" }),
      rpc(session, { type: "get_available_commands" }),
      rpc(session, { type: "get_available_models" }),
      rpc(session, { type: "get_messages" }),
      rpc(session, { type: "set_subagent_subscription", level: "events" }),
    ]);
    session.state = state;
    session.commands = commands?.commands || session.commands;
    session.models = models?.models || [];
    appendHistory(session, messages?.messages || []);
    renderChatList();
    renderState(session);
    renderPalette();
    updateChrome();
    if (initialMessage) {
      elements.message_input.value = initialMessage;
      autoSizeComposer();
      await sendMessage();
    }
    return session;
  } catch (error) {
    session.status = "exited";
    addMessage(session, { role: "notice", text: cleanError(error), level: "error" });
    renderChatList();
    updateChrome();
    toast(cleanError(error), "error");
    return null;
  }
}

async function closeChat(id) {
  const session = sessions.get(id);
  if (!session) return;
  try { await bridge.stopChat(id); } catch { /* Process already exited. */ }
  sessions.delete(id);
  if (activeSessionId === id) {
    activeSessionId = [...sessions.keys()].at(-1) || null;
  }
  renderChatList();
  if (activeSessionId) setActiveSession(activeSessionId);
  else updateChrome();
}

async function sendMessage() {
  let session = activeSession();
  if (!session) {
    session = await startChat();
    if (!session) return;
  }
  const text = elements.message_input.value.trim();
  if (!text && attachments.length === 0) return;
  const sentAttachments = attachments;
  const images = sentAttachments.map((item) => item.content);
  addMessage(session, {
    role: "user",
    text,
    images: sentAttachments.map((item) => item.preview),
    timestamp: Date.now(),
    pending: true,
  });
  elements.message_input.value = "";
  attachments = [];
  renderAttachments();
  closePalette();
  autoSizeComposer();
  updateChrome();
  try {
    const data = await rpc(session, {
      type: "prompt",
      message: text,
      ...(images.length ? { images } : {}),
      ...(session.status === "streaming" ? { streamingBehavior: "followUp" } : {}),
    });
    if (data?.agentInvoked === false) {
      const pending = [...session.messages].reverse().find((item) => item.role === "user" && item.pending);
      if (pending) pending.pending = false;
      session.status = "ready";
      scheduleMessages(session);
      void refreshState(session);
    }
  } catch (error) {
    const pending = [...session.messages].reverse().find((item) => item.role === "user" && item.pending);
    if (pending) pending.pending = false;
    addMessage(session, { role: "notice", text: cleanError(error), level: "error" });
    toast(cleanError(error), "error");
  }
}

async function runSlashCommand(command) {
  if (!activeSession()) await startChat();
  if (!activeSession()) return;
  elements.message_input.value = command;
  autoSizeComposer();
  await sendMessage();
}

function matchingCommands() {
  const session = activeSession();
  if (!session) return [];
  const value = elements.message_input.value.trimStart();
  const query = value.startsWith("/") ? value.slice(1).split(/\s/u, 1)[0].toLowerCase() : "";
  return session.commands
    .filter((command) => !query || command.name.toLowerCase().includes(query) || command.aliases?.some((alias) => alias.toLowerCase().includes(query)))
    .slice(0, 80);
}

function renderPalette() {
  if (elements.command_palette.hidden) return;
  const commands = matchingCommands();
  paletteSelection = Math.max(0, Math.min(paletteSelection, commands.length - 1));
  elements.palette_results.replaceChildren();
  commands.forEach((command, index) => {
    const item = document.createElement("button");
    item.className = `palette-item${index === paletteSelection ? " selected" : ""}`;
    const name = document.createElement("strong");
    name.textContent = `/${command.name}`;
    const description = document.createElement("span");
    description.textContent = command.description || command.input?.hint || "OMP command";
    const source = document.createElement("small");
    source.textContent = command.source || "builtin";
    item.append(name, description, source);
    item.addEventListener("click", () => selectCommand(command));
    elements.palette_results.append(item);
  });
  if (!commands.length) {
    const empty = document.createElement("div");
    empty.className = "empty-widget";
    empty.textContent = "No matching commands";
    elements.palette_results.append(empty);
  }
}

function openPalette() {
  if (!activeSession()) return;
  paletteSelection = 0;
  elements.command_palette.hidden = false;
  renderPalette();
  elements.message_input.focus();
}

function closePalette() {
  elements.command_palette.hidden = true;
}

function dismissTopLayer() {
  if (!elements.modal_backdrop.hidden) {
    hideModal(true);
    elements.message_input.focus();
    return true;
  }
  if (!elements.command_palette.hidden) {
    closePalette();
    elements.message_input.focus();
    return true;
  }
  if (document.activeElement?.matches("select")) {
    document.activeElement.blur();
    elements.message_input.focus();
    return true;
  }
  return false;
}

function selectCommand(command) {
  closePalette();
  const slash = `/${command.name}`;
  if (command.input?.hint) {
    elements.message_input.value = `${slash} `;
    autoSizeComposer();
    elements.message_input.focus();
    updateChrome();
  } else {
    void runSlashCommand(slash);
  }
}

async function chooseWorkspace() {
  try {
    const directory = await bridge.chooseWorkspace();
    if (directory) setWorkspace(directory);
  } catch (error) {
    toast(cleanError(error), "error");
  }
}

function renderAttachments() {
  elements.attachment_list.replaceChildren();
  attachments.forEach((attachment, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    chip.title = attachment.name;
    const image = document.createElement("img");
    image.src = attachment.preview;
    image.alt = attachment.name;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      attachments.splice(index, 1);
      renderAttachments();
      updateChrome();
    });
    chip.append(image, remove);
    elements.attachment_list.append(chip);
  });
}

async function attachImage() {
  try {
    const attachment = await bridge.chooseAttachment();
    if (attachment) {
      attachments.push(attachment);
      renderAttachments();
      updateChrome();
    }
  } catch (error) {
    toast(cleanError(error), "error");
  }
}

function autoSizeComposer() {
  elements.message_input.style.height = "auto";
  elements.message_input.style.height = `${Math.min(180, elements.message_input.scrollHeight)}px`;
}

async function setModel() {
  const session = activeSession();
  if (!session) return;
  const [provider, modelId] = elements.model_select.value.split("\u0000");
  try {
    const model = await rpc(session, { type: "set_model", provider, modelId });
    if (session.state) session.state.model = model;
    renderState(session);
  } catch (error) {
    toast(cleanError(error), "error");
    renderState(session);
  }
}

async function setThinking() {
  const session = activeSession();
  if (!session) return;
  try {
    await rpc(session, { type: "set_thinking_level", level: elements.thinking_select.value });
    if (session.state) session.state.thinkingLevel = elements.thinking_select.value;
  } catch (error) {
    toast(cleanError(error), "error");
    renderState(session);
  }
}

async function toggleFast() {
  const session = activeSession();
  if (!session) return;
  try {
    const result = await rpc(session, { type: "set_fast_mode", enabled: !session.state?.fastModeEnabled });
    session.state.fastModeEnabled = result.enabled;
    session.state.fastModeActive = result.active;
    renderState(session);
  } catch (error) {
    toast(cleanError(error), "error");
  }
}

async function abortGeneration() {
  const session = activeSession();
  if (!session || session.status !== "streaming") return;
  try {
    await rpc(session, { type: "abort" });
  } catch (error) {
    toast(cleanError(error), "error");
  }
}

async function compactContext() {
  const session = activeSession();
  if (!session) return;
  updateActivity(session, "compaction", { kind: "system", name: "Compacting context", detail: "Requested from desktop", status: "running" });
  try {
    await rpc(session, { type: "compact" });
    toast("Context compacted.");
    void refreshState(session);
  } catch (error) {
    toast(cleanError(error), "error");
  }
}

async function resumeSession() {
  const session = activeSession();
  if (!session || session.status === "streaming") return;
  try {
    const sessionPath = await bridge.chooseSession();
    if (!sessionPath) return;
    const result = await rpc(session, { type: "switch_session", sessionPath });
    if (result?.cancelled) return;
    session.activeAssistantId = null;
    session.tools.clear();
    session.activities.clear();
    const [state, messages] = await Promise.all([
      rpc(session, { type: "get_state" }),
      rpc(session, { type: "get_messages" }),
    ]);
    session.state = state;
    session.title = state.sessionName || leafName(sessionPath).replace(/\.jsonl$/u, "");
    appendHistory(session, messages?.messages || []);
    renderChatList();
    renderState(session);
    renderActivity(session);
    updateChrome();
    toast("Session resumed.");
  } catch (error) {
    toast(cleanError(error), "error");
  }
}

function sendModalResponse(frame) {
  if (!activeModal) return;
  bridge.sendFrame(activeModal.sessionId, { type: "extension_ui_response", id: activeModal.frame.id, ...frame });
  hideModal();
}

function hideModal(cancelled = false) {
  if (cancelled && activeModal) {
    bridge.sendFrame(activeModal.sessionId, { type: "extension_ui_response", id: activeModal.frame.id, cancelled: true });
  }
  activeModal = null;
  elements.modal_backdrop.hidden = true;
  elements.modal_content.replaceChildren();
  elements.modal_actions.replaceChildren();
}

function actionButton(label, callback, primary = false) {
  const button = document.createElement("button");
  button.textContent = label;
  if (primary) button.className = "primary";
  button.addEventListener("click", callback);
  return button;
}

function handleExtensionRequest(session, frame) {
  if (frame.method === "notify") {
    toast(frame.message, frame.notifyType || "info");
    return;
  }
  if (frame.method === "setStatus") {
    if (frame.statusText) session.extensionStatus.set(frame.statusKey, frame.statusText);
    else session.extensionStatus.delete(frame.statusKey);
    updateChrome();
    return;
  }
  if (frame.method === "setWidget") {
    if (frame.widgetLines) session.extensionWidgets.set(frame.widgetKey, frame.widgetLines);
    else session.extensionWidgets.delete(frame.widgetKey);
    renderExtensionWidgets(session);
    return;
  }
  if (frame.method === "setTitle") {
    if (frame.title) session.title = frame.title;
    renderChatList();
    updateChrome();
    return;
  }
  if (frame.method === "set_editor_text") {
    elements.message_input.value = frame.text || "";
    autoSizeComposer();
    updateChrome();
    return;
  }
  if (frame.method === "open_url") {
    void bridge.openExternal(frame.url).catch((error) => toast(cleanError(error), "error"));
    if (frame.instructions) toast(frame.instructions);
    return;
  }
  if (frame.method === "cancel") {
    if (activeModal?.frame.id === frame.targetId) hideModal(false);
    return;
  }

  activeModal = { sessionId: session.id, frame };
  elements.modal_backdrop.hidden = false;
  elements.modal_title.textContent = frame.title || "OMP requests input";
  elements.modal_message.textContent = frame.message || "";
  elements.modal_message.hidden = !frame.message;
  elements.modal_content.replaceChildren();
  elements.modal_actions.replaceChildren();

  if (frame.method === "select") {
    frame.options.forEach((option, index) => {
      const button = document.createElement("button");
      button.className = "modal-option";
      const label = document.createElement("strong");
      label.textContent = option;
      const detail = document.createElement("span");
      detail.textContent = frame.optionDetails?.[index]?.description || "";
      button.append(label, detail);
      button.addEventListener("click", () => sendModalResponse({ value: option }));
      elements.modal_content.append(button);
    });
    elements.modal_actions.append(actionButton("Cancel", () => hideModal(true)));
  } else if (frame.method === "confirm") {
    elements.modal_actions.append(
      actionButton("Cancel", () => sendModalResponse({ confirmed: false })),
      actionButton("Continue", () => sendModalResponse({ confirmed: true }), true),
    );
  } else if (frame.method === "input" || frame.method === "editor") {
    const input = document.createElement(frame.method === "editor" ? "textarea" : "input");
    input.className = "modal-input";
    input.placeholder = frame.placeholder || "";
    input.value = frame.prefill || "";
    elements.modal_content.append(input);
    elements.modal_actions.append(
      actionButton("Cancel", () => hideModal(true)),
      actionButton("Submit", () => sendModalResponse({ value: input.value }), true),
    );
    requestAnimationFrame(() => input.focus());
  }
}

function handleAppCommand(command) {
  if (command === "new-chat") void startChat();
  else if (command === "open-workspace") void chooseWorkspace();
  else if (command === "command-palette") openPalette();
  else if (command === "focus-composer") elements.message_input.focus();
  else if (command === "abort") void abortGeneration();
}

async function initialize() {
  if (!bridge) return;
  disposables.push(bridge.onChatEvent(({ sessionId, frame }) => handleFrame(sessions.get(sessionId), frame)));
  disposables.push(bridge.onChatExit(({ sessionId, expected }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.status = "exited";
    if (!expected) addMessage(session, { role: "notice", text: "OMP disconnected.", level: "error" });
    renderChatList();
    updateChrome();
  }));
  disposables.push(bridge.onCommand(handleAppCommand));
  try {
    const runtime = await bridge.runtimeInfo();
    runtimeAvailable = runtime.available;
    elements.runtime_pill.className = `runtime-pill ${runtime.available ? "ready" : "error"}`;
    elements.runtime_label.textContent = runtime.available ? runtime.label : "OMP runtime missing";
    elements.runtime_pill.title = runtime.available ? `${runtime.label} · ${runtime.targetKey}` : runtime.message;
    if (!runtime.available) toast(runtime.message, "error");
  } catch (error) {
    elements.runtime_pill.className = "runtime-pill error";
    elements.runtime_label.textContent = "Runtime check failed";
    toast(cleanError(error), "error");
  }
  if (!workspace) {
    try { workspace = await bridge.initialWorkspace(); } catch { workspace = ""; }
  }
  setWorkspace(workspace);
  elements.launch_args.value = localStorage.getItem("ompDesktop.launchArgs") || "";
  updateChrome();
  if (runtimeAvailable && workspace) void startChat();
}

elements.choose_workspace.addEventListener("click", () => void chooseWorkspace());
elements.open_workspace_folder.addEventListener("click", () => {
  if (workspace) void bridge.openWorkspace(workspace).catch((error) => toast(cleanError(error), "error"));
});
elements.new_chat.addEventListener("click", () => void startChat());
elements.open_command_palette.addEventListener("click", openPalette);
elements.show_commands.addEventListener("click", openPalette);
elements.attach_image.addEventListener("click", () => void attachImage());
elements.send_message.addEventListener("click", () => void sendMessage());
elements.abort_generation.addEventListener("click", () => void abortGeneration());
elements.model_select.addEventListener("change", () => void setModel());
elements.thinking_select.addEventListener("change", () => void setThinking());
elements.fast_toggle.addEventListener("click", () => void toggleFast());
elements.launch_args.addEventListener("change", () => {
  localStorage.setItem("ompDesktop.launchArgs", elements.launch_args.value.trim());
});
elements.docs_link.addEventListener("click", (event) => {
  event.preventDefault();
  void bridge.openExternal(elements.docs_link.href);
});
elements.modal_close.addEventListener("click", () => hideModal(true));
elements.modal_backdrop.addEventListener("click", (event) => {
  if (event.target === elements.modal_backdrop) hideModal(true);
});
elements.message_input.addEventListener("input", () => {
  autoSizeComposer();
  if (elements.message_input.value.trimStart().startsWith("/")) openPalette();
  else if (!elements.command_palette.hidden) closePalette();
  renderPalette();
  updateChrome();
});
elements.message_input.addEventListener("keydown", (event) => {
  if (!elements.command_palette.hidden) {
    const commands = matchingCommands();
    if (event.key === "ArrowDown") { event.preventDefault(); paletteSelection = Math.min(commands.length - 1, paletteSelection + 1); renderPalette(); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); paletteSelection = Math.max(0, paletteSelection - 1); renderPalette(); return; }
    if (event.key === "Enter" && !event.shiftKey && commands[paletteSelection]) { event.preventDefault(); selectCommand(commands[paletteSelection]); return; }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismissTopLayer();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); }
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  if (event.key !== "Escape" || event.defaultPrevented) return;
  event.preventDefault();
  if (dismissTopLayer()) return;
  void abortGeneration();
});
document.addEventListener("click", (event) => {
  const starter = event.target.closest("[data-starter]");
  if (starter) {
    elements.message_input.value = starter.dataset.starter;
    autoSizeComposer();
    updateChrome();
    elements.message_input.focus();
  }
  const command = event.target.closest("[data-command]");
  if (command) void runSlashCommand(command.dataset.command);
  const action = event.target.closest("[data-action]");
  if (action?.dataset.action === "compact") void compactContext();
  else if (action?.dataset.action === "resume") void resumeSession();
  const link = event.target.closest(".markdown a");
  if (link) { event.preventDefault(); void bridge.openExternal(link.href); }
});
window.addEventListener("beforeunload", () => { for (const dispose of disposables) dispose(); });

void initialize();
