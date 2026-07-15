/* global Terminal, FitAddon */

const { invoke, Channel } = window.__TAURI__.core;
const { open: openDialog } = window.__TAURI__.dialog;
const grid = document.querySelector("#terminal-grid");
const projectList = document.querySelector("#project-list");
const windowList = document.querySelector("#window-list");
const windowCount = document.querySelector("#window-count");
const projectDialog = document.querySelector("#project-dialog");
const windowDialog = document.querySelector("#window-dialog");
const projectForm = document.querySelector("#project-form");
const windowForm = document.querySelector("#window-form");
const newWindowButton = document.querySelector("#new-window-button");
const toast = document.querySelector("#toast");
const terminals = new Map();
const lastAgentActivity = new Map();
const activityTimers = new Map();

let projects = [];
let activeProjectId = localStorage.getItem("agent-grid-project");
let config = { defaultCwd: "~/projects", defaultCommand: "codex" };
let windowKind = "agent";
let layoutMode = localStorage.getItem("agent-grid-mode") || "auto";
let layoutColumns = Math.min(8, Math.max(1, Number(localStorage.getItem("agent-grid-columns")) || 2));
let currentLayout = null;
let draggedWindowId = null;
let maximizedWindowId = null;
let toastTimer;
let statusTimer;
let statusRequestInFlight = false;

const shellCommands = new Set(["bash", "dash", "elvish", "fish", "nu", "pwsh", "sh", "tcsh", "zsh"]);
const activityQuietMs = 5000;

const activeProject = () => projects.find((project) => project.id === activeProjectId) || null;
const activeWindows = () => activeProject()?.windows || [];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortPath(value) {
  const home = config.defaultCwd.replace(/\/projects\/?$/, "");
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("visible");
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

function activityInfo(window) {
  if (window.state !== "running") return { state: "stopped", label: "Stopped" };
  const command = String(window.currentCommand || "").toLowerCase();
  const atShell = !command || shellCommands.has(command);
  if (window.kind === "terminal") {
    return atShell ? { state: "ready", label: "Ready" } : { state: "running", label: "Busy" };
  }
  if (atShell) return { state: "idle", label: "Agent exited" };
  const lastActivity = Math.max(lastAgentActivity.get(window.id) || 0, Number(window.lastActivityAt) || 0);
  const recentlyActive = Date.now() - lastActivity < activityQuietMs;
  return recentlyActive ? { state: "running", label: "Running" } : { state: "waiting", label: "Waiting" };
}

function workingAgentCount(project) {
  return project.windows.filter((window) => window.kind === "agent" && activityInfo(window).state === "running").length;
}

function activityVisual(window) {
  const activity = activityInfo(window);
  return `<span class="activity-visual ${activity.state}" data-status-window="${window.id}" title="${activity.label}">
    <span class="status-dot"></span><span class="activity-bars"><i></i><i></i><i></i></span>
  </span>`;
}

async function call(command, args = {}) {
  try {
    return await invoke(command, args);
  } catch (error) {
    throw new Error(typeof error === "string" ? error : error?.message || "Native command failed.");
  }
}

const leaf = (id) => ({ type: "leaf", id });

function combineEven(nodes, direction) {
  if (!nodes.length) return null;
  if (nodes.length === 1) return nodes[0];
  return {
    type: "split",
    direction,
    ratio: 1 / nodes.length,
    first: nodes[0],
    second: combineEven(nodes.slice(1), direction)
  };
}

function buildGridTree(ids, columns) {
  if (!ids.length) return null;
  const rows = [];
  for (let index = 0; index < ids.length; index += columns) {
    rows.push(combineEven(ids.slice(index, index + columns).map(leaf), "horizontal"));
  }
  return combineEven(rows, "vertical");
}

function automaticColumns(count) {
  return Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count * 1.5))));
}

function pruneLayout(node, validIds) {
  if (!node) return null;
  if (node.type === "leaf") return validIds.has(node.id) ? node : null;
  const first = pruneLayout(node.first, validIds);
  const second = pruneLayout(node.second, validIds);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second, ratio: Math.min(0.8, Math.max(0.2, Number(node.ratio) || 0.5)) };
}

function collectLeafIds(node, output = []) {
  if (!node) return output;
  if (node.type === "leaf") output.push(node.id);
  else {
    collectLeafIds(node.first, output);
    collectLeafIds(node.second, output);
  }
  return output;
}

function shallowestLeafPath(node, path = [], best = null) {
  if (!node) return best;
  if (node.type === "leaf") return !best || path.length < best.length ? path : best;
  return shallowestLeafPath(node.second, [...path, "second"], shallowestLeafPath(node.first, [...path, "first"], best));
}

function nodeAtPath(node, path) {
  return path.reduce((current, part) => current?.[part], node);
}

function replaceAtPath(node, path, replacement) {
  if (!path.length) return replacement;
  const [part, ...rest] = path;
  return { ...node, [part]: replaceAtPath(node[part], rest, replacement) };
}

function addToLayout(node, id) {
  if (!node) return leaf(id);
  const path = shallowestLeafPath(node);
  const target = nodeAtPath(node, path);
  return replaceAtPath(node, path, {
    type: "split",
    direction: path.length % 2 === 0 ? "horizontal" : "vertical",
    ratio: 0.5,
    first: target,
    second: leaf(id)
  });
}

function reconcileLayout(saved, ids) {
  const valid = new Set(ids);
  let layout = pruneLayout(saved, valid);
  const present = new Set(collectLeafIds(layout));
  for (const id of ids) if (!present.has(id)) layout = addToLayout(layout, id);
  return layout;
}

function layoutKey(projectId) {
  return `agent-grid-layout-${projectId}`;
}

function loadLayout() {
  const ids = activeWindows().map((window) => window.id);
  if (!ids.length) return null;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(layoutKey(activeProjectId))); } catch { /* use a clean layout */ }
  if (!saved) {
    const columns = layoutMode === "auto" ? automaticColumns(ids.length) : layoutColumns;
    saved = buildGridTree(ids, columns);
  }
  const reconciled = reconcileLayout(saved, ids);
  localStorage.setItem(layoutKey(activeProjectId), JSON.stringify(reconciled));
  return reconciled;
}

function saveLayout() {
  if (activeProjectId && currentLayout) localStorage.setItem(layoutKey(activeProjectId), JSON.stringify(currentLayout));
}

function removeLeaf(node, id) {
  if (!node) return null;
  if (node.type === "leaf") return node.id === id ? null : node;
  const first = removeLeaf(node.first, id);
  const second = removeLeaf(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function replaceLeaf(node, id, replacement) {
  if (node.type === "leaf") return node.id === id ? replacement : node;
  return { ...node, first: replaceLeaf(node.first, id, replacement), second: replaceLeaf(node.second, id, replacement) };
}

function swapLeaves(node, firstId, secondId) {
  if (node.type === "leaf") {
    if (node.id === firstId) return leaf(secondId);
    if (node.id === secondId) return leaf(firstId);
    return node;
  }
  return { ...node, first: swapLeaves(node.first, firstId, secondId), second: swapLeaves(node.second, firstId, secondId) };
}

function moveWindow(sourceId, targetId, zone) {
  if (!currentLayout || sourceId === targetId) return;
  if (zone === "center") {
    currentLayout = swapLeaves(currentLayout, sourceId, targetId);
  } else {
    currentLayout = removeLeaf(currentLayout, sourceId);
    const direction = ["left", "right"].includes(zone) ? "horizontal" : "vertical";
    const sourceFirst = ["left", "top"].includes(zone);
    const split = {
      type: "split", direction, ratio: 0.5,
      first: sourceFirst ? leaf(sourceId) : leaf(targetId),
      second: sourceFirst ? leaf(targetId) : leaf(sourceId)
    };
    currentLayout = replaceLeaf(currentLayout, targetId, split);
  }
  layoutMode = "custom";
  localStorage.setItem("agent-grid-mode", layoutMode);
  saveLayout();
}

async function disposeTerminals() {
  const entries = [...terminals.entries()];
  terminals.clear();
  for (const [, entry] of entries) {
    entry.observer.disconnect();
    clearTimeout(entry.inputTimer);
    clearTimeout(entry.resizeTimer);
    entry.terminal.dispose();
  }
  await Promise.allSettled(entries.map(([id]) => call("detach_terminal", { id })));
}

function queueTerminalInput(id, entry, data) {
  entry.inputBuffer += data;
  if (entry.inputTimer) return;
  entry.inputTimer = setTimeout(async () => {
    const buffered = entry.inputBuffer;
    entry.inputBuffer = "";
    entry.inputTimer = null;
    if (buffered) await call("write_terminal", { id, data: buffered }).catch(() => {});
  }, 8);
}

function windowById(id) {
  for (const project of projects) {
    const window = project.windows.find((item) => item.id === id);
    if (window) return window;
  }
  return null;
}

function updateStatusIndicator(window) {
  const activity = activityInfo(window);
  document.querySelectorAll(`[data-status-window="${window.id}"]`).forEach((element) => {
    element.className = `activity-visual ${activity.state}`;
    element.title = activity.label;
  });
  document.querySelectorAll(`[data-status-label="${window.id}"]`).forEach((element) => {
    element.className = `activity-text ${activity.state}`;
    element.textContent = activity.label;
  });
  document.querySelectorAll(`[data-process-window="${window.id}"]`).forEach((element) => {
    element.textContent = window.currentCommand || (window.state === "running" ? shortPath(window.cwd) : "stopped");
  });
}

function noteAgentOutput(window, entry) {
  if (window.kind !== "agent") return;
  const now = Date.now();
  // Attaching a PTY redraws the existing screen. Likewise, typed characters are
  // echoed by the TUI; neither means the agent has started doing work.
  if (now < entry.observeActivityAfter || now - entry.lastInputAt < 160) return;
  lastAgentActivity.set(window.id, now);
  updateStatusIndicator(window);
  clearTimeout(activityTimers.get(window.id));
  activityTimers.set(window.id, setTimeout(() => {
    activityTimers.delete(window.id);
    const current = windowById(window.id);
    if (current) updateStatusIndicator(current);
  }, activityQuietMs + 40));
}

function renderProjects() {
  projectList.innerHTML = projects.map((project) => {
    const working = workingAgentCount(project);
    return `
    <div class="project-row ${project.id === activeProjectId ? "active" : ""}">
      <button class="project-item" data-project-id="${project.id}" title="${escapeHtml(project.cwd)}">
        <span class="project-icon">⌘</span>
        <span class="project-copy">
          <span class="project-title">
            <span class="project-name">${escapeHtml(project.name)}</span>
            <span class="project-running ${working ? "" : "empty"}" data-working-agents="${project.id}" title="${working} agent${working === 1 ? "" : "s"} working">${working} working</span>
          </span>
          <span class="project-count">${project.windows.length} window${project.windows.length === 1 ? "" : "s"}</span>
        </span>
      </button>
      <button class="project-delete icon-button" data-delete-project="${project.id}" title="Delete project">×</button>
    </div>`;
  }).join("");
}

function renderWindows() {
  const windows = activeWindows();
  windowCount.textContent = windows.length;
  windowList.innerHTML = windows.map((window) => `
    <button class="agent-list-item" data-scroll-window="${window.id}">
      ${activityVisual(window)}
      <span class="agent-list-copy">
        <span class="agent-list-name"><span class="kind-mini">${window.kind === "terminal" ? "›_" : "◆"}</span>${escapeHtml(window.name)}</span>
        <span class="agent-list-path"><span class="activity-text ${activityInfo(window).state}" data-status-label="${window.id}">${activityInfo(window).label}</span> · <span data-process-window="${window.id}">${escapeHtml(window.currentCommand || shortPath(window.cwd))}</span></span>
      </span>
    </button>`).join("");
}

function renderEmptyState() {
  if (!projects.length) {
    grid.innerHTML = `<section class="empty-state"><div>
      <div class="empty-glyph">⌘</div><h2>Create your first project</h2>
      <p>A project groups persistent agent and terminal windows under one working directory.</p>
      <button class="button primary" data-action="empty-project">＋ New project</button>
    </div></section>`;
  } else {
    grid.innerHTML = `<section class="empty-state"><div>
      <div class="empty-glyph">›_</div><h2>No windows in ${escapeHtml(activeProject().name)}</h2>
      <p>Open a coding agent or a normal terminal. Both remain alive in tmux when the app closes.</p>
      <button class="button primary" data-action="empty-window">＋ New window</button>
    </div></section>`;
  }
}

function cardTemplate(window) {
  const running = window.state === "running";
  const kindLabel = window.kind === "terminal" ? "terminal" : "agent";
  return `<section class="terminal-card ${maximizedWindowId === window.id ? "maximized" : ""}" id="window-${window.id}" data-window-id="${window.id}">
    <header class="terminal-header" draggable="true">
      <div class="terminal-meta">
        <span class="drag-grip" title="Drag to tile">⠿</span>${activityVisual(window)}
        <span class="terminal-name" title="${escapeHtml(window.cwd)}">${escapeHtml(window.name)}</span>
        <span class="terminal-kind">${kindLabel}</span><span class="activity-text ${activityInfo(window).state}" data-status-label="${window.id}">${activityInfo(window).label}</span><span class="terminal-process" data-process-window="${window.id}">${escapeHtml(window.currentCommand || window.state)}</span>
      </div>
      <div class="card-actions">
        ${running ? "" : `<button class="icon-button" data-action="restart" title="Restart">↻</button>`}
        <button class="icon-button" data-action="maximize" title="Maximize">${maximizedWindowId === window.id ? "↙" : "□"}</button>
        <button class="icon-button danger-button" data-action="delete" title="Kill and remove">×</button>
      </div>
    </header>
    <div class="terminal-body" data-terminal-id="${window.id}">${running ? "" : `
      <div class="stopped-state"><div><h3>Window stopped</h3><p>Restart it to open the ${kindLabel} again.</p>
      <button class="button primary" data-action="restart">Restart</button></div></div>`}</div>
    <div class="drop-overlay" aria-hidden="true">
      <div class="drop-zone top" data-drop="top">Top</div><div class="drop-zone right" data-drop="right">Right</div>
      <div class="drop-zone bottom" data-drop="bottom">Bottom</div><div class="drop-zone left" data-drop="left">Left</div>
      <div class="drop-zone center" data-drop="center">Swap</div>
    </div>
  </section>`;
}

function renderLayoutNode(node, path = []) {
  if (node.type === "leaf") {
    const window = activeWindows().find((item) => item.id === node.id);
    return window ? `<div class="tile-branch tile-leaf">${cardTemplate(window)}</div>` : "";
  }
  const ratio = Math.min(0.8, Math.max(0.2, node.ratio || 0.5));
  const encodedPath = path.join(".");
  return `<div class="tile-split ${node.direction}" data-split-path="${encodedPath}">
    <div class="tile-branch split-first" style="flex-basis:calc(${ratio * 100}% - 3px)">${renderLayoutNode(node.first, [...path, "first"])}</div>
    <div class="split-handle" data-resize-path="${encodedPath}" title="Drag to resize"></div>
    <div class="tile-branch split-second">${renderLayoutNode(node.second, [...path, "second"])}</div>
  </div>`;
}

async function connectTerminal(window) {
  const container = document.querySelector(`[data-terminal-id="${window.id}"]`);
  if (!container || window.state !== "running") return;
  const terminal = new Terminal({
    cursorBlink: true, cursorStyle: "bar", fontSize: 11, lineHeight: 1.2, scrollback: 5000,
    fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono Nerd Font", "Noto Sans Mono", monospace',
    theme: {
      background: "#0c0e10", foreground: "#d7d9dc", cursor: "#d7ff5f", selectionBackground: "#3d4730",
      black: "#181a1d", brightBlack: "#666d76", green: "#b7dc5b", brightGreen: "#d7ff5f",
      red: "#ef6b73", brightRed: "#ff858c", blue: "#68a7e8", brightBlue: "#8fc2f4",
      yellow: "#d9b85c", brightYellow: "#efd27d", magenta: "#b891d6", brightMagenta: "#d2acef",
      cyan: "#69b9b1", brightCyan: "#8bd5cc", white: "#c8cbd0", brightWhite: "#ffffff"
    }
  });
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  const entry = {
    terminal, fitAddon, observer: null, inputBuffer: "", inputTimer: null, resizeTimer: null,
    channel: new Channel(), lastInputAt: 0, observeActivityAfter: Date.now() + 900
  };
  terminals.set(window.id, entry);
  entry.channel.onmessage = (message) => {
    if (message.event === "output" && message.data.id === window.id) {
      terminal.write(message.data.data);
      noteAgentOutput(window, entry);
    }
    if (message.event === "exit" && message.data.id === window.id) terminal.write("\r\n\x1b[38;5;244m[terminal detached]\x1b[0m\r\n");
  };

  terminal.onData((data) => {
    entry.lastInputAt = Date.now();
    queueTerminalInput(window.id, entry, data);
  });

  // Match the user's Kitty mapping: Ctrl+F emits the private sequence Fish
  // binds to the `project_cd` fzf picker.
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown") {
        entry.lastInputAt = Date.now();
        queueTerminalInput(window.id, entry, "\x1fFZF_PROJECT_CD\x1e");
      }
      return false;
    }
    return true;
  });

  entry.observer = new ResizeObserver(() => {
    clearTimeout(entry.resizeTimer);
    entry.resizeTimer = setTimeout(() => {
      if (!container.isConnected || container.offsetParent === null) return;
      fitAddon.fit();
      call("resize_terminal", { id: window.id, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
    }, 40);
  });
  entry.observer.observe(container);

  try {
    await call("attach_terminal", { id: window.id, cols: terminal.cols, rows: terminal.rows, onEvent: entry.channel });
  } catch (error) {
    terminal.write(`\r\n\x1b[31m${error.message}\x1b[0m\r\n`);
  }
}

function updateLayoutControls() {
  document.querySelector("#auto-grid-button").classList.toggle("active", layoutMode === "auto");
  document.querySelector("#column-count").textContent = layoutMode === "auto" ? "Auto" : layoutMode === "custom" ? "Custom" : String(layoutColumns);
  document.querySelector("#fewer-columns-button").disabled = layoutMode === "custom" || (layoutMode === "manual" && layoutColumns <= 1);
  document.querySelector("#more-columns-button").disabled = layoutMode === "custom" || layoutColumns >= 8;
}

async function render() {
  await disposeTerminals();
  renderProjects();
  renderWindows();
  updateLayoutControls();
  const project = activeProject();
  document.querySelector("#workspace-title").textContent = project ? project.name : "Agent Grid";
  newWindowButton.disabled = !project;
  maximizedWindowId = null;
  grid.classList.remove("has-maximized", "drag-active");

  if (!activeWindows().length) {
    currentLayout = null;
    renderEmptyState();
    return;
  }
  currentLayout = loadLayout();
  grid.innerHTML = `<div class="tile-root">${renderLayoutNode(currentLayout)}</div>`;
  await Promise.all(activeWindows().map(connectTerminal));
}

async function refreshProjects({ quiet = false } = {}) {
  try {
    projects = await call("get_projects");
    if (!projects.some((project) => project.id === activeProjectId)) activeProjectId = projects[0]?.id || null;
    if (activeProjectId) localStorage.setItem("agent-grid-project", activeProjectId);
    else localStorage.removeItem("agent-grid-project");
    await render();
    if (!quiet) showToast("Projects refreshed.");
  } catch (error) { showToast(error.message, true); }
}

function updateStatusIndicators() {
  for (const project of projects) {
    for (const window of project.windows) {
      updateStatusIndicator(window);
    }
  }
  updateProjectWorkingCounts();
}

function updateProjectWorkingCounts() {
  for (const project of projects) {
    const count = workingAgentCount(project);
    const element = document.querySelector(`[data-working-agents="${project.id}"]`);
    if (!element) continue;
    element.textContent = `${count} working`;
    element.title = `${count} agent${count === 1 ? "" : "s"} working`;
    element.classList.toggle("empty", count === 0);
  }
}

async function pollStatuses() {
  clearTimeout(statusTimer);
  if (!document.hidden && !statusRequestInFlight) {
    statusRequestInFlight = true;
    try {
      projects = await call("get_projects");
      updateStatusIndicators();
    } catch {
      // A temporary tmux query failure should not interrupt active terminals.
    } finally {
      statusRequestInFlight = false;
    }
  }
  statusTimer = setTimeout(pollStatuses, 2500);
}

function openProjectModal() {
  document.querySelector("#project-name").value = `Project ${projects.length + 1}`;
  document.querySelector("#project-cwd").value = config.defaultCwd;
  document.querySelector("#project-command").value = config.defaultCommand;
  projectDialog.showModal();
  document.querySelector("#project-name").select();
}

function setWindowKind(kind) {
  windowKind = kind;
  document.querySelectorAll(".kind-option").forEach((button) => button.classList.toggle("active", button.dataset.kind === kind));
  document.querySelector("#command-field").hidden = kind === "terminal";
  document.querySelector("#window-command").required = kind === "agent";
  if (windowDialog.open) document.querySelector("#window-name").value = kind === "terminal" ? "Terminal" : `Agent ${activeWindows().length + 1}`;
}

function openWindowModal() {
  const project = activeProject();
  if (!project) return openProjectModal();
  document.querySelector("#window-cwd").value = project.cwd;
  document.querySelector("#window-command").value = project.defaultCommand;
  windowDialog.showModal();
  setWindowKind("agent");
  document.querySelector("#window-name").select();
}

async function browseDirectory(inputId) {
  const input = document.querySelector(`#${inputId}`);
  try {
    const selected = await openDialog({ directory: true, multiple: false, defaultPath: input.value || config.defaultCwd, title: "Choose a working directory" });
    if (typeof selected === "string") input.value = selected;
  } catch (error) { showToast(String(error), true); }
}

async function restartWindow(id) {
  try {
    await call("restart_window", { id });
    await refreshProjects({ quiet: true });
    showToast("Window restarted.");
  } catch (error) { showToast(error.message, true); }
}

async function deleteWindow(id) {
  const window = activeWindows().find((item) => item.id === id);
  if (!window || !confirm(`Kill and remove “${window.name}”?`)) return;
  try {
    await call("delete_window", { id });
    await refreshProjects({ quiet: true });
    showToast(`${window.name} removed.`);
  } catch (error) { showToast(error.message, true); }
}

async function deleteProject(id) {
  const project = projects.find((item) => item.id === id);
  if (!project || !confirm(`Delete “${project.name}” and kill its ${project.windows.length} window(s)?`)) return;
  try {
    await call("delete_project", { id });
    await refreshProjects({ quiet: true });
    showToast(`${project.name} deleted.`);
  } catch (error) { showToast(error.message, true); }
}

function retile(mode, columns = layoutColumns) {
  layoutMode = mode;
  layoutColumns = Math.min(8, Math.max(1, columns));
  localStorage.setItem("agent-grid-mode", layoutMode);
  localStorage.setItem("agent-grid-columns", String(layoutColumns));
  const ids = activeWindows().map((window) => window.id);
  currentLayout = buildGridTree(ids, mode === "auto" ? automaticColumns(ids.length) : layoutColumns);
  saveLayout();
  render();
}

function toggleMaximize(card) {
  maximizedWindowId = maximizedWindowId === card.dataset.windowId ? null : card.dataset.windowId;
  document.querySelectorAll(".terminal-card").forEach((item) => item.classList.toggle("maximized", item.dataset.windowId === maximizedWindowId));
  grid.classList.toggle("has-maximized", Boolean(maximizedWindowId));
  card.querySelector('[data-action="maximize"]').textContent = maximizedWindowId ? "↙" : "□";
  requestAnimationFrame(() => terminals.get(card.dataset.windowId)?.fitAddon.fit());
}

document.querySelector("#new-project-button").addEventListener("click", openProjectModal);
newWindowButton.addEventListener("click", openWindowModal);
document.querySelector("#refresh-button").addEventListener("click", () => refreshProjects());
document.querySelector("#auto-grid-button").addEventListener("click", () => retile("auto"));
document.querySelector("#fewer-columns-button").addEventListener("click", () => retile("manual", layoutMode === "auto" ? 1 : layoutColumns - 1));
document.querySelector("#more-columns-button").addEventListener("click", () => retile("manual", layoutMode === "auto" ? 2 : layoutColumns + 1));
document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll(".browse-button").forEach((button) => button.addEventListener("click", () => browseDirectory(button.dataset.browse)));
document.querySelectorAll(".kind-option").forEach((button) => button.addEventListener("click", () => setWindowKind(button.dataset.kind)));

projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#create-project-button");
  button.disabled = true;
  try {
    const project = await call("create_project", { input: {
      name: document.querySelector("#project-name").value,
      cwd: document.querySelector("#project-cwd").value,
      defaultCommand: document.querySelector("#project-command").value
    }});
    activeProjectId = project.id;
    projectDialog.close();
    await refreshProjects({ quiet: true });
    showToast("Project created.");
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});

windowForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const project = activeProject();
  if (!project) return;
  const button = document.querySelector("#spawn-button");
  button.disabled = true;
  try {
    await call("create_window", { projectId: project.id, input: {
      name: document.querySelector("#window-name").value,
      cwd: document.querySelector("#window-cwd").value,
      command: windowKind === "agent" ? document.querySelector("#window-command").value : null,
      kind: windowKind
    }});
    windowDialog.close();
    await refreshProjects({ quiet: true });
    showToast(windowKind === "agent" ? "Agent opened." : "Terminal opened.");
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});

projectList.addEventListener("click", async (event) => {
  const deleteId = event.target.closest("[data-delete-project]")?.dataset.deleteProject;
  if (deleteId) return deleteProject(deleteId);
  const id = event.target.closest("[data-project-id]")?.dataset.projectId;
  if (!id || id === activeProjectId) return;
  activeProjectId = id;
  localStorage.setItem("agent-grid-project", id);
  await render();
});

windowList.addEventListener("click", (event) => {
  const id = event.target.closest("[data-scroll-window]")?.dataset.scrollWindow;
  document.querySelector(`#window-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

grid.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "empty-project") return openProjectModal();
  if (action === "empty-window") return openWindowModal();
  const card = event.target.closest(".terminal-card");
  if (!card) return;
  if (action === "restart") restartWindow(card.dataset.windowId);
  if (action === "delete") deleteWindow(card.dataset.windowId);
  if (action === "maximize") toggleMaximize(card);
});

grid.addEventListener("dragstart", (event) => {
  const header = event.target.closest(".terminal-header[draggable]");
  if (!header || event.target.closest("button")) {
    event.preventDefault();
    return;
  }
  draggedWindowId = header.closest(".terminal-card").dataset.windowId;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedWindowId);
  requestAnimationFrame(() => grid.classList.add("drag-active"));
});

grid.addEventListener("dragend", () => {
  draggedWindowId = null;
  grid.classList.remove("drag-active");
  document.querySelectorAll(".drop-zone.over").forEach((zone) => zone.classList.remove("over"));
});

grid.addEventListener("dragover", (event) => {
  const zone = event.target.closest(".drop-zone");
  if (!zone) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".drop-zone.over").forEach((item) => item.classList.toggle("over", item === zone));
});

grid.addEventListener("drop", async (event) => {
  const zone = event.target.closest(".drop-zone");
  const card = event.target.closest(".terminal-card");
  if (!zone || !card || !draggedWindowId) return;
  event.preventDefault();
  moveWindow(draggedWindowId, card.dataset.windowId, zone.dataset.drop);
  draggedWindowId = null;
  grid.classList.remove("drag-active");
  await render();
});

grid.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest(".split-handle");
  if (!handle || !currentLayout) return;
  event.preventDefault();
  const path = handle.dataset.resizePath ? handle.dataset.resizePath.split(".") : [];
  const node = nodeAtPath(currentLayout, path);
  const split = handle.closest(".tile-split");
  const first = split.querySelector(":scope > .split-first");
  const rect = split.getBoundingClientRect();
  handle.setPointerCapture(event.pointerId);
  handle.classList.add("resizing");

  const move = (pointerEvent) => {
    const raw = node.direction === "horizontal"
      ? (pointerEvent.clientX - rect.left) / rect.width
      : (pointerEvent.clientY - rect.top) / rect.height;
    node.ratio = Math.min(0.8, Math.max(0.2, raw));
    first.style.flexBasis = `calc(${node.ratio * 100}% - 3px)`;
    requestAnimationFrame(() => terminals.forEach((entry) => entry.fitAddon.fit()));
  };
  const finish = () => {
    handle.classList.remove("resizing");
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", finish);
    layoutMode = "custom";
    localStorage.setItem("agent-grid-mode", layoutMode);
    saveLayout();
    updateLayoutControls();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
});

async function init() {
  try { config = await call("get_config"); }
  catch (error) { showToast(error.message, true); }
  await refreshProjects({ quiet: true });
  pollStatuses();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollStatuses();
});
window.addEventListener("beforeunload", () => clearTimeout(statusTimer));

init();
