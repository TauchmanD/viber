/* global Terminal, FitAddon, UiLayout, marked, DOMPurify */

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
const gitSection = document.querySelector("#git-section");
const gitBranchSelect = document.querySelector("#git-branch-select");
const gitSummary = document.querySelector("#git-summary");
const gitRefreshButton = document.querySelector("#git-refresh-button");
const gitPullButton = document.querySelector("#git-pull-button");
const gitPushButton = document.querySelector("#git-push-button");
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
const repositoryBrowser = document.querySelector("#repository-browser");
const repositoryTree = document.querySelector("#repository-tree");
const gitGraph = document.querySelector("#git-graph");
const gitGraphLimitNote = document.querySelector("#git-graph-limit-note");
const gitCommitPreview = document.querySelector("#git-commit-preview");
const repositoryFileContent = document.querySelector("#repository-file-content");
const repositoryPreviewEmpty = document.querySelector("#repository-preview-empty");
const repositoryMarkdownPreview = document.querySelector("#repository-markdown-preview");
const markdownViewToggle = document.querySelector("#markdown-view-toggle");
const repositoryCopyButton = document.querySelector("#repository-copy-button");
const preferredEditorSelect = document.querySelector("#preferred-editor-select");
const preferredEditorCustom = document.querySelector("#preferred-editor-custom");
const sshTunnelsView = document.querySelector("#ssh-tunnels-view");
const sshTunnelsList = document.querySelector("#ssh-tunnels-list");
const sshTunnelDialog = document.querySelector("#ssh-tunnel-dialog");
const sshTunnelForm = document.querySelector("#ssh-tunnel-form");
const sshTunnelsButton = document.querySelector("#ssh-tunnels-button");
const runningAppsView = document.querySelector("#running-apps-view");
const runningAppsList = document.querySelector("#running-apps-list");
const runningAppsButton = document.querySelector("#running-apps-button");
const sshProfileDialog = document.querySelector("#ssh-profile-dialog");
const sshProfileForm = document.querySelector("#ssh-profile-form");
const sshProfileList = document.querySelector("#ssh-profile-list");
const remoteDirectoryDialog = document.querySelector("#remote-directory-dialog");
const remoteDirectoryList = document.querySelector("#remote-directory-list");
const terminals = new Map();
const sidebarWidthKey = "agent-grid-sidebar-width";
const projectSectionShareKey = "agent-grid-projects-share";
const legacyProjectSectionHeightKey = "agent-grid-projects-height";
const preferredEditorKey = "agent-grid-preferred-editor";
const preferredEditorCustomKey = "agent-grid-preferred-editor-custom";
const shortcutStorageKey = "agent-grid-keyboard-shortcuts";
const defaultShortcutBindings = Object.freeze({
  windowFocus: Object.freeze({ ctrl: false, alt: true, shift: false, meta: false }),
  projectSwitch: Object.freeze({ ctrl: true, alt: true, shift: false, meta: false })
});

let projects = [];
let activeProjectId = localStorage.getItem("agent-grid-project");
let config = { defaultCwd: "~/projects", defaultCommand: "omp" };
let windowKind = "agent";
let layoutMode = localStorage.getItem("agent-grid-mode") || "auto";
let layoutColumns = Math.min(8, Math.max(1, Number(localStorage.getItem("agent-grid-columns")) || 2));
let terminalFontSize = Math.min(24, Math.max(8, Number(localStorage.getItem("agent-grid-font-size")) || 11));
let preferredEditor = localStorage.getItem(preferredEditorKey) || "code";
let preferredEditorCommand = localStorage.getItem(preferredEditorCustomKey) || "";
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
let gitStatus = null;
let gitStatusProjectId = null;
let gitStatusError = null;
let gitStatusTimer;
let gitOperationInFlight = false;
let selectedWindowId = null;
let timelineFilter = "all";
let timelineEvents = [];
let handoffInFlight = false;
let repositoryEntries = [];
let repositoryFile = null;
let repositoryProjectId = null;
let repositoryFilter = "all";
let repositoryTruncated = false;
let collapsedRepositoryPaths = new Set();
let markdownView = "preview";
let gitGraphCommits = [];
let gitGraphTruncated = false;
let gitGraphProjectId = null;
let selectedGitCommitHash = null;
let sshTunnels = [];
let editingSshTunnelId = null;
let sshTunnelsTimer;
let runningApps = { groups: [], serviceCount: 0, dockerError: null };
let runningAppsTimer;
let runningAppsRequestInFlight = false;
const appOpeningDrafts = new Map();
let sshProfiles = [];
let editingSshProfileId = null;
const sshProfileTestStates = new Map();
let remoteDirectoryProfileId = null;
let remoteDirectoryTargetInput = null;
let remoteDirectoryView = null;
let shortcutBindings = loadShortcutBindings();
let recordingShortcut = null;
let projectSwitchInFlight = false;

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

function normalizedShortcutBinding(value, fallback) {
  const binding = {
    ctrl: Boolean(value?.ctrl),
    alt: Boolean(value?.alt),
    shift: Boolean(value?.shift),
    meta: Boolean(value?.meta)
  };
  return Object.values(binding).some(Boolean) ? binding : { ...fallback };
}

function shortcutBindingId(binding) {
  return [binding.ctrl, binding.alt, binding.shift, binding.meta].map(Number).join("");
}

function loadShortcutBindings() {
  try {
    const stored = JSON.parse(localStorage.getItem(shortcutStorageKey) || "{}");
    const bindings = {
      windowFocus: normalizedShortcutBinding(stored.windowFocus, defaultShortcutBindings.windowFocus),
      projectSwitch: normalizedShortcutBinding(stored.projectSwitch, defaultShortcutBindings.projectSwitch)
    };
    if (shortcutBindingId(bindings.windowFocus) === shortcutBindingId(bindings.projectSwitch)) {
      bindings.projectSwitch = { ...defaultShortcutBindings.projectSwitch };
    }
    return bindings;
  } catch {
    return {
      windowFocus: { ...defaultShortcutBindings.windowFocus },
      projectSwitch: { ...defaultShortcutBindings.projectSwitch }
    };
  }
}

function shortcutBindingLabel(binding) {
  const parts = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.meta) parts.push("Super");
  return `${parts.join(" + ")} + Arrow keys`;
}

function updateShortcutControls() {
  document.querySelectorAll("[data-shortcut-record]").forEach((button) => {
    const action = button.dataset.shortcutRecord;
    const recording = action === recordingShortcut;
    button.classList.toggle("recording", recording);
    button.setAttribute("aria-pressed", String(recording));
    button.textContent = recording ? "Press modifiers + arrow…" : shortcutBindingLabel(shortcutBindings[action]);
  });
}

function beginShortcutRecording(action) {
  recordingShortcut = recordingShortcut === action ? null : action;
  updateShortcutControls();
}

function cancelShortcutRecording() {
  if (!recordingShortcut) return;
  recordingShortcut = null;
  updateShortcutControls();
}

function resetShortcutBinding(action) {
  shortcutBindings[action] = { ...defaultShortcutBindings[action] };
  if (shortcutBindingId(shortcutBindings.windowFocus) === shortcutBindingId(shortcutBindings.projectSwitch)) {
    const other = action === "windowFocus" ? "projectSwitch" : "windowFocus";
    shortcutBindings[other] = { ...defaultShortcutBindings[other] };
  }
  localStorage.setItem(shortcutStorageKey, JSON.stringify(shortcutBindings));
  cancelShortcutRecording();
  updateShortcutControls();
  showToast("Keyboard shortcut reset.");
}

function modifierBindingFromEvent(event) {
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey
  };
}

function matchesShortcutBinding(event, binding) {
  return event.ctrlKey === binding.ctrl
    && event.altKey === binding.alt
    && event.shiftKey === binding.shift
    && event.metaKey === binding.meta;
}

function handleShortcutRecording(event) {
  if (!recordingShortcut) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelShortcutRecording();
    return true;
  }
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return true;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.key.startsWith("Arrow")) {
    showToast("Press at least one modifier with an arrow key.", true);
    return true;
  }
  const binding = modifierBindingFromEvent(event);
  if (!Object.values(binding).some(Boolean)) {
    showToast("A navigation shortcut needs at least one modifier.", true);
    return true;
  }
  const other = recordingShortcut === "windowFocus" ? "projectSwitch" : "windowFocus";
  if (shortcutBindingId(binding) === shortcutBindingId(shortcutBindings[other])) {
    showToast("That modifier combination is already assigned.", true);
    return true;
  }
  shortcutBindings[recordingShortcut] = binding;
  localStorage.setItem(shortcutStorageKey, JSON.stringify(shortcutBindings));
  recordingShortcut = null;
  updateShortcutControls();
  showToast("Keyboard shortcut saved.");
  return true;
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
      <button class="project-item" data-project-id="${project.id}" title="${escapeHtml(project.remote ? `${project.sshProfileName} · ${project.cwd}` : project.cwd)}">
        <span class="project-icon ${project.remote ? "remote" : ""}">${project.remote ? "⌁" : "⌘"}</span>
        <span class="project-copy">
          <span class="project-title">
            <span class="project-name">${escapeHtml(project.name)}</span>
            ${project.remote ? `<span class="project-remote-badge">${escapeHtml(project.sshProfileName || "SSH")}</span>` : ""}
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
      <span>${project.remote ? "⌁" : "⌘"}</span><span><span class="compact-project-summary"><strong>${escapeHtml(project.name)}</strong>${projectStatusSquares(project)}</span><small>${project.remote ? `${escapeHtml(project.sshProfileName || "SSH")} · ` : ""}${project.windows.length} chats</small></span>
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
  container.addEventListener("focusin", () => {
    selectedWindowId = window.id;
    renderCompactNavigation();
  });

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

const editorLabels = {
  code: "VS Code",
  cursor: "Cursor",
  zed: "Zed",
  subl: "Sublime Text",
  idea: "IntelliJ IDEA",
  custom: "custom editor",
};

function selectedEditor() {
  const command = preferredEditor === "custom" ? preferredEditorCommand.trim() : preferredEditor;
  return { command, label: editorLabels[preferredEditor] || preferredEditor };
}

function updateEditorControls() {
  if (!editorLabels[preferredEditor]) preferredEditor = "code";
  preferredEditorSelect.value = preferredEditor;
  preferredEditorCustom.value = preferredEditorCommand;
  preferredEditorCustom.hidden = preferredEditor !== "custom";
  const editor = selectedEditor();
  document.querySelector("#repository-editor-label").textContent = editor.label;
  document.querySelector("#repository-open-editor-button").disabled = !activeProject() || !editor.command;
}

async function openProjectInEditor(projectId = activeProjectId) {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return;
  const editor = selectedEditor();
  if (!editor.command) {
    openSettings();
    showToast("Enter a custom editor executable.", true);
    return;
  }
  try {
    await call("open_project_in_editor", { projectId, editorCommand: editor.command });
    showToast(`${project.name} opened in ${editor.label}.`);
  } catch (error) {
    showToast(`Could not open ${editor.label}: ${error.message}`, true);
  }
}

function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function repositoryAncestors(path) {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function markdownPath(path) {
  const name = path.split("/").pop().toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop() : "";
  return ["md", "mdx", "markdown"].includes(extension)
    || ["readme", "changelog", "contributing", "agents", "claude"].includes(name);
}

function updateRepositoryFileView() {
  const markdown = Boolean(repositoryFile && markdownPath(repositoryFile.path));
  const preview = markdown && markdownView === "preview";
  markdownViewToggle.hidden = !markdown;
  repositoryMarkdownPreview.hidden = !preview;
  repositoryFileContent.hidden = !repositoryFile || preview;
  gitCommitPreview.hidden = true;
  document.querySelectorAll("[data-markdown-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.markdownView === markdownView);
  });
}

function replaceBrokenMarkdownImage(image) {
  const replacement = document.createElement("span");
  replacement.className = "markdown-image-placeholder";
  replacement.textContent = image.alt ? `Image: ${image.alt}` : "Image unavailable";
  image.replaceWith(replacement);
}

function watchMarkdownImages() {
  repositoryMarkdownPreview.querySelectorAll("img").forEach((image) => {
    image.addEventListener("error", () => replaceBrokenMarkdownImage(image), { once: true });
    if (image.complete && image.naturalWidth === 0) replaceBrokenMarkdownImage(image);
  });
}

function renderRepositoryTree() {
  let entries;
  if (repositoryFilter === "documentation") {
    entries = repositoryEntries.filter((entry) => entry.documentation);
  } else {
    entries = repositoryEntries.filter((entry) =>
      !repositoryAncestors(entry.path).some((ancestor) => collapsedRepositoryPaths.has(ancestor)));
  }
  repositoryTree.innerHTML = entries.length ? entries.map((entry) => {
    const selected = repositoryFile?.path === entry.path;
    if (repositoryFilter === "documentation") {
      return `<button class="repository-tree-item documentation ${selected ? "selected" : ""}" type="button" role="treeitem" data-repository-path="${escapeHtml(entry.path)}">
        <span class="repository-entry-icon">¶</span>
        <span class="repository-entry-copy"><strong>${escapeHtml(entry.name)}</strong><small>${escapeHtml(entry.path)}</small></span>
      </button>`;
    }
    const collapsed = entry.isDirectory && collapsedRepositoryPaths.has(entry.path);
    return `<button class="repository-tree-item ${entry.isDirectory ? "directory" : ""} ${selected ? "selected" : ""}" type="button" role="treeitem" aria-expanded="${entry.isDirectory ? String(!collapsed) : "false"}" data-repository-path="${escapeHtml(entry.path)}" style="--repository-depth:${entry.depth}">
      <span class="repository-entry-icon">${entry.isDirectory ? (collapsed ? "›" : "⌄") : (entry.documentation ? "¶" : "·")}</span>
      <span class="repository-entry-copy"><strong>${escapeHtml(entry.name)}</strong></span>
    </button>`;
  }).join("") : `<div class="repository-tree-empty">${repositoryFilter === "documentation" ? "No documentation files found." : "This repository is empty."}</div>`;
  document.querySelector("#repository-limit-note").hidden = !repositoryTruncated;
}

const gitLaneColors = [
  "#79d99d",
  "#68a7e8",
  "#e2b95f",
  "#ff7a90",
  "#a58bd8",
  "#55c2c8",
  "#f08db5",
  "#9fc46b",
];

function gitColor(value, fallback = 0) {
  let hash = 0;
  for (const character of value || String(fallback)) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return gitLaneColors[Math.abs(hash) % gitLaneColors.length];
}

function gitRefLabel(reference) {
  return reference.replace(/^HEAD -> /, "").replace(/^tag: /, "");
}

function gitRefColor(reference) {
  const label = gitRefLabel(reference);
  const key = label.startsWith("tag:") ? label : label.split("/").at(-1);
  return gitColor(key);
}

function gitRefTemplate(reference) {
  const color = gitRefColor(reference);
  return `<span class="git-ref" style="color:${color}" title="${escapeHtml(reference)}">${escapeHtml(gitRefLabel(reference))}</span>`;
}

function layoutGitCommits(commits) {
  const lanes = [];
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash);
    if (lane < 0) {
      lane = lanes.findIndex((value) => !value);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = commit.hash;
    }
    const before = lanes.slice();
    const parentLanes = [];
    if (!commit.parents.length) {
      lanes[lane] = null;
    } else {
      const firstParent = commit.parents[0];
      const existingFirst = lanes.indexOf(firstParent);
      if (existingFirst >= 0 && existingFirst !== lane) {
        lanes[lane] = null;
        parentLanes.push(existingFirst);
      } else {
        lanes[lane] = firstParent;
        parentLanes.push(lane);
      }
      for (const parent of commit.parents.slice(1)) {
        let target = lanes.indexOf(parent);
        if (target < 0) {
          target = lanes.findIndex((value) => !value);
          if (target < 0) target = lanes.length;
          lanes[target] = parent;
        }
        parentLanes.push(target);
      }
    }
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index] && lanes.indexOf(lanes[index]) !== index) lanes[index] = null;
    }
    while (lanes.length && lanes.at(-1) == null) lanes.pop();
    return {
      commit,
      lane,
      before,
      after: lanes.slice(),
      parentLanes,
      laneCount: Math.max(before.length, lanes.length, lane + 1),
    };
  });
}

function gitGraphSvg(layout) {
  const step = 14;
  const padding = 8;
  const centerY = 23;
  const height = 46;
  const x = (lane) => padding + lane * step;
  const paths = [];
  for (let lane = 0; lane < layout.laneCount; lane += 1) {
    if (lane === layout.lane) continue;
    if (layout.before[lane] || layout.after[lane]) {
      paths.push(`<path d="M${x(lane)} 0 V${height}" stroke="${gitLaneColors[lane % gitLaneColors.length]}" />`);
    }
  }
  const currentColor = layout.commit.refs.length
    ? gitRefColor(layout.commit.refs[0])
    : gitLaneColors[layout.lane % gitLaneColors.length];
  paths.push(`<path d="M${x(layout.lane)} 0 V${centerY}" stroke="${currentColor}" />`);
  for (const parentLane of layout.parentLanes) {
    const targetColor = gitLaneColors[parentLane % gitLaneColors.length];
    paths.push(`<path d="M${x(layout.lane)} ${centerY} C${x(layout.lane)} 35 ${x(parentLane)} 34 ${x(parentLane)} ${height}" stroke="${targetColor}" />`);
  }
  paths.push(`<circle cx="${x(layout.lane)}" cy="${centerY}" r="5" fill="${currentColor}" stroke="#08090b" stroke-width="2" />`);
  const width = padding * 2 + Math.max(1, layout.laneCount) * step;
  return `<svg class="git-graph-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${paths.join("")}</svg>`;
}

function renderGitGraph() {
  const layouts = layoutGitCommits(gitGraphCommits);
  gitGraph.innerHTML = layouts.length ? layouts.map((layout) => {
    const commit = layout.commit;
    const date = Number.isNaN(Date.parse(commit.date))
      ? commit.date
      : new Date(commit.date).toLocaleString();
    return `<button type="button" class="git-commit-row ${commit.hash === selectedGitCommitHash ? "selected" : ""}" role="listitem" data-git-commit="${commit.hash}">
      ${gitGraphSvg(layout)}
      <span class="git-commit-copy">
        ${commit.refs.length ? `<span class="git-ref-list">${commit.refs.map(gitRefTemplate).join("")}</span>` : ""}
        <span class="git-commit-subject">${escapeHtml(commit.subject)}</span>
        <span class="git-commit-meta">${escapeHtml(commit.shortHash)} · ${escapeHtml(commit.author)} · ${escapeHtml(date)}</span>
      </span>
    </button>`;
  }).join("") : `<div class="repository-tree-empty">No commits found.</div>`;
  gitGraphLimitNote.hidden = !gitGraphTruncated;
}

function showGitCommitPreview(detail) {
  repositoryFile = null;
  selectedGitCommitHash = detail.hash;
  repositoryFileContent.hidden = true;
  repositoryMarkdownPreview.hidden = true;
  repositoryPreviewEmpty.hidden = true;
  markdownViewToggle.hidden = true;
  repositoryCopyButton.hidden = true;
  gitCommitPreview.hidden = false;
  document.querySelector("#repository-file-path").textContent =
    `${detail.shortHash} · ${detail.subject}`;
  document.querySelector("#repository-file-meta").textContent =
    `${detail.author} · ${new Date(detail.date).toLocaleString()}`;
  document.querySelector("#git-commit-refs").innerHTML =
    detail.refs.map(gitRefTemplate).join("");
  document.querySelector("#git-commit-body").textContent = detail.body;
  document.querySelector("#git-commit-hash").textContent = detail.hash;
  document.querySelector("#git-commit-parents").textContent =
    detail.parents.length ? detail.parents.map((parent) => parent.slice(0, 7)).join(", ") : "Root commit";
  document.querySelector("#git-commit-author").textContent = detail.author;
  document.querySelector("#git-commit-date").textContent =
    Number.isNaN(Date.parse(detail.date)) ? detail.date : new Date(detail.date).toLocaleString();
  document.querySelector("#git-commit-stats").textContent = detail.stats || "No file changes";
  document.querySelector("#git-commit-files").innerHTML = detail.files.map((file) =>
    `<div class="git-changed-file"><span class="git-file-status">${escapeHtml(file.status)}</span><span>${escapeHtml(file.path)}</span></div>`
  ).join("");
  renderGitGraph();
}

async function readGitCommit(hash) {
  const project = activeProject();
  if (!project || repositoryFilter !== "git") return;
  const projectId = project.id;
  selectedGitCommitHash = hash;
  renderGitGraph();
  document.querySelector("#repository-file-path").textContent = hash.slice(0, 7);
  document.querySelector("#repository-file-meta").textContent = "Loading commit…";
  try {
    const detail = await call("get_git_commit", { projectId, hash });
    if (activeProjectId !== projectId || repositoryFilter !== "git" || repositoryBrowser.hidden) return;
    showGitCommitPreview(detail);
  } catch (error) {
    showRepositoryPreview("Commit unavailable", error.message, true);
  }
}

async function refreshGitGraph() {
  const project = activeProject();
  if (!project) return;
  const projectId = project.id;
  repositoryProjectId = projectId;
  gitGraphProjectId = projectId;
  selectedGitCommitHash = null;
  gitGraphCommits = [];
  showRepositoryPreview("Git history", "Select a commit to inspect its details.");
  gitGraph.innerHTML = `<div class="repository-tree-empty">Reading Git history…</div>`;
  try {
    const graph = await call("get_git_graph", { projectId });
    if (activeProjectId !== projectId || repositoryFilter !== "git" || repositoryBrowser.hidden) return;
    gitGraphCommits = graph.commits;
    gitGraphTruncated = graph.truncated;
    renderGitGraph();
    if (gitGraphCommits[0]) await readGitCommit(gitGraphCommits[0].hash);
  } catch (error) {
    gitGraphCommits = [];
    gitGraphTruncated = false;
    showRepositoryPreview("Git history unavailable", error.message, true);
    gitGraph.innerHTML = `<div class="repository-tree-empty error">${escapeHtml(error.message)}</div>`;
  }
}

async function setRepositoryFilter(filter) {
  repositoryFilter = filter;
  const gitMode = filter === "git";
  repositoryBrowser.classList.toggle("git-mode", gitMode);
  document.querySelectorAll("[data-repository-filter]").forEach((item) => {
    item.classList.toggle("active", item.dataset.repositoryFilter === filter);
  });
  repositoryTree.hidden = gitMode;
  gitGraph.hidden = !gitMode;
  document.querySelector("#repository-limit-note").hidden = gitMode || !repositoryTruncated;
  gitGraphLimitNote.hidden = !gitMode || !gitGraphTruncated;
  if (gitMode) {
    if (gitGraphProjectId !== activeProjectId || !gitGraphCommits.length) {
      await refreshGitGraph();
    } else {
      renderGitGraph();
      if (selectedGitCommitHash) await readGitCommit(selectedGitCommitHash);
      else showRepositoryPreview("Git history", "Select a commit to inspect its details.");
    }
  } else {
    gitCommitPreview.hidden = true;
    showRepositoryPreview(
      "Choose a file",
      filter === "documentation"
        ? "Select project documentation from the list."
        : "Select source code or documentation from the repository.",
    );
    renderRepositoryTree();
  }
}

async function refreshRepositoryView() {
  if (repositoryFilter === "git") await refreshGitGraph();
  else await refreshRepository();
}

function showRepositoryPreview(title, message, isError = false) {
  repositoryFile = null;
  repositoryFileContent.hidden = true;
  repositoryMarkdownPreview.hidden = true;
  repositoryMarkdownPreview.replaceChildren();
  markdownViewToggle.hidden = true;
  repositoryCopyButton.hidden = true;
  gitCommitPreview.hidden = true;
  repositoryPreviewEmpty.hidden = false;
  repositoryPreviewEmpty.classList.toggle("error", isError);
  repositoryPreviewEmpty.innerHTML = `<span aria-hidden="true">${isError ? "!" : "⌁"}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p>`;
  document.querySelector("#repository-file-path").textContent = title;
  document.querySelector("#repository-file-meta").textContent = message;
  if (repositoryFilter === "git") renderGitGraph();
  else renderRepositoryTree();
}

async function readRepositoryFile(path) {
  const project = activeProject();
  if (!project) return;
  const projectId = project.id;
  document.querySelector("#repository-file-path").textContent = path;
  document.querySelector("#repository-file-meta").textContent = "Loading preview…";
  try {
    const file = await call("read_repository_file", { projectId, path });
    if (activeProjectId !== projectId || repositoryBrowser.hidden) return;
    repositoryFile = file;
    repositoryFileContent.querySelector("code").textContent = file.content;
    repositoryFileContent.classList.toggle("documentation", file.documentation);
    markdownView = "preview";
    if (markdownPath(file.path)) {
      const rendered = marked.parse(file.content, { gfm: true });
      repositoryMarkdownPreview.innerHTML = DOMPurify.sanitize(rendered, {
        USE_PROFILES: { html: true },
      });
      watchMarkdownImages();
    } else {
      repositoryMarkdownPreview.replaceChildren();
    }
    repositoryPreviewEmpty.hidden = true;
    repositoryCopyButton.hidden = false;
    gitCommitPreview.hidden = true;
    updateRepositoryFileView();
    document.querySelector("#repository-file-path").textContent = file.path;
    const lines = file.content ? file.content.split("\n").length : 0;
    document.querySelector("#repository-file-meta").textContent =
      `${file.documentation ? "Documentation" : "Source"} · ${formatFileSize(file.size)} · ${lines} line${lines === 1 ? "" : "s"}`;
    renderRepositoryTree();
  } catch (error) {
    showRepositoryPreview(path, error.message, true);
  }
}

async function refreshRepository() {
  const project = activeProject();
  if (!project) return;
  const projectId = project.id;
  repositoryProjectId = projectId;
  repositoryFile = null;
  repositoryEntries = [];
  document.querySelector("#repository-project-name").textContent = project.name;
  showRepositoryPreview("Choose a file", "Select source code or documentation from the repository.");
  repositoryTree.innerHTML = `<div class="repository-tree-empty">Reading repository…</div>`;
  try {
    const repository = await call("get_repository", { projectId });
    if (activeProjectId !== projectId || repositoryBrowser.hidden) return;
    repositoryEntries = repository.entries;
    repositoryTruncated = repository.truncated;
    collapsedRepositoryPaths = new Set();
    renderRepositoryTree();
  } catch (error) {
    repositoryEntries = [];
    repositoryTruncated = false;
    showRepositoryPreview("Repository unavailable", error.message, true);
    repositoryTree.innerHTML = `<div class="repository-tree-empty error">${escapeHtml(error.message)}</div>`;
  }
}

function sshTunnelDestination(tunnel) {
  return tunnel.username ? `${tunnel.username}@${tunnel.sshHost}` : tunnel.sshHost;
}

function renderSshTunnels() {
  const runningCount = sshTunnels.filter((tunnel) => tunnel.running).length;
  document.querySelector("#ssh-tunnels-count").textContent = String(runningCount);
  document.querySelector("#ssh-tunnels-count").classList.toggle("active", runningCount > 0);
  document.querySelector("#ssh-tunnels-summary").textContent = sshTunnels.length
    ? `${runningCount} active · ${sshTunnels.length} defined`
    : "No tunnels defined";
  if (!sshTunnels.length) {
    sshTunnelsList.innerHTML = `<div class="ssh-tunnels-empty">
      <span aria-hidden="true">⇄</span>
      <strong>No routes defined</strong>
      <p>Add a tunnel to forward a local port through an SSH host.</p>
      <button class="button primary" type="button" data-tunnel-action="new">Define first tunnel</button>
    </div>`;
    return;
  }
  sshTunnelsList.innerHTML = sshTunnels.map((tunnel) => `
    <article class="ssh-tunnel-card ${tunnel.running ? "running" : ""}" data-tunnel-id="${escapeHtml(tunnel.id)}">
      <div class="ssh-tunnel-card-header">
        <div class="ssh-tunnel-name">
          <span class="status-dot ${tunnel.running ? "running" : ""}"></span>
          <span>
            <strong>${escapeHtml(tunnel.name)}</strong>
            <small>via ${escapeHtml(sshTunnelDestination(tunnel))}:${tunnel.sshPort}</small>
          </span>
        </div>
        <label class="ssh-tunnel-switch">
          <input type="checkbox" data-tunnel-toggle="${escapeHtml(tunnel.id)}" ${tunnel.running ? "checked" : ""}>
          <span aria-hidden="true"></span>
          <em>${tunnel.running ? "On" : "Off"}</em>
        </label>
      </div>
      <div class="ssh-tunnel-route">
        <div>
          <small>LOCAL</small>
          <code>127.0.0.1:${tunnel.localPort}</code>
        </div>
        <span class="ssh-tunnel-route-line" aria-hidden="true"><i></i></span>
        <div>
          <small>TARGET</small>
          <code>${escapeHtml(tunnel.remoteHost)}:${tunnel.remotePort}</code>
        </div>
      </div>
      <div class="ssh-tunnel-card-footer">
        <span>${tunnel.identityFile ? `Key · ${escapeHtml(tunnel.identityFile)}` : "SSH agent or config"}</span>
        <div>
          <button class="button ghost" type="button" data-tunnel-action="edit" ${tunnel.running ? "disabled" : ""}>Edit</button>
          <button class="button ghost danger" type="button" data-tunnel-action="delete">Delete</button>
        </div>
      </div>
    </article>
  `).join("");
}

async function refreshSshTunnels({ quiet = false } = {}) {
  try {
    sshTunnels = await call("get_ssh_tunnels");
    renderSshTunnels();
    if (!quiet) showToast("Tunnel status refreshed.");
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  }
}

function scheduleSshTunnelPoll() {
  clearTimeout(sshTunnelsTimer);
  if (sshTunnelsView.hidden) return;
  sshTunnelsTimer = setTimeout(async () => {
    await refreshSshTunnels({ quiet: true });
    scheduleSshTunnelPoll();
  }, 3000);
}

async function openSshTunnels() {
  if (popoutWindowId) return;
  closeRunningApps();
  if (!repositoryBrowser.hidden) closeRepository();
  closeActivityPanel();
  grid.hidden = true;
  sshTunnelsView.hidden = false;
  sshTunnelsButton.classList.add("active");
  sshTunnelsButton.setAttribute("aria-pressed", "true");
  await refreshSshTunnels({ quiet: true });
  scheduleSshTunnelPoll();
}

function closeSshTunnels() {
  if (sshTunnelsView.hidden) return;
  clearTimeout(sshTunnelsTimer);
  sshTunnelsView.hidden = true;
  grid.hidden = false;
  sshTunnelsButton.classList.remove("active");
  sshTunnelsButton.setAttribute("aria-pressed", "false");
  requestAnimationFrame(() => terminals.forEach((entry) => entry.fitAddon.fit()));
}

function openSshTunnelModal(tunnel = null) {
  editingSshTunnelId = tunnel?.id || null;
  document.querySelector("#ssh-tunnel-dialog-eyebrow").textContent = tunnel ? "Edit route" : "New route";
  document.querySelector("#ssh-tunnel-dialog-title").textContent = tunnel ? tunnel.name : "Define SSH tunnel";
  document.querySelector("#save-ssh-tunnel-button").textContent = tunnel ? "Save changes" : "Save tunnel";
  document.querySelector("#ssh-tunnel-name").value = tunnel?.name || "";
  document.querySelector("#ssh-tunnel-host").value = tunnel?.sshHost || "";
  document.querySelector("#ssh-tunnel-ssh-port").value = tunnel?.sshPort || 22;
  document.querySelector("#ssh-tunnel-username").value = tunnel?.username || "";
  document.querySelector("#ssh-tunnel-identity").value = tunnel?.identityFile || "";
  document.querySelector("#ssh-tunnel-local-port").value = tunnel?.localPort || "";
  document.querySelector("#ssh-tunnel-remote-host").value = tunnel?.remoteHost || "127.0.0.1";
  document.querySelector("#ssh-tunnel-remote-port").value = tunnel?.remotePort || "";
  sshTunnelDialog.showModal();
  document.querySelector("#ssh-tunnel-name").focus();
}

async function setSshTunnelEnabled(id, enabled, input) {
  input.disabled = true;
  try {
    await call("set_ssh_tunnel_enabled", { id, enabled });
    await refreshSshTunnels({ quiet: true });
    showToast(`Tunnel ${enabled ? "started" : "stopped"}.`);
  } catch (error) {
    await refreshSshTunnels({ quiet: true });
    showToast(error.message, true);
  }
}

async function deleteSshTunnel(id) {
  const tunnel = sshTunnels.find((item) => item.id === id);
  if (!tunnel || !window.confirm(`Delete SSH tunnel “${tunnel.name}”?`)) return;
  try {
    await call("delete_ssh_tunnel", { id });
    await refreshSshTunnels({ quiet: true });
    showToast("Tunnel deleted.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function runningAppKind(group) {
  if (group.kind === "compose") return { icon: "≋", label: "Docker Compose" };
  if (group.kind === "project") return { icon: "›_", label: "Agent Grid project" };
  return { icon: "◇", label: "Docker container" };
}

function renderRunningApps() {
  const groupCount = runningApps.groups.length;
  const serviceCount = runningApps.serviceCount || 0;
  document.querySelector("#running-apps-count").textContent = String(serviceCount);
  document.querySelector("#running-apps-count").classList.toggle("active", serviceCount > 0);
  document.querySelector("#running-apps-summary").textContent = serviceCount
    ? `${serviceCount} running · ${groupCount} ${groupCount === 1 ? "group" : "groups"}`
    : "Nothing detected";
  document.querySelector("#running-apps-service-total").textContent = String(serviceCount);
  document.querySelector("#running-apps-group-total").textContent = String(groupCount);
  const warning = document.querySelector("#running-apps-docker-warning");
  warning.hidden = !runningApps.dockerError;
  warning.textContent = runningApps.dockerError ? `Docker: ${runningApps.dockerError}` : "";
  if (!groupCount) {
    runningAppsList.innerHTML = `<div class="running-apps-empty">
      <span aria-hidden="true">◫</span>
      <strong>No applications detected</strong>
      <p>Start a Docker container or a local service inside an Agent Grid terminal.</p>
    </div>`;
    return;
  }
  runningAppsList.innerHTML = runningApps.groups.map((group) => {
    const kind = runningAppKind(group);
    const openingUrl = appOpeningDrafts.has(group.id)
      ? appOpeningDrafts.get(group.id)
      : group.openingUrl || "";
    return `
      <article class="running-app-group ${escapeHtml(group.kind)}" data-app-group="${escapeHtml(group.id)}">
        <header class="running-app-group-header">
          <span class="running-app-group-icon" aria-hidden="true">${kind.icon}</span>
          <div>
            <div class="running-app-group-title">
              <strong>${escapeHtml(group.name)}</strong>
              <span>${group.services.length} ${group.services.length === 1 ? "service" : "services"}</span>
            </div>
            <small>${escapeHtml(kind.label)} · ${escapeHtml(shortPath(group.source))}</small>
          </div>
        </header>
        <div class="running-app-services">
          ${group.services.map((service) => `
            <div class="running-app-service">
              <span class="status-dot running"></span>
              <div class="running-app-service-copy">
                <strong>${escapeHtml(service.name)}</strong>
                <small>${escapeHtml(service.image || service.status)}</small>
              </div>
              <div class="running-app-ports">
                ${service.ports.length ? service.ports.map((port) => `
                  <button type="button" data-open-app-url="${escapeHtml(port.url)}" title="Open ${escapeHtml(port.url)}">${escapeHtml(port.label)}</button>
                `).join("") : `<span>No published port</span>`}
              </div>
            </div>
          `).join("")}
        </div>
        <form class="app-opening-form" data-app-opening-form="${escapeHtml(group.id)}">
          <label>
            <span>DEFAULT OPENING URL ${group.customOpeningUrl ? "· CUSTOM" : "· AUTO"}</span>
            <input class="app-opening-url" name="url" type="url" value="${escapeHtml(openingUrl)}" placeholder="http://127.0.0.1:3000" spellcheck="false">
          </label>
          <button class="button ghost" type="submit">Save</button>
          <button class="button primary" type="button" data-open-app-url="${escapeHtml(openingUrl)}" ${openingUrl ? "" : "disabled"}>Open</button>
        </form>
      </article>
    `;
  }).join("");
}

async function refreshRunningApps({ quiet = false } = {}) {
  if (popoutWindowId || runningAppsRequestInFlight) return;
  runningAppsRequestInFlight = true;
  try {
    runningApps = await call("get_running_apps");
    renderRunningApps();
    if (!quiet) showToast("Running applications refreshed.");
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  } finally {
    runningAppsRequestInFlight = false;
  }
}

function scheduleRunningAppsPoll() {
  clearTimeout(runningAppsTimer);
  if (popoutWindowId) return;
  const interval = runningAppsView.hidden
    ? (projects.some((project) => project.remote) ? 30000 : 15000)
    : 5000;
  runningAppsTimer = setTimeout(async () => {
    if (!document.hidden) await refreshRunningApps({ quiet: true });
    scheduleRunningAppsPoll();
  }, interval);
}

async function openRunningApps() {
  if (popoutWindowId) return;
  if (!repositoryBrowser.hidden) closeRepository();
  closeSshTunnels();
  closeActivityPanel();
  grid.hidden = true;
  runningAppsView.hidden = false;
  runningAppsButton.classList.add("active");
  runningAppsButton.setAttribute("aria-pressed", "true");
  await refreshRunningApps({ quiet: true });
  scheduleRunningAppsPoll();
}

function closeRunningApps() {
  if (runningAppsView.hidden) return;
  runningAppsView.hidden = true;
  grid.hidden = false;
  runningAppsButton.classList.remove("active");
  runningAppsButton.setAttribute("aria-pressed", "false");
  scheduleRunningAppsPoll();
  requestAnimationFrame(() => terminals.forEach((entry) => entry.fitAddon.fit()));
}

async function saveAppOpeningUrl(form) {
  const groupId = form.dataset.appOpeningForm;
  const input = form.querySelector(".app-opening-url");
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await call("set_app_opening_url", { groupId, url: input.value });
    appOpeningDrafts.delete(groupId);
    await refreshRunningApps({ quiet: true });
    showToast(input.value.trim() ? "Default opening URL saved." : "Default opening URL reset.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}


async function openRepository(projectId = activeProjectId) {
  if (!projectId || popoutWindowId) return;
  if (projectId !== activeProjectId) {
    activeProjectId = projectId;
    localStorage.setItem("agent-grid-project", projectId);
    await render();
    await refreshGitStatus({ quiet: true });
  }
  closeActivityPanel();
  closeSshTunnels();
  closeRunningApps();
  grid.hidden = true;
  repositoryBrowser.hidden = false;
  document.querySelector("#repository-button").classList.add("active");
  document.querySelector("#repository-button").setAttribute("aria-pressed", "true");
  updateEditorControls();
  if (repositoryProjectId !== projectId) await refreshRepositoryView();
}

function closeRepository() {
  if (repositoryBrowser.hidden) return;
  repositoryBrowser.hidden = true;
  grid.hidden = false;
  repositoryProjectId = null;
  document.querySelector("#repository-button").classList.remove("active");
  document.querySelector("#repository-button").setAttribute("aria-pressed", "false");
  requestAnimationFrame(() => terminals.forEach((entry) => entry.fitAddon.fit()));
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
  renderGitStatus();
  const project = activeProject();
  document.querySelector("#workspace-title").textContent = project ? project.name : "Agent Grid";
  newWindowButton.disabled = !project;
  document.querySelector("#repository-button").disabled = !project || Boolean(popoutWindowId);
  updateEditorControls();
  if (!project && !repositoryBrowser.hidden) closeRepository();
  const repositoryNeedsRefresh = !repositoryBrowser.hidden && repositoryProjectId !== project?.id;
  grid.classList.remove("has-maximized", "drag-active");

  const windows = activeWindows();
  if (!windows.length) {
    currentLayout = null;
    selectedWindowId = null;
    maximizedWindowId = null;
    renderEmptyState();
    if (workspace.classList.contains("activity-open")) await refreshTimeline();
    if (repositoryNeedsRefresh) await refreshRepositoryView();
    return;
  }
  if (!windows.some((window) => window.id === selectedWindowId)) selectedWindowId = windows[0].id;
  maximizedWindowId = compactMode && !popoutWindowId ? selectedWindowId : null;
  currentLayout = popoutWindowId ? leaf(popoutWindowId) : loadLayout();
  grid.innerHTML = `<div class="tile-root">${renderLayoutNode(currentLayout)}</div>`;
  grid.classList.toggle("has-maximized", Boolean(maximizedWindowId));
  await Promise.all(windows.map(connectTerminal));
  if (workspace.classList.contains("activity-open")) await refreshTimeline();
  if (repositoryNeedsRefresh) await refreshRepositoryView();
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
    if (!popoutWindowId) await refreshGitStatus({ quiet: true });
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

function renderGitStatus() {
  const project = activeProject();
  const status = gitStatusProjectId === project?.id ? gitStatus : null;
  const loading = Boolean(project) && !status && !gitStatusError;
  gitSection.classList.toggle("unavailable", !status?.available);
  gitRefreshButton.disabled = !project || gitOperationInFlight;

  if (!project) {
    gitBranchSelect.innerHTML = "<option>No project</option>";
    gitBranchSelect.disabled = true;
    gitPullButton.disabled = true;
    gitPushButton.disabled = true;
    gitSummary.textContent = "No project selected";
    return;
  }
  if (loading) {
    gitBranchSelect.innerHTML = "<option>Loading…</option>";
    gitBranchSelect.disabled = true;
    gitPullButton.disabled = true;
    gitPushButton.disabled = true;
    gitSummary.textContent = "Reading Git status…";
    return;
  }
  if (!status?.available) {
    gitBranchSelect.innerHTML = `<option>${escapeHtml(status?.head || "Git unavailable")}</option>`;
    gitBranchSelect.disabled = true;
    gitPullButton.disabled = true;
    gitPushButton.disabled = true;
    gitSummary.textContent = gitStatusError || "Not a Git repository";
    return;
  }

  const detached = status.branch ? "" : `<option value="" selected disabled>${escapeHtml(status.head)}</option>`;
  gitBranchSelect.innerHTML = detached + status.branches.map((branch) =>
    `<option value="${escapeHtml(branch)}" ${branch === status.branch ? "selected" : ""}>${escapeHtml(branch)}</option>`
  ).join("");
  gitBranchSelect.disabled = gitOperationInFlight || !status.branches.length;
  gitPullButton.disabled = gitOperationInFlight || !status.hasUpstream;
  gitPushButton.disabled = gitOperationInFlight || !status.branch;
  gitPullButton.title = status.hasUpstream ? `Pull ${status.upstream}` : "Current branch has no upstream";
  gitPushButton.title = status.hasUpstream ? `Push ${status.upstream}` : "Publish current branch to origin";

  const summary = [
    status.dirty ? `<span class="dirty">● changes</span>` : "Clean",
    status.ahead ? `<span class="ahead">↑${status.ahead}</span>` : "",
    status.behind ? `<span class="behind">↓${status.behind}</span>` : "",
    status.upstream ? escapeHtml(status.upstream) : "No upstream",
  ].filter(Boolean);
  gitSummary.innerHTML = summary.join(" · ");
}

async function refreshGitStatus({ quiet = true } = {}) {
  const project = activeProject();
  if (!project || popoutWindowId) {
    gitStatus = null;
    gitStatusProjectId = null;
    gitStatusError = null;
    renderGitStatus();
    return;
  }
  const projectId = project.id;
  try {
    const status = await call("get_git_status", { projectId });
    if (activeProjectId !== projectId) return;
    gitStatus = status;
    gitStatusProjectId = projectId;
    gitStatusError = null;
  } catch (error) {
    if (activeProjectId !== projectId) return;
    gitStatus = null;
    gitStatusProjectId = projectId;
    gitStatusError = error.message;
    if (!quiet) showToast(`Git status failed: ${error.message}`, true);
  }
  renderGitStatus();
}

async function runGitOperation(command, args, successMessage) {
  const project = activeProject();
  if (!project || gitOperationInFlight) return;
  const projectId = project.id;
  gitOperationInFlight = true;
  renderGitStatus();
  try {
    const status = await call(command, { projectId, ...args });
    if (activeProjectId === projectId) {
      gitStatus = status;
      gitStatusProjectId = projectId;
      gitStatusError = null;
      showToast(successMessage);
      if (!repositoryBrowser.hidden && repositoryFilter === "git") await refreshGitGraph();
    }
  } catch (error) {
    showToast(`Git operation failed: ${error.message}`, true);
    await refreshGitStatus({ quiet: true });
  } finally {
    gitOperationInFlight = false;
    renderGitStatus();
  }
}

function scheduleGitStatusPoll() {
  clearTimeout(gitStatusTimer);
  const interval = activeProject()?.remote ? 15000 : 5000;
  gitStatusTimer = setTimeout(async () => {
    if (!document.hidden) await refreshGitStatus({ quiet: true });
    scheduleGitStatusPoll();
  }, interval);
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
  statusTimer = setTimeout(pollStatuses, projects.some((project) => project.remote) ? 5000 : 2500);
}

function renderProjectSshOptions(selected = "") {
  const select = document.querySelector("#project-ssh-profile");
  select.innerHTML = `<option value="">Local machine</option>${sshProfiles.map((profile) =>
    `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)} · ${escapeHtml(profile.host)}</option>`
  ).join("")}`;
  select.value = selected || "";
}

function updateProjectLocationControls() {
  const profileId = document.querySelector("#project-ssh-profile").value;
  const remote = Boolean(profileId);
  const browse = document.querySelector('[data-browse="project-cwd"]');
  browse.hidden = false;
  browse.textContent = remote ? "Browse remote…" : "Browse…";
  document.querySelector("#project-location-help").textContent = remote
    ? "tmux, commands, Git, files, Docker, and ports use the selected SSH host."
    : "Commands, tmux, Git, and files use this machine.";
  document.querySelector("#project-cwd").placeholder = remote
    ? "/home/user/projects/application"
    : config.defaultCwd;
}

function renderSshProfiles() {
  sshProfileList.innerHTML = sshProfiles.length ? sshProfiles.map((profile) => {
    const status = sshProfileTestStates.get(profile.id);
    const statusCopy = status?.state === "testing"
      ? "Testing connection…"
      : status?.state === "connected"
        ? "Connected"
        : status?.state === "error"
          ? `Failed · ${status.message}`
          : "";
    return `
    <div class="ssh-profile-row ${status?.state || ""}" data-ssh-profile="${escapeHtml(profile.id)}">
      <span class="ssh-profile-mark" aria-hidden="true">⌁</span>
      <span>
        <strong>${escapeHtml(profile.name)}</strong>
        <small>Host ${escapeHtml(profile.host)}</small>
        ${statusCopy ? `<small class="ssh-profile-test-status ${escapeHtml(status.state)}" title="${escapeHtml(status.message || statusCopy)}">${escapeHtml(statusCopy)}</small>` : ""}
      </span>
      <button type="button" class="button ghost" data-ssh-profile-action="test" ${status?.state === "testing" ? "disabled" : ""}>Test</button>
      <button type="button" class="button ghost" data-ssh-profile-action="edit">Edit</button>
      <button type="button" class="icon-button danger-button" data-ssh-profile-action="delete" title="Delete SSH connection">×</button>
    </div>`;
  }).join("") : `<p class="ssh-profile-empty">No SSH connections configured.</p>`;
}

async function refreshSshProfiles() {
  sshProfiles = await call("get_ssh_profiles");
  renderSshProfiles();
}

function openSshProfileModal(profile = null) {
  editingSshProfileId = profile?.id || null;
  document.querySelector("#ssh-profile-dialog-eyebrow").textContent = profile ? "SSH connection" : "Remote development";
  document.querySelector("#ssh-profile-dialog-title").textContent = profile ? `Edit ${profile.name}` : "Add SSH connection";
  document.querySelector("#save-ssh-profile-button").textContent = profile ? "Save changes" : "Save connection";
  document.querySelector("#ssh-profile-name").value = profile?.name || "";
  document.querySelector("#ssh-profile-host").value = profile?.host || "";
  sshProfileDialog.showModal();
  document.querySelector("#ssh-profile-name").focus();
}

async function testSshProfile(id) {
  sshProfileTestStates.set(id, { state: "testing", message: "" });
  renderSshProfiles();
  try {
    await call("test_ssh_profile", { id });
    sshProfileTestStates.set(id, { state: "connected", message: "SSH connection succeeded." });
  } catch (error) {
    sshProfileTestStates.set(id, { state: "error", message: error.message });
  }
  renderSshProfiles();
}

async function deleteSshProfile(id) {
  const profile = sshProfiles.find((item) => item.id === id);
  if (!profile || !window.confirm(`Delete SSH connection “${profile.name}”?`)) return;
  try {
    await call("delete_ssh_profile", { id });
    await refreshSshProfiles();
    showToast("SSH connection deleted.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function remoteProfileForInput(inputId) {
  const profileId = inputId === "project-cwd"
    ? document.querySelector("#project-ssh-profile").value
    : activeProject()?.sshProfileId;
  return sshProfiles.find((profile) => profile.id === profileId) || null;
}

function renderRemoteDirectoryView() {
  document.querySelector("#remote-directory-path").textContent = remoteDirectoryView?.path || "Loading…";
  document.querySelector("#remote-directory-up").disabled = !remoteDirectoryView?.parent;
  document.querySelector("#select-remote-directory").disabled = !remoteDirectoryView;
  remoteDirectoryList.innerHTML = remoteDirectoryView
    ? remoteDirectoryView.entries.map((entry) => `
      <button type="button" class="remote-directory-entry" role="option" data-remote-directory="${escapeHtml(entry.path)}">
        <span aria-hidden="true">⌄</span><strong>${escapeHtml(entry.name)}</strong>
      </button>
    `).join("") || `<p class="remote-directory-empty">No child directories.</p>`
    : `<p class="remote-directory-empty">Reading remote directories…</p>`;
}

async function loadRemoteDirectory(path, allowHomeFallback = false) {
  remoteDirectoryView = null;
  renderRemoteDirectoryView();
  try {
    remoteDirectoryView = await call("list_remote_directories", {
      profileId: remoteDirectoryProfileId,
      path: path || null
    });
    renderRemoteDirectoryView();
  } catch (error) {
    if (allowHomeFallback && path) return loadRemoteDirectory(null, false);
    remoteDirectoryList.innerHTML = `<p class="remote-directory-empty error">${escapeHtml(error.message)}</p>`;
    document.querySelector("#remote-directory-path").textContent = "Remote directory unavailable";
  }
}

async function openRemoteDirectoryBrowser(profile, inputId) {
  remoteDirectoryProfileId = profile.id;
  remoteDirectoryTargetInput = inputId;
  remoteDirectoryView = null;
  remoteDirectoryDialog.showModal();
  renderRemoteDirectoryView();
  const current = document.querySelector(`#${inputId}`).value.trim();
  await loadRemoteDirectory(current.startsWith("/") ? current : null, true);
}

function openProjectModal() {
  editingProjectId = null;
  document.querySelector("#project-dialog-eyebrow").textContent = "New workspace";
  document.querySelector("#project-dialog-title").textContent = "Create a project";
  document.querySelector("#save-project-button").textContent = "Create project";
  document.querySelector("#project-name").value = `Project ${projects.length + 1}`;
  document.querySelector("#project-cwd").value = config.defaultCwd;
  document.querySelector("#project-command").value = config.defaultCommand;
  renderProjectSshOptions();
  document.querySelector("#project-ssh-profile").disabled = false;
  updateProjectLocationControls();
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
  renderProjectSshOptions(project.sshProfileId);
  document.querySelector("#project-ssh-profile").disabled = project.windows.length > 0;
  updateProjectLocationControls();
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
  const browse = document.querySelector('[data-browse="window-cwd"]');
  browse.hidden = false;
  browse.textContent = project.remote ? "Browse remote…" : "Browse…";
  windowDialog.showModal();
  setWindowKind("agent");
  document.querySelector("#window-name").select();
}

async function browseDirectory(inputId) {
  const profile = remoteProfileForInput(inputId);
  if (profile) return openRemoteDirectoryBrowser(profile, inputId);
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

function focusTerminalWindow(id) {
  const entry = terminals.get(id);
  if (!entry) return false;
  selectedWindowId = id;
  renderCompactNavigation();
  entry.terminal.focus();
  return true;
}

function focusWindowInDirection(direction) {
  if (grid.hidden) return;
  const cards = [...grid.querySelectorAll(".terminal-card[data-window-id]")]
    .filter((card) => terminals.has(card.dataset.windowId))
    .map((card) => {
      const rect = card.closest(".tile-leaf").getBoundingClientRect();
      return {
        id: card.dataset.windowId,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };
    });
  if (cards.length < 2) return;
  const focusedId = document.activeElement?.closest(".terminal-card")?.dataset.windowId;
  const currentId = focusedId || selectedWindowId || cards[0].id;
  const nextId = UiLayout.directionalNeighbor(cards, currentId, direction);
  if (!terminals.has(nextId)) return;
  if (compactMode || maximizedWindowId) applyMaximizedWindow(nextId);
  focusTerminalWindow(nextId);
}

async function switchProjectInDirection(direction) {
  if (grid.hidden || popoutWindowId || projectSwitchInFlight || projects.length < 2) return;
  const currentIndex = Math.max(0, projects.findIndex((project) => project.id === activeProjectId));
  const step = direction === "left" || direction === "up" ? -1 : 1;
  const target = projects[(currentIndex + step + projects.length) % projects.length];
  if (!target || target.id === activeProjectId) return;
  projectSwitchInFlight = true;
  try {
    activeProjectId = target.id;
    localStorage.setItem("agent-grid-project", activeProjectId);
    selectedWindowId = target.windows.find((window) => !poppedOutWindowIds.has(window.id))?.id
      || target.windows[0]?.id
      || null;
    await render();
    await refreshGitStatus({ quiet: true });
    focusTerminalWindow(selectedWindowId);
  } finally {
    projectSwitchInFlight = false;
  }
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
      if (!repositoryBrowser.hidden) closeRepository();
      if (!sshTunnelsView.hidden) closeSshTunnels();
      if (!runningAppsView.hidden) closeRunningApps();
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
  updateEditorControls();
  updateShortcutControls();
  renderSshProfiles();
  settingsDialog.showModal();
}

document.querySelector("#new-project-button").addEventListener("click", openProjectModal);
newWindowButton.addEventListener("click", openWindowModal);
document.querySelector("#activity-button").addEventListener("click", () => {
  if (workspace.classList.contains("activity-open")) closeActivityPanel();
  else {
    closeRepository();
    closeSshTunnels();
    closeRunningApps();
    openActivityPanel();
  }
});
document.querySelector("#close-activity-button").addEventListener("click", closeActivityPanel);
document.querySelector("#refresh-button").addEventListener("click", () => refreshProjects());
document.querySelector("#auto-grid-button").addEventListener("click", () => retile("auto"));
document.querySelector("#fewer-columns-button").addEventListener("click", () => retile("manual", layoutMode === "auto" ? 1 : layoutColumns - 1));
document.querySelector("#more-columns-button").addEventListener("click", () => retile("manual", layoutMode === "auto" ? 2 : layoutColumns + 1));
document.querySelector("#compact-mode-button").addEventListener("click", () => setCompactMode(!compactMode));
document.querySelector("#settings-button").addEventListener("click", openSettings);
document.querySelector("#terminal-font-size-range").addEventListener("input", (event) => setTerminalFontSize(event.target.value));
settingsDialog.addEventListener("click", (event) => {
  const profileAction = event.target.closest("[data-ssh-profile-action]")?.dataset.sshProfileAction;
  const profileId = event.target.closest("[data-ssh-profile]")?.dataset.sshProfile;
  const profile = sshProfiles.find((item) => item.id === profileId);
  if (profileAction === "test" && profile) return testSshProfile(profile.id);
  if (profileAction === "edit" && profile) return openSshProfileModal(profile);
  if (profileAction === "delete" && profile) return deleteSshProfile(profile.id);
  const record = event.target.closest("[data-shortcut-record]")?.dataset.shortcutRecord;
  if (record) return beginShortcutRecording(record);
  const reset = event.target.closest("[data-shortcut-reset]")?.dataset.shortcutReset;
  if (reset) resetShortcutBinding(reset);
});
settingsDialog.addEventListener("close", cancelShortcutRecording);
document.querySelector("#new-ssh-profile-button").addEventListener("click", () => openSshProfileModal());
document.querySelector("#project-ssh-profile").addEventListener("change", updateProjectLocationControls);
document.querySelector("#repository-button").addEventListener("click", () => {
  if (repositoryBrowser.hidden) openRepository();
  else closeRepository();
});
runningAppsButton.addEventListener("click", () => {
  if (runningAppsView.hidden) openRunningApps();
  else closeRunningApps();
});
document.querySelector("#running-apps-close-button").addEventListener("click", closeRunningApps);
document.querySelector("#running-apps-refresh-button").addEventListener("click", () => refreshRunningApps());
runningAppsList.addEventListener("click", (event) => {
  const url = event.target.closest("[data-open-app-url]")?.dataset.openAppUrl;
  if (url) openPort(url);
});
runningAppsList.addEventListener("input", (event) => {
  if (!event.target.matches(".app-opening-url")) return;
  const groupId = event.target.closest("[data-app-opening-form]")?.dataset.appOpeningForm;
  if (groupId) appOpeningDrafts.set(groupId, event.target.value);
});
runningAppsList.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-app-opening-form]");
  if (!form) return;
  event.preventDefault();
  saveAppOpeningUrl(form);
});
sshTunnelsButton.addEventListener("click", () => {
  if (sshTunnelsView.hidden) openSshTunnels();
  else closeSshTunnels();
});
document.querySelector("#ssh-tunnels-close-button").addEventListener("click", closeSshTunnels);
document.querySelector("#ssh-tunnels-refresh-button").addEventListener("click", () => refreshSshTunnels());
document.querySelector("#new-ssh-tunnel-button").addEventListener("click", () => openSshTunnelModal());
sshTunnelsList.addEventListener("change", (event) => {
  const toggle = event.target.closest("[data-tunnel-toggle]");
  if (toggle) setSshTunnelEnabled(toggle.dataset.tunnelToggle, toggle.checked, toggle);
});
sshTunnelsList.addEventListener("click", (event) => {
  const action = event.target.closest("[data-tunnel-action]")?.dataset.tunnelAction;
  if (action === "new") return openSshTunnelModal();
  const id = event.target.closest("[data-tunnel-id]")?.dataset.tunnelId;
  const tunnel = sshTunnels.find((item) => item.id === id);
  if (action === "edit" && tunnel) openSshTunnelModal(tunnel);
  if (action === "delete" && tunnel) deleteSshTunnel(id);
});
document.querySelector("#repository-close-button").addEventListener("click", closeRepository);
document.querySelector("#repository-refresh-button").addEventListener("click", refreshRepositoryView);
document.querySelector("#repository-open-editor-button").addEventListener("click", () => openProjectInEditor());
repositoryCopyButton.addEventListener("click", () => {
  if (repositoryFile) copyText(repositoryFile.content, `${repositoryFile.path} copied.`);
});
document.querySelector(".repository-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-repository-filter]");
  if (!button) return;
  setRepositoryFilter(button.dataset.repositoryFilter);
});
repositoryTree.addEventListener("click", (event) => {
  const path = event.target.closest("[data-repository-path]")?.dataset.repositoryPath;
  if (!path) return;
  const entry = repositoryEntries.find((item) => item.path === path);
  if (!entry) return;
  if (entry.isDirectory) {
    if (collapsedRepositoryPaths.has(path)) collapsedRepositoryPaths.delete(path);
    else collapsedRepositoryPaths.add(path);
    renderRepositoryTree();
  } else {
    readRepositoryFile(path);
  }
});
gitGraph.addEventListener("click", (event) => {
  const hash = event.target.closest("[data-git-commit]")?.dataset.gitCommit;
  if (hash) readGitCommit(hash);
});
markdownViewToggle.addEventListener("click", (event) => {
  const button = event.target.closest("[data-markdown-view]");
  if (!button || !repositoryFile || !markdownPath(repositoryFile.path)) return;
  markdownView = button.dataset.markdownView;
  updateRepositoryFileView();
});
repositoryMarkdownPreview.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link || link.getAttribute("href").startsWith("#")) return;
  event.preventDefault();
  const href = link.href;
  if (/^https?:/.test(href)) openPort(href);
  else showToast("Open local Markdown links from the file tree.");
});
preferredEditorSelect.addEventListener("change", () => {
  preferredEditor = preferredEditorSelect.value;
  localStorage.setItem(preferredEditorKey, preferredEditor);
  updateEditorControls();
});
preferredEditorCustom.addEventListener("input", () => {
  preferredEditorCommand = preferredEditorCustom.value;
  localStorage.setItem(preferredEditorCustomKey, preferredEditorCommand);
  updateEditorControls();
});
gitRefreshButton.addEventListener("click", () => refreshGitStatus({ quiet: false }));
gitBranchSelect.addEventListener("change", () => {
  if (gitBranchSelect.value && gitBranchSelect.value !== gitStatus?.branch) {
    runGitOperation(
      "switch_git_branch",
      { branch: gitBranchSelect.value },
      `Switched to ${gitBranchSelect.value}.`,
    );
  }
});
gitPullButton.addEventListener("click", () => runGitOperation("pull_git", {}, "Pull completed."));
gitPushButton.addEventListener("click", () => runGitOperation("push_git", {}, "Push completed."));
document.querySelector("#compact-menu-button").addEventListener("click", openCompactMenu);
document.querySelector("#close-compact-menu-button").addEventListener("click", closeCompactMenu);
compactDrawerBackdrop.addEventListener("click", closeCompactMenu);
compactProjectList.addEventListener("click", async (event) => {
  const id = event.target.closest("[data-compact-project]")?.dataset.compactProject;
  if (!id || id === activeProjectId) return closeCompactMenu();
  activeProjectId = id;
  localStorage.setItem("agent-grid-project", id);
  const project = projects.find((project) => project.id === id);
  selectedWindowId = project?.windows.find((window) => !poppedOutWindowIds.has(window.id))?.id
    || project?.windows[0]?.id
    || null;
  closeCompactMenu();
  await render();
  await refreshGitStatus({ quiet: true });
  focusTerminalWindow(selectedWindowId);
});
compactWindowList.addEventListener("click", (event) => {
  const id = event.target.closest("[data-compact-window]")?.dataset.compactWindow;
  if (!id) return;
  closeCompactMenu();
  applyMaximizedWindow(id);
  focusTerminalWindow(id);
});
document.querySelectorAll(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll(".browse-button").forEach((button) => button.addEventListener("click", () => browseDirectory(button.dataset.browse)));
remoteDirectoryList.addEventListener("click", (event) => {
  const path = event.target.closest("[data-remote-directory]")?.dataset.remoteDirectory;
  if (path) loadRemoteDirectory(path);
});
document.querySelector("#remote-directory-up").addEventListener("click", () => {
  if (remoteDirectoryView?.parent) loadRemoteDirectory(remoteDirectoryView.parent);
});
document.querySelector("#select-remote-directory").addEventListener("click", () => {
  if (!remoteDirectoryView || !remoteDirectoryTargetInput) return;
  document.querySelector(`#${remoteDirectoryTargetInput}`).value = remoteDirectoryView.path;
  remoteDirectoryDialog.close();
});
remoteDirectoryDialog.addEventListener("close", () => {
  remoteDirectoryProfileId = null;
  remoteDirectoryTargetInput = null;
  remoteDirectoryView = null;
});
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

sshTunnelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#save-ssh-tunnel-button");
  const input = {
    name: document.querySelector("#ssh-tunnel-name").value,
    sshHost: document.querySelector("#ssh-tunnel-host").value,
    sshPort: Number(document.querySelector("#ssh-tunnel-ssh-port").value),
    username: document.querySelector("#ssh-tunnel-username").value,
    localPort: Number(document.querySelector("#ssh-tunnel-local-port").value),
    remoteHost: document.querySelector("#ssh-tunnel-remote-host").value,
    remotePort: Number(document.querySelector("#ssh-tunnel-remote-port").value),
    identityFile: document.querySelector("#ssh-tunnel-identity").value || null
  };
  button.disabled = true;
  try {
    if (editingSshTunnelId) {
      await call("update_ssh_tunnel", { id: editingSshTunnelId, input });
      showToast("Tunnel updated.");
    } else {
      await call("create_ssh_tunnel", { input });
      showToast("Tunnel saved.");
    }
    sshTunnelDialog.close();
    editingSshTunnelId = null;
    await refreshSshTunnels({ quiet: true });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

sshProfileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#save-ssh-profile-button");
  const input = {
    name: document.querySelector("#ssh-profile-name").value,
    host: document.querySelector("#ssh-profile-host").value
  };
  button.disabled = true;
  try {
    if (editingSshProfileId) {
      await call("update_ssh_profile", { id: editingSshProfileId, input });
      showToast("SSH connection updated.");
    } else {
      await call("create_ssh_profile", { input });
      showToast("SSH connection saved.");
    }
    editingSshProfileId = null;
    sshProfileDialog.close();
    await refreshSshProfiles();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#save-project-button");
  const input = {
    name: document.querySelector("#project-name").value,
    cwd: document.querySelector("#project-cwd").value,
    defaultCommand: document.querySelector("#project-command").value,
    sshProfileId: document.querySelector("#project-ssh-profile").value || null
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
    const created = await call("create_window", { projectId: project.id, input: {
      name: document.querySelector("#window-name").value,
      cwd: document.querySelector("#window-cwd").value,
      command: windowKind === "agent" ? document.querySelector("#window-command").value : null,
      kind: windowKind
    }});
    selectedWindowId = created.id;
    windowDialog.close();
    await refreshProjects({ quiet: true });
    focusTerminalWindow(created.id);
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
  const project = projects.find((project) => project.id === id);
  selectedWindowId = project?.windows.find((window) => !poppedOutWindowIds.has(window.id))?.id
    || project?.windows[0]?.id
    || null;
  await render();
  await refreshGitStatus({ quiet: true });
  focusTerminalWindow(selectedWindowId);
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
  const action = event.target.closest("[data-context-action]")?.dataset.contextAction;
  if (!action || !contextProjectId) return;
  const id = contextProjectId;
  closeProjectContextMenu();
  if (action === "edit-project") openProjectSettings(id);
  if (action === "browse-repository") openRepository(id);
  if (action === "open-editor") openProjectInEditor(id);
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
  focusTerminalWindow(id);
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
  selectedWindowId = card.dataset.windowId;
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

grid.addEventListener("pointerover", (event) => {
  const card = event.target.closest(".terminal-card[data-window-id]");
  if (!card || card.contains(event.relatedTarget)) return;
  focusTerminalWindow(card.dataset.windowId);
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
  await refreshSshProfiles();
  await refreshSshTunnels({ quiet: true });
  await refreshProjects({ quiet: true });
  refreshRunningApps({ quiet: true });
  pollStatuses();
  scheduleGitStatusPoll();
  scheduleRunningAppsPoll();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    pollStatuses();
    refreshGitStatus({ quiet: true });
    refreshRunningApps({ quiet: true });
  }
});
document.addEventListener("keydown", (event) => {
  if (handleShortcutRecording(event)) return;
  if (!event.key.startsWith("Arrow") || event.defaultPrevented || document.querySelector("dialog[open]")) return;
  const editable = event.target instanceof Element
    ? event.target.closest("input, select, textarea, [contenteditable='true']")
    : null;
  if (editable && !editable.closest(".xterm")) return;
  const direction = event.key.slice(5).toLowerCase();
  if (matchesShortcutBinding(event, shortcutBindings.projectSwitch)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    switchProjectInDirection(direction);
  } else if (matchesShortcutBinding(event, shortcutBindings.windowFocus)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    focusWindowInDirection(direction);
  }
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open]")) return;
  if (!runningAppsView.hidden) closeRunningApps();
  else if (!sshTunnelsView.hidden) closeSshTunnels();
  else if (!repositoryBrowser.hidden) closeRepository();
  else if (workspace.classList.contains("activity-open")) closeActivityPanel();
  else return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
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
  clearTimeout(gitStatusTimer);
  clearTimeout(sshTunnelsTimer);
  clearTimeout(runningAppsTimer);
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
