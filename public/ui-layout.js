(function exposeUiLayout(global) {
  "use strict";

  const DEFAULT_SIDEBAR_WIDTH = 260;
  const MIN_SIDEBAR_WIDTH = 210;
  const MAX_SIDEBAR_WIDTH = 420;
  const DEFAULT_PROJECT_SHARE = 0.62;
  const MIN_PROJECT_HEIGHT = 110;
  const MIN_WINDOWS_HEIGHT = 120;

  function finiteNumber(value, fallback) {
    if (value === null || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clampSidebarWidth(value) {
    const width = finiteNumber(value, DEFAULT_SIDEBAR_WIDTH);
    return Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width)));
  }

  function clampProjectHeight(value, availableHeight) {
    const available = Math.max(MIN_PROJECT_HEIGHT + MIN_WINDOWS_HEIGHT, finiteNumber(availableHeight, 700));
    const height = finiteNumber(value, available * DEFAULT_PROJECT_SHARE);
    return Math.round(Math.min(available - MIN_WINDOWS_HEIGHT, Math.max(MIN_PROJECT_HEIGHT, height)));
  }

  function projectShareFromHeight(height, availableHeight) {
    const available = Math.max(MIN_PROJECT_HEIGHT + MIN_WINDOWS_HEIGHT, finiteNumber(availableHeight, 700));
    return clampProjectHeight(height, available) / available;
  }

  function projectHeightFromShare(share, availableHeight) {
    const available = Math.max(MIN_PROJECT_HEIGHT + MIN_WINDOWS_HEIGHT, finiteNumber(availableHeight, 700));
    return clampProjectHeight(available * finiteNumber(share, DEFAULT_PROJECT_SHARE), available);
  }

  global.UiLayout = Object.freeze({
    DEFAULT_SIDEBAR_WIDTH,
    DEFAULT_PROJECT_SHARE,
    clampSidebarWidth,
    clampProjectHeight,
    projectHeightFromShare,
    projectShareFromHeight,
  });
})(globalThis);
