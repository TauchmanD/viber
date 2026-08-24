/* global Terminal, FitAddon, UiLayout */

const { invoke, Channel } = window.__TAURI__.core;
const tauriListen = window.__TAURI__.event?.listen;
const popoutWindowId = new URLSearchParams(window.location.search).get("popout");
const { open: openDialog } = window.__TAURI__.dialog;
const { writeText } = window.__TAURI__.clipboardManager;
const { openUrl } = window.__TAURI__.opener;
const workspace = document.querySelector(".workspace");
const sidebar = document.querySelector(".sidebar");
const sidebarFooter = document.querySelector(".sidebar-footer");
const sidebarWidthResizer = document.querySelector("#sidebar-width-resizer");
const sidebarSectionResizer = document.querySelector("#sidebar-section-resizer");
const grid = document.querySelector("#terminal-grid");
const projectList = document.querySelector("#project-list");
const windowList = document.querySelector("#window-list");
const windowCount = document.querySelector("#window-count");
const projectDialog = document.querySelector("#project-dialog");
const windowDialog = document.querySelector("#window-dialog");
const settingsDialog = document.querySelector("#settings-dialog");
const projectForm = document.querySelector("#project-form");
const windowForm = document.querySelector("#window-form");
const newWindowButton = document.querySelector("#new-window-button");
const projectContextMenu = document.querySelector("#project-context-menu");
const compactDrawer = document.querySelector("#compact-drawer");
const compactDrawerBackdrop = document.querySelector("#compact-drawer-backdrop");
const compactProjectList = document.querySelector("#compact-project-list");
const compactWindowList = document.querySelector("#compact-window-list");
const toast = document.querySelector("#toast");
const activityPanel = document.querySelector("#activity-panel");
const activityTimeline = document.querySelector("#activity-timeline");
const activityPanelPorts = document.querySelector("#activity-panel-ports");
const terminals = new Map();
const sidebarWidthKey = "agent-grid-sidebar-width";
const projectSectionShareKey = "agent-grid-projects-share";
const legacyProjectSectionHeightKey = "agent-grid-projects-height";

let projects = [];
let activeProjectId = localStorage.getItem("agent-grid-project");
let config = { defaultCwd: "~/projects", defaultCommand: "omp" };
let windowKind = "agent";
let layoutMode = localStorage.getItem("agent-grid-mode") || "auto";
let layoutColumns = Math.min(8, Math.max(1, Number(localStorage.getItem("agent-grid-columns")) || 2));
let terminalFontSize = Math.min(24, Math.max(8, Number(localStorage.getItem("agent-grid-font-size")) || 11));
let sidebarWidth = UiLayout.clampSidebarWidth(localStorage.getItem(sidebarWidthKey));
let projectSectionShare = localStorage.getItem(projectSectionShareKey);
let projectSectionHeight = 0;
let currentLayout = null;
let draggedWindowId = null;
let maximizedWindowId = null;
let editingProjectId = null;
let contextProjectId = null;
let draggedProjectId = null;
let compactMode = false;
let compactPreviousMaximizedId = null;
const poppedOutWindowIds = new Set();
const popoutChannel = typeof BroadcastChannel === "function"
  ? new BroadcastChannel("agent-grid-chat-popouts")
  : null;
let toastTimer;
let statusTimer;
let statusRequestInFlight = false;
let selectedWindowId = null;
let timelineFilter = "all";
let timelineEvents = [];
let handoffInFlight = false;

const activityQuietMs = 5000;

const activeProject = () => projects.find((project) => project.id === activeProjectId) || null;
const activeWindows = () => {
  const windows = activeProject()?.windows || [];
  return popoutWindowId ? windows.filter((window) => window.id === popoutWindowId) : windows;
};

function availableSidebarHeight() {
  return sidebar.clientHeight - sidebarFooter.offsetHeight - sidebarSectionResizer.offsetHeight;
}

function applySidebarWidth(value, persist = false) {
  sidebarWidth = UiLayout.clampSidebarWidth(value);
  workspace.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
  sidebarWidthResizer.setAttribute("aria-valuenow", String(sidebarWidth));
  if (persist) localStorage.setItem(sidebarWidthKey, String(sidebarWidth));
}

function applyProjectSectionShare(value, persist = false, remember = true) {
  const availableHeight = availableSidebarHeight();
  projectSectionHeight = UiLayout.projectHeightFromShare(value, availableHeight);
  if (remember) projectSectionShare = projectSectionHeight / availableHeight;
  sidebar.style.setProperty("--projects-height", `${projectSectionHeight}px`);
  sidebarSectionResizer.setAttribute("aria-valuemin", "110");
  sidebarSectionResizer.setAttribute("aria-valuemax", String(Math.max(110, availableHeight - 120)));
  sidebarSectionResizer.setAttribute("aria-valuenow", String(projectSectionHeight));
  if (persist) {
    localStorage.setItem(projectSectionShareKey, String(projectSectionShare));
    localStorage.removeItem(legacyProjectSectionHeightKey);
  }
}

function applyProjectSectionHeight(value, persist = false) {
  applyProjectSectionShare(
    UiLayout.projectShareFromHeight(value, availableSidebarHeight()),
    persist,
  );
}

function bindPointerResizer(handle, update, commit) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("resizing");

    const move = (pointerEvent) => update(pointerEvent);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      handle.classList.remove("resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
      handle.removeEventListener("lostpointercapture", finish);
      commit();
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  });
}

bindPointerResizer(
  sidebarWidthResizer,
  (event) => applySidebarWidth(event.clientX - workspace.getBoundingClientRect().left),
  () => localStorage.setItem(sidebarWidthKey, String(sidebarWidth)),
);
bindPointerResizer(
  sidebarSectionResizer,
  (event) => applyProjectSectionHeight(event.clientY - sidebar.getBoundingClientRect().top),
  () => {
    localStorage.setItem(projectSectionShareKey, String(projectSectionShare));
    localStorage.removeItem(legacyProjectSectionHeightKey);
  },
);

sidebarWidthResizer.addEventListener("keydown", (event) => {
  let next = sidebarWidth;
  if (event.key === "ArrowLeft") next -= 16;
  else if (event.key === "ArrowRight") next += 16;
  else if (event.key === "Home") next = 210;
  else if (event.key === "End") next = 420;
  else return;
  event.preventDefault();
  applySidebarWidth(next, true);
});

sidebarSectionResizer.addEventListener("keydown", (event) => {
  let next = projectSectionHeight;
  if (event.key === "ArrowUp") next -= 24;
  else if (event.key === "ArrowDown") next += 24;
  else if (event.key === "Home") next = 110;
  else if (event.key === "End") next = Number(sidebarSectionResizer.getAttribute("aria-valuemax"));
  else return;
  event.preventDefault();
  applyProjectSectionHeight(next, true);
});

if (popoutWindowId) {
  document.body.classList.add("popout-mode");
} else {
  applySidebarWidth(sidebarWidth);
  if (projectSectionShare === null) {
    projectSectionShare = UiLayout.projectShareFromHeight(
      localStorage.getItem(legacyProjectSectionHeightKey),
      availableSidebarHeight(),
    );
  }
  applyProjectSectionShare(projectSectionShare);
}

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

async function copyText(value, message = "Copied to clipboard.") {
  try {
    await writeText(value);
    showToast(message);
    return true;
  } catch (error) {
    showToast(`Copy failed: ${error?.message || error}`, true);
    return false;
  }
}

async function openPort(url, https = false) {
  const target = https ? url.replace(/^http:/, "https:") : url;
  try {
    await openUrl(target);
  } catch (error) {
    showToast(`Could not open ${target}: ${error?.message || error}`, true);
  }
}

function portChips(window) {
  const ports = window.ports || [];
  if (!ports.length) return "";
  const visible = ports.slice(0, 2).map((port) => `
    <button class="port-chip" data-open-url="${escapeHtml(port.url)}" title="Open ${escapeHtml(port.url)}">:${port.port}</button>
  `).join("");
  const remaining = ports.length > 2
    ? `<button class="port-chip" data-action="timeline" title="Show all ports">+${ports.length - 2}</button>`
    : "";
  return `<span class="terminal-ports">${visible}${remaining}</span>`;
}

function activityInfo(window) {
  if (window.state !== "running") return { state: "stopped", label: "Stopped" };
  const state = window.activityState || (window.kind === "terminal" ? "ready" : "waiting");
  const labels = {
    ready: "Ready",
    running: window.kind === "terminal" ? "Busy" : "Working",
    waiting: "Ready",
    "needs-input": "Needs input",
    attention: "Attention",
    idle: "Exited",
    stopped: "Stopped"
  };
  return { state, label: labels[state] || state };
}

function projectStatusSquares(project) {
  const statuses = project.windows.map((window) => ({
    window,
    activity: activityInfo(window),
  }));
  const label = statuses.length
    ? statuses.map(({ window, activity }) => `${window.name}: ${activity.label}`).join(", ")
    : "No open windows";
  return `<span class="project-status-squares ${statuses.length ? "" : "empty"}" data-project-statuses="${project.id}" role="img" aria-label="${escapeHtml(label)}">
    ${statuses.map(({ window, activity }) => `<i class="project-status-square ${escapeHtml(activity.state)}" aria-hidden="true" title="${escapeHtml(window.name)} · ${escapeHtml(activity.label)}"></i>`).join("")}
  </span>`;
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
    clearTimeout(entry.historyScrollTimer);
    clearTimeout(entry.submissionSyncTimer);
    clearTimeout(entry.submissionSettleTimer);
    if (entry.activeSubmissionId) syncSubmission(entry, "completed");
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
  document.querySelectorAll(`[data-ports-window="${window.id}"]`).forEach((element) => {
    element.innerHTML = portChips(window);
  });
}

function renderProjects() {
  projectList.innerHTML = projects.map((project) => {
    return `
    <div class="project-row ${project.id === activeProjectId ? "active" : ""}" draggable="true" data-project-drag-id="${project.id}">
      <button class="project-item" data-project-id="${project.id}" title="${escapeHtml(project.cwd)}">
        <span class="project-icon">⌘</span>
        <span class="project-copy">
          <span class="project-title">
            <span class="project-name">${escapeHtml(project.name)}</span>
            ${projectStatusSquares(project)}
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

function renderCompactNavigation() {
  compactProjectList.innerHTML = projects.map((project) =>
    `<button class="compact-nav-item ${project.id === activeProjectId ? "active" : ""}" data-compact-project="${project.id}">
      <span>⌘</span><span><span class="compact-project-summary"><strong>${escapeHtml(project.name)}</strong>${projectStatusSquares(project)}</span><small>${project.windows.length} chats</small></span>
    </button>`
  ).join("");
  compactWindowList.innerHTML = (activeProject()?.windows || []).map((window) => {
    const activity = activityInfo(window);
    const poppedOut = poppedOutWindowIds.has(window.id);
    return `<button class="compact-nav-item ${window.id === selectedWindowId ? "active" : ""}" data-compact-window="${window.id}">
      <span class="status-dot ${activity.state}"></span><span><strong>${escapeHtml(window.name)}</strong><small>${activity.label}${poppedOut ? " · Popped out" : ""}</small></span>
    </button>`;
  }).join("") || `<p class="compact-nav-empty">No chats in this project.</p>`;
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
  if (!popoutWindowId && poppedOutWindowIds.has(window.id)) {
    return `<section class="terminal-card popped-out-card ${maximizedWindowId === window.id ? "maximized" : ""}" id="window-${window.id}" data-window-id="${window.id}">
      <div>
        <span class="popped-out-icon">↗</span>
        <h3>${escapeHtml(window.name)} is popped out</h3>
        <p>Close its window or return it here.</p>
        <button class="button primary" data-action="return-popout">Return here</button>
      </div>
    </section>`;
  }
  const running = window.state === "running";
  const kindLabel = window.kind === "terminal" ? "terminal" : "agent";
  return `<section class="terminal-card ${maximizedWindowId === window.id ? "maximized" : ""}" id="window-${window.id}" data-window-id="${window.id}">
    <header class="terminal-header" draggable="true">
      <div class="terminal-meta">
        <span class="drag-grip" title="Drag to tile">⠿</span>${activityVisual(window)}
        <span class="terminal-name" title="${escapeHtml(window.cwd)}">${escapeHtml(window.name)}</span>
        <span class="terminal-kind">${kindLabel}</span><span class="activity-text ${activityInfo(window).state}" data-status-label="${window.id}">${activityInfo(window).label}</span><span class="terminal-process" data-process-window="${window.id}">${escapeHtml(window.currentCommand || window.state)}</span><span data-ports-window="${window.id}">${portChips(window)}</span>
      </div>
      <div class="card-actions">
        <button class="icon-button" data-action="copy" title="Copy selected text (Ctrl+Shift+C)">⧉</button>
        <button class="icon-button" data-action="handoff" title="Create agent handoff">⇢</button>
        <button class="icon-button" data-action="timeline" title="Open activity timeline">◷</button>
        <button class="icon-button popout-action" data-action="popout" title="Open chat in a new window">↗</button>
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

function submissionOutput(entry) {
  const buffer = entry.terminal.buffer.active;
  const end = buffer.baseY + buffer.cursorY;
  let start = entry.windowKind === "agent"
    ? Math.max(0, end - entry.terminal.rows + 1)
    : Math.max(0, Math.min(end, entry.submissionStartLine + 1));
  const lines = [];
  for (; start <= end; start += 1) {
    const line = buffer.getLine(start)?.translateToString(true);
    if (line !== undefined) lines.push(line);
  }
  return lines.join("\n").trim();
}

function setLocalActivity(windowId, status) {
  const window = windowById(windowId);
  if (!window || window.kind !== "agent") return;
  window.activityState = status === "running" ? "running" : "waiting";
  updateStatusIndicator(window);
  updateProjectStatusSquares();
}

async function syncSubmission(entry, status) {
  if (!entry.activeSubmissionId) return;
  const output = submissionOutput(entry);
  if (status === "running" && output === entry.lastSubmissionOutput) return;
  entry.lastSubmissionOutput = output;
  setLocalActivity(entry.windowId, status);
  await call("update_submission", {
    id: entry.windowId, eventId: entry.activeSubmissionId, status
  }).catch(() => {});
  if (selectedWindowId === entry.windowId && workspace.classList.contains("activity-open")) refreshTimeline();
}

function observeSubmissionOutput(entry) {
  if (!entry.activeSubmissionId) return;
  const output = submissionOutput(entry);
  if (output === entry.observedSubmissionOutput) return;
  entry.observedSubmissionOutput = output;
  clearTimeout(entry.submissionSyncTimer);
  clearTimeout(entry.submissionSettleTimer);
  entry.submissionSyncTimer = setTimeout(() => syncSubmission(entry, "running"), 250);
  entry.submissionSettleTimer = setTimeout(() => syncSubmission(entry, "waiting"), activityQuietMs);
}

function submitTimelineEntry(windowId, entry) {
  const text = entry.submissionBuffer.trim();
  entry.submissionBuffer = "";
  if (!text) return;
  clearTimeout(entry.submissionSyncTimer);
  clearTimeout(entry.submissionSettleTimer);
  if (entry.activeSubmissionId) syncSubmission(entry, "completed");
  const buffer = entry.terminal.buffer.active;
  entry.submissionStartLine = buffer.baseY + buffer.cursorY;
  entry.submissionInNormalBuffer = buffer === entry.terminal.buffer.normal;
  entry.activeSubmissionId = null;
  entry.lastSubmissionOutput = "";
  entry.observedSubmissionOutput = "";
  setLocalActivity(windowId, "running");
  call("record_submission", {
    id: windowId,
    text,
    terminalLine: entry.submissionInNormalBuffer
      ? Math.max(0, Math.min(0xffffffff, entry.submissionStartLine))
      : null
  }).then((eventId) => {
    entry.activeSubmissionId = eventId;
    observeSubmissionOutput(entry);
    entry.submissionSettleTimer = setTimeout(() => syncSubmission(entry, "waiting"), activityQuietMs);
    if (selectedWindowId === windowId && workspace.classList.contains("activity-open")) refreshTimeline();
  }).catch(() => {});
}

function trackTerminalInput(windowId, entry, data) {
  let index = 0;
  while (index < data.length) {
    if (entry.inputEscapeMode) {
      if (entry.inputEscapeMode === "csi") {
        const finalIndex = [...data.slice(index)].findIndex((value) => value >= "@" && value <= "~");
        if (finalIndex < 0) return;
        index += finalIndex + 1;
      } else if (entry.inputEscapeMode === "string") {
        const bell = data.indexOf("\x07", index);
        const stringTerminator = data.indexOf("\x1b\\", index);
        const endings = [bell, stringTerminator].filter((value) => value >= 0);
        if (!endings.length) return;
        const ending = Math.min(...endings);
        index = ending + (ending === bell ? 1 : 2);
      } else {
        index += 1;
      }
      entry.inputEscapeMode = null;
      continue;
    }
    if (data.startsWith("\x1b[200~", index)) {
      entry.pasteMode = true;
      index += 6;
      continue;
    }
    if (data.startsWith("\x1b[201~", index)) {
      entry.pasteMode = false;
      index += 6;
      continue;
    }
    const character = data[index];
    if (character === "\x1b") {
      const sequenceType = data[index + 1];
      if (sequenceType === "]" || sequenceType === "P" || sequenceType === "^" || sequenceType === "_") {
        entry.inputEscapeMode = "string";
        index += 2;
      } else if (sequenceType === "[") {
        entry.inputEscapeMode = "csi";
        index += 2;
      } else if (sequenceType === "O") {
        entry.inputEscapeMode = "single";
        index += 2;
      } else {
        index += Math.min(2, data.length - index);
      }
      continue;
    }
    if (character === "\x7f" || character === "\b") {
      entry.submissionBuffer = [...entry.submissionBuffer].slice(0, -1).join("");
    } else if (character === "\x15" || character === "\x03") {
      entry.submissionBuffer = "";
    } else if (character === "\r" && !entry.pasteMode) {
      submitTimelineEntry(windowId, entry);
    } else if (character === "\r" || character === "\n") {
      entry.submissionBuffer += "\n";
    } else if (character === "\t" || character >= " ") {
      entry.submissionBuffer += character;
    }
    index += 1;
  }
}

async function connectTerminal(window) {
  const container = document.querySelector(`[data-terminal-id="${window.id}"]`);
  if (!container || window.state !== "running") return;
  const terminal = new Terminal({
    cursorBlink: true, cursorStyle: "bar", fontSize: terminalFontSize, lineHeight: 1.2, scrollback: 5000,
    fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono Nerd Font", "Noto Sans Mono", monospace',
    theme: {
      background: "#060709", foreground: "#e5e7eb", cursor: "#8f82ff", selectionBackground: "#332f55",
      black: "#14161a", brightBlack: "#707784", green: "#79d99d", brightGreen: "#9ae6b4",
      red: "#ef6b73", brightRed: "#ff858c", blue: "#68a7e8", brightBlue: "#8fc2f4",
      yellow: "#d9b85c", brightYellow: "#efd27d", magenta: "#8f82ff", brightMagenta: "#b6adff",
      cyan: "#69b9b1", brightCyan: "#8bd5cc", white: "#d3d6dc", brightWhite: "#ffffff"
    }
  });
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  const entry = {
    terminal, fitAddon, observer: null, inputBuffer: "", inputTimer: null, resizeTimer: null,
    channel: new Channel(), submissionBuffer: "", pasteMode: false, inputEscapeMode: null, windowId: window.id,
    windowKind: window.kind, activeSubmissionId: null, submissionStartLine: 0,
    submissionInNormalBuffer: true,
    lastSubmissionOutput: "", observedSubmissionOutput: "", submissionSyncTimer: null,
    submissionSettleTimer: null, historyScrollLines: 0, historyScrollTimer: null
  };
  terminals.set(window.id, entry);
  entry.channel.onmessage = (message) => {
    if (message.event === "output" && message.data.id === window.id) {
      terminal.write(message.data.data, () => observeSubmissionOutput(entry));
    }
    if (message.event === "exit" && message.data.id === window.id) {
      syncSubmission(entry, "completed");
      terminal.write("\r\n\x1b[38;5;244m[terminal detached]\x1b[0m\r\n");
    }
  };

  terminal.onData((data) => {
    trackTerminalInput(window.id, entry, data);
    queueTerminalInput(window.id, entry, data);
  });

  // Handle keys that the webview may otherwise reserve for focus navigation.
  // Shift+Tab is the standard terminal back-tab sequence used by terminal TUIs.
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown") {
        const selection = terminal.getSelection();
        if (selection) copyText(selection, "Terminal selection copied.");
        else showToast("Select terminal text first.", true);
      }
      return false;
    }
    if (window.kind === "agent" && event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown") {
        trackTerminalInput(window.id, entry, "\n");
        queueTerminalInput(window.id, entry, "\x0a");
      }
      return false;
    }
    if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown") {
        queueTerminalInput(window.id, entry, "\x1b[Z");
      }
      return false;
    }
    // Match the user's Kitty mapping: Ctrl+F emits the private sequence Fish
    // binds to the `project_cd` fzf picker.
    if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown") {
        queueTerminalInput(window.id, entry, "\x1fFZF_PROJECT_CD\x1e");
      }
      return false;
    }
    return true;
  });

  terminal.attachCustomWheelEventHandler((event) => {
    if (event.ctrlKey || event.metaKey) return true;
    event.preventDefault();
    const amount = Math.max(1, Math.min(12, Math.ceil(Math.abs(event.deltaY) / 30)));
    entry.historyScrollLines += event.deltaY < 0 ? amount : -amount;
    clearTimeout(entry.historyScrollTimer);
    entry.historyScrollTimer = setTimeout(() => {
      const lines = entry.historyScrollLines;
      entry.historyScrollLines = 0;
      entry.historyScrollTimer = null;
      if (lines) call("scroll_terminal_history", { id: window.id, lines }).catch(() => {});
    }, 24);
    return false;
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

function updateFontControls() {
  document.querySelector("#settings-font-size-output").textContent = `${terminalFontSize}px`;
  document.querySelector("#terminal-font-size-range").value = String(terminalFontSize);
}

function setTerminalFontSize(size) {
  const nextSize = Math.min(24, Math.max(8, Number(size) || 11));
  if (nextSize === terminalFontSize) return;
  terminalFontSize = nextSize;
  localStorage.setItem("agent-grid-font-size", String(terminalFontSize));
  updateFontControls();
  for (const [id, entry] of terminals) {
    entry.terminal.options.fontSize = terminalFontSize;
    entry.fitAddon.fit();
    call("resize_terminal", { id, cols: entry.terminal.cols, rows: entry.terminal.rows }).catch(() => {});
  }
}

function matchesTimelineFilter(event) {
  if (timelineFilter === "all") return true;
  if (timelineFilter === "port") return event.kind.startsWith("port");
  if (timelineFilter === "activity") return event.kind === "activity" || event.kind === "process";
  if (timelineFilter === "interaction") return event.kind === "interaction" || event.kind === "command";
  return event.kind === timelineFilter;
}

function timelineIcon(kind) {
  if (kind === "interaction" || kind === "command") return "›";
  if (kind.startsWith("port")) return "●";
  if (kind === "handoff") return "⇢";
  if (kind === "process") return "◆";
  return "·";
}

function interactionTemplate(event) {
  const status = event.status || "completed";
  const updatedAt = event.updatedAt || event.at;
  const duration = Math.max(0, updatedAt - event.at);
  const durationText = duration >= 1000 ? ` · ${(duration / 1000).toFixed(duration >= 10000 ? 0 : 1)}s` : "";
  return `
    <article class="timeline-event interaction">
      <span class="timeline-icon">›</span>
      <div class="timeline-event-body">
        <div class="timeline-interaction-meta"><span class="timeline-status ${escapeHtml(status)}">${escapeHtml(status)}</span><span>${new Date(event.at).toLocaleString()}${durationText}</span></div>
        <div class="timeline-prompt-label">Input · click to locate</div>
        <button class="timeline-prompt-jump" data-jump-event="${escapeHtml(event.id)}" title="Scroll the terminal to this prompt">${escapeHtml(event.summary)}</button>
      </div>
    </article>
  `;
}

async function locateTimelinePrompt(eventId) {
  const timelineEvent = timelineEvents.find((item) => item.id === eventId);
  const entry = terminals.get(selectedWindowId);
  if (!timelineEvent || !entry) return;
  const windowId = selectedWindowId;
  closeActivityPanel();
  try {
    await call("jump_to_prompt", { id: windowId, text: timelineEvent.summary });
    entry.terminal.focus();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderActivityPanel() {
  const selected = windowById(selectedWindowId);
  document.querySelector("#activity-panel-title").textContent = selected?.name || "Activity";
  const ports = selected?.ports || [];
  activityPanelPorts.innerHTML = ports.map((port) => `
    <span class="activity-port">
      <button data-open-url="${escapeHtml(port.url)}" title="${escapeHtml(port.process)} · PID ${port.pid}">:${port.port}</button>
      <button data-open-https="${escapeHtml(port.url)}" title="Open as HTTPS">HTTPS</button>
      <button data-copy-url="${escapeHtml(port.url)}" title="Copy URL">⧉</button>
    </span>
  `).join("");
  const events = timelineEvents.filter(matchesTimelineFilter).slice().reverse();
  activityTimeline.innerHTML = events.length ? events.map((event) => {
    if (event.kind === "interaction") return interactionTemplate(event);
    return `
    <article class="timeline-event ${escapeHtml(event.kind)}">
      <span class="timeline-icon">${timelineIcon(event.kind)}</span>
      <div class="timeline-event-body">
        <div class="timeline-summary">${escapeHtml(event.summary)}</div>
        <div class="timeline-time">${new Date(event.at).toLocaleString()}</div>
      </div>
    </article>
  `;
  }).join("") : `<div class="timeline-empty">${selected ? "No matching activity yet." : "Select a terminal window to view its activity."}</div>`;
}

async function refreshTimeline() {
  if (!selectedWindowId || !windowById(selectedWindowId)) {
    timelineEvents = [];
    renderActivityPanel();
    return;
  }
  try {
    timelineEvents = await call("get_window_timeline", { id: selectedWindowId });
    renderActivityPanel();
  } catch (error) {
    timelineEvents = [];
    renderActivityPanel();
    showToast(error.message, true);
  }
}

async function openActivityPanel(windowId = selectedWindowId) {
  selectedWindowId = windowId || activeWindows()[0]?.id || null;
  workspace.classList.add("activity-open");
  activityPanel.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => terminals.forEach((entry) => entry.fitAddon.fit()));
  await refreshTimeline();
}

function closeActivityPanel() {
  workspace.classList.remove("activity-open");
  activityPanel.setAttribute("aria-hidden", "true");
  requestAnimationFrame(() => terminals.forEach((entry) => entry.fitAddon.fit()));
}

async function createAndForkHandoff(id) {
  if (handoffInFlight) return;
  handoffInFlight = true;
  try {
    const handoff = await call("create_handoff", { id });
    await copyText(handoff.copyText, `Handoff copied: ${handoff.path}`);
    const result = await call("fork_handoff", { sourceId: id, handoffId: handoff.id });
    await refreshProjects({ quiet: true });
    selectedWindowId = result.window.id;
    showToast(result.exactFork
      ? "Codex fork opened with the full session context."
      : "Agent opened. Paste the copied handoff prompt to continue.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    handoffInFlight = false;
  }
}

async function render() {
  await disposeTerminals();
  renderProjects();
  renderWindows();
  renderCompactNavigation();
  updateLayoutControls();
  updateFontControls();
  const project = activeProject();
  document.querySelector("#workspace-title").textContent = project ? project.name : "Agent Grid";
  newWindowButton.disabled = !project;
  grid.classList.remove("has-maximized", "drag-active");

  const windows = activeWindows();
  if (!windows.length) {
    currentLayout = null;
    selectedWindowId = null;
    maximizedWindowId = null;
    renderEmptyState();
    if (workspace.classList.contains("activity-open")) await refreshTimeline();
    return;
  }
  if (!windows.some((window) => window.id === selectedWindowId)) selectedWindowId = windows[0].id;
  maximizedWindowId = compactMode && !popoutWindowId ? selectedWindowId : null;
  currentLayout = popoutWindowId ? leaf(popoutWindowId) : loadLayout();
  grid.innerHTML = `<div class="tile-root">${renderLayoutNode(currentLayout)}</div>`;
  grid.classList.toggle("has-maximized", Boolean(maximizedWindowId));
  await Promise.all(windows.map(connectTerminal));
  if (workspace.classList.contains("activity-open")) await refreshTimeline();
}

async function refreshProjects({ quiet = false } = {}) {
  try {
    projects = await call("get_projects");
    if (popoutWindowId) {
      activeProjectId = projects.find((project) =>
        project.windows.some((window) => window.id === popoutWindowId))?.id || null;
    } else {
      if (!projects.some((project) => project.id === activeProjectId)) activeProjectId = projects[0]?.id || null;
      if (activeProjectId) localStorage.setItem("agent-grid-project", activeProjectId);
      else localStorage.removeItem("agent-grid-project");
    }
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
  updateProjectStatusSquares();
}

function updateProjectStatusSquares() {
  for (const project of projects) {
    document.querySelectorAll(`[data-project-statuses="${project.id}"]`).forEach((element) => {
      element.outerHTML = projectStatusSquares(project);
    });
  }
}

async function pollStatuses() {
  clearTimeout(statusTimer);
  if (!document.hidden && !statusRequestInFlight) {
    statusRequestInFlight = true;
    try {
      projects = await call("get_projects");
      updateStatusIndicators();
      if (workspace.classList.contains("activity-open")) await refreshTimeline();
    } catch {
      // A temporary tmux query failure should not interrupt active terminals.
    } finally {
      statusRequestInFlight = false;
    }
  }
  statusTimer = setTimeout(pollStatuses, 2500);
}

function openProjectModal() {
  editingProjectId = null;
  document.querySelector("#project-dialog-eyebrow").textContent = "New workspace";
  document.querySelector("#project-dialog-title").textContent = "Create a project";
  document.querySelector("#save-project-button").textContent = "Create project";
  document.querySelector("#project-name").value = `Project ${projects.length + 1}`;
  document.querySelector("#project-cwd").value = config.defaultCwd;
  document.querySelector("#project-command").value = config.defaultCommand;
  projectDialog.showModal();
  document.querySelector("#project-name").select();
}

function openProjectSettings(id) {
  const project = projects.find((item) => item.id === id);
  if (!project) return;
  editingProjectId = id;
  document.querySelector("#project-dialog-eyebrow").textContent = "Project settings";
  document.querySelector("#project-dialog-title").textContent = `Edit ${project.name}`;
  document.querySelector("#save-project-button").textContent = "Save changes";
  document.querySelector("#project-name").value = project.name;
  document.querySelector("#project-cwd").value = project.cwd;
  document.querySelector("#project-command").value = project.defaultCommand;
  projectDialog.showModal();
  document.querySelector("#project-name").select();
}

function closeProjectContextMenu() {
  projectContextMenu.hidden = true;
  contextProjectId = null;
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

function applyMaximizedWindow(id) {
  maximizedWindowId = id;
  document.querySelectorAll(".terminal-card").forEach((item) => {
    const maximized = item.dataset.windowId === maximizedWindowId;
    item.classList.toggle("maximized", maximized);
    const button = item.querySelector('[data-action="maximize"]');
    if (button) button.textContent = maximized ? "↙" : "□";
  });
  grid.classList.toggle("has-maximized", Boolean(maximizedWindowId));
  requestAnimationFrame(() => terminals.forEach((entry) => entry.fitAddon.fit()));
}

function toggleMaximize(card) {
  if (compactMode) return;
  applyMaximizedWindow(maximizedWindowId === card.dataset.windowId ? null : card.dataset.windowId);
}

async function setCompactMode(enabled) {
  const button = document.querySelector("#compact-mode-button");
  button.disabled = true;
  try {
    await call("set_compact_mode", { enabled });
    compactMode = enabled;
    document.body.classList.toggle("compact-mode", enabled);
    button.setAttribute("aria-pressed", String(enabled));
    button.textContent = enabled ? "↙" : "▯";
    button.setAttribute("aria-label", enabled ? "Exit compact view" : "Enter compact view");
    button.title = enabled ? "Exit compact view" : "Compact view";
    if (enabled) {
      if (workspace.classList.contains("activity-open")) closeActivityPanel();
      compactPreviousMaximizedId = maximizedWindowId;
      selectedWindowId ||= activeWindows()[0]?.id || null;
      applyMaximizedWindow(selectedWindowId);
    } else {
      closeCompactMenu();
      applyMaximizedWindow(compactPreviousMaximizedId);
      compactPreviousMaximizedId = null;
    }
  } catch (error) {
    showToast(`Compact view failed: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function openCompactMenu() {
  if (!compactMode) return;
  renderCompactNavigation();
  compactDrawer.hidden = false;
  compactDrawerBackdrop.hidden = false;
  document.body.classList.add("compact-menu-open");
  compactDrawer.querySelector("button")?.focus();
}

function closeCompactMenu() {
  compactDrawer.hidden = true;
  compactDrawerBackdrop.hidden = true;
  document.body.classList.remove("compact-menu-open");
}

async function restorePoppedOutChat(id) {
  if (!poppedOutWindowIds.delete(id)) return;
  if ((activeProject()?.windows || []).some((window) => window.id === id)) {
    selectedWindowId = id;
    await render();
  } else {
    renderCompactNavigation();
  }
}

async function popOutChat(id) {
  if (compactMode || poppedOutWindowIds.has(id)) return;
  poppedOutWindowIds.add(id);
  await render();
  try {
    await call("open_chat_popout", { id });
  } catch (error) {
    await restorePoppedOutChat(id);
    showToast(`Could not pop out chat: ${error.message}`, true);
  }
}

async function returnPoppedOutChat(id) {
  try {
    await call("close_chat_popout", { id });
  } catch (error) {
    showToast(`Could not close chat window: ${error.message}`, true);
  }
  await restorePoppedOutChat(id);
}

function openSettings() {
  updateFontControls();
  settingsDialog.showModal();
}

document.querySelector("#new-project-button").addEventListener("click", openProjectModal);
newWindowButton.addEventListener("click", openWindowModal);
document.querySelector("#activity-button").addEventListener("click", () => {
  if (workspace.classList.contains("activity-open")) closeActivityPanel();
  else openActivityPanel();
});
document.querySelector("#close-activity-button").addEventListener("click", closeActivityPanel);
document.querySelector("#refresh-button").addEventListener("click", () => refreshProjects());
document.querySelector("#auto-grid-button").addEventListener("click", () => retile("auto"));
document.querySelector("#fewer-columns-button").addEventListener("click", () => retile("manual", layoutMode === "auto" ? 1 : layoutColumns - 1));
document.querySelector("#more-columns-button").addEventListener("click", () => retile("manual", layoutMode === "auto" ? 2 : layoutColumns + 1));
document.querySelector("#compact-mode-button").addEventListener("click", () => setCompactMode(!compactMode));
document.querySelector("#settings-button").addEventListener("click", openSettings);
document.querySelector("#terminal-font-size-range").addEventListener("input", (event) => setTerminalFontSize(event.target.value));
document.querySelector("#compact-menu-button").addEventListener("click", openCompactMenu);
document.querySelector("#close-compact-menu-button").addEventListener("click", closeCompactMenu);
compactDrawerBackdrop.addEventListener("click", closeCompactMenu);
compactProjectList.addEventListener("click", async (event) => {
  const id = event.target.closest("[data-compact-project]")?.dataset.compactProject;
  if (!id || id === activeProjectId) return closeCompactMenu();
  activeProjectId = id;
  localStorage.setItem("agent-grid-project", id);
  selectedWindowId = projects.find((project) => project.id === id)?.windows[0]?.id || null;
  closeCompactMenu();
  await render();
});
compactWindowList.addEventListener("click", (event) => {
  const id = event.target.closest("[data-compact-window]")?.dataset.compactWindow;
  if (!id) return;
  selectedWindowId = id;
  closeCompactMenu();
  applyMaximizedWindow(id);
  renderCompactNavigation();
});
document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll(".browse-button").forEach((button) => button.addEventListener("click", () => browseDirectory(button.dataset.browse)));
document.querySelectorAll(".kind-option").forEach((button) => button.addEventListener("click", () => setWindowKind(button.dataset.kind)));
document.querySelector("#activity-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-timeline-filter]");
  if (!button) return;
  timelineFilter = button.dataset.timelineFilter;
  document.querySelectorAll("[data-timeline-filter]").forEach((item) => item.classList.toggle("active", item === button));
  renderActivityPanel();
});
activityPanel.addEventListener("click", (event) => {
  const jump = event.target.closest("[data-jump-event]")?.dataset.jumpEvent;
  if (jump) return locateTimelinePrompt(jump);
  const open = event.target.closest("[data-open-url]")?.dataset.openUrl;
  if (open) return openPort(open);
  const https = event.target.closest("[data-open-https]")?.dataset.openHttps;
  if (https) return openPort(https, true);
  const copy = event.target.closest("[data-copy-url]")?.dataset.copyUrl;
  if (copy) copyText(copy, "Port URL copied.");
});

projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#save-project-button");
  const input = {
    name: document.querySelector("#project-name").value,
    cwd: document.querySelector("#project-cwd").value,
    defaultCommand: document.querySelector("#project-command").value
  };
  button.disabled = true;
  try {
    if (editingProjectId) {
      await call("update_project", { id: editingProjectId, input });
      showToast("Project settings saved.");
    } else {
      const project = await call("create_project", { input });
      activeProjectId = project.id;
      showToast("Project created.");
    }
    projectDialog.close();
    await refreshProjects({ quiet: true });
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

projectList.addEventListener("contextmenu", (event) => {
  const name = event.target.closest(".project-name");
  const row = name?.closest("[data-project-drag-id]");
  if (!row) return;
  event.preventDefault();
  contextProjectId = row.dataset.projectDragId;
  projectContextMenu.hidden = false;
  const rect = projectContextMenu.getBoundingClientRect();
  projectContextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 8)}px`;
  projectContextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - rect.height - 8)}px`;
  projectContextMenu.querySelector("button").focus();
});

projectContextMenu.addEventListener("click", (event) => {
  if (event.target.closest("[data-context-action='edit-project']") && contextProjectId) {
    const id = contextProjectId;
    closeProjectContextMenu();
    openProjectSettings(id);
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!projectContextMenu.hidden && !event.target.closest("#project-context-menu")) {
    closeProjectContextMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !projectContextMenu.hidden) closeProjectContextMenu();
});

projectList.addEventListener("dragstart", (event) => {
  const row = event.target.closest("[data-project-drag-id]");
  if (!row || event.target.closest(".project-delete")) {
    event.preventDefault();
    return;
  }
  draggedProjectId = row.dataset.projectDragId;
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedProjectId);
});

projectList.addEventListener("dragover", (event) => {
  const row = event.target.closest("[data-project-drag-id]");
  if (!row || !draggedProjectId || row.dataset.projectDragId === draggedProjectId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const after = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
  projectList.querySelectorAll(".drop-before, .drop-after").forEach((item) => {
    item.classList.remove("drop-before", "drop-after");
  });
  row.classList.add(after ? "drop-after" : "drop-before");
});

projectList.addEventListener("drop", async (event) => {
  const row = event.target.closest("[data-project-drag-id]");
  if (!row || !draggedProjectId) return;
  event.preventDefault();
  const targetId = row.dataset.projectDragId;
  const after = event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
  const sourceIndex = projects.findIndex((project) => project.id === draggedProjectId);
  if (sourceIndex < 0 || targetId === draggedProjectId) return;
  const [moved] = projects.splice(sourceIndex, 1);
  let targetIndex = projects.findIndex((project) => project.id === targetId);
  if (after) targetIndex += 1;
  projects.splice(targetIndex, 0, moved);
  draggedProjectId = null;
  renderProjects();
  try {
    await call("reorder_projects", { ids: projects.map((project) => project.id) });
    showToast("Project order saved.");
  } catch (error) {
    await refreshProjects({ quiet: true });
    showToast(error.message, true);
  }
});

projectList.addEventListener("dragend", () => {
  draggedProjectId = null;
  projectList.querySelectorAll(".dragging, .drop-before, .drop-after").forEach((item) => {
    item.classList.remove("dragging", "drop-before", "drop-after");
  });
});

windowList.addEventListener("click", (event) => {
  const id = event.target.closest("[data-scroll-window]")?.dataset.scrollWindow;
  if (!id) return;
  selectedWindowId = id;
  document.querySelector(`#window-${id}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

grid.addEventListener("click", (event) => {
  const open = event.target.closest("[data-open-url]")?.dataset.openUrl;
  if (open) return openPort(open);
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "empty-project") return openProjectModal();
  if (action === "empty-window") return openWindowModal();
  const card = event.target.closest(".terminal-card");
  if (!card) return;
  if (action === "copy") {
    const selection = terminals.get(card.dataset.windowId)?.terminal.getSelection();
    if (selection) copyText(selection, "Terminal selection copied.");
    else showToast("Select terminal text first.", true);
  }
  if (action === "handoff") createAndForkHandoff(card.dataset.windowId);
  if (action === "timeline") openActivityPanel(card.dataset.windowId);
  if (action === "restart") restartWindow(card.dataset.windowId);
  if (action === "delete") deleteWindow(card.dataset.windowId);
  if (action === "maximize") toggleMaximize(card);
  if (action === "popout") popOutChat(card.dataset.windowId);
  if (action === "return-popout") returnPoppedOutChat(card.dataset.windowId);
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
document.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (!["+", "=", "-", "_", "0"].includes(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === "0") setTerminalFontSize(11);
  else setTerminalFontSize(terminalFontSize + (["+", "="].includes(event.key) ? 1 : -1));
}, true);
document.addEventListener("wheel", (event) => {
  if (!(event.ctrlKey || event.metaKey) || !event.target.closest(".terminal-body")) return;
  event.preventDefault();
  setTerminalFontSize(terminalFontSize + (event.deltaY < 0 ? 1 : -1));
}, { capture: true, passive: false });
window.addEventListener("resize", () => {
  if (sidebar.offsetParent !== null) applyProjectSectionShare(projectSectionShare, false, false);
});
window.addEventListener("beforeunload", () => {
  clearTimeout(statusTimer);
  if (popoutWindowId && typeof tauriListen !== "function") {
    popoutChannel?.postMessage({ type: "closed", id: popoutWindowId });
  }
});
popoutChannel?.addEventListener("message", (event) => {
  if (!popoutWindowId && typeof tauriListen !== "function" && event.data?.type === "closed") {
    restorePoppedOutChat(event.data.id);
  }
});
if (!popoutWindowId && typeof tauriListen === "function") {
  tauriListen("chat-popout-closed", (event) => restorePoppedOutChat(event.payload))
    .catch(() => {});
}

init();
