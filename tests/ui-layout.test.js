import test from "node:test";
import assert from "node:assert/strict";

await import("../public/ui-layout.js");

const {
  clampSidebarWidth,
  clampProjectHeight,
  projectHeightFromShare,
  projectShareFromHeight,
} = globalThis.UiLayout;

test("sidebar width stays within usable desktop bounds", () => {
  assert.equal(clampSidebarWidth(null), 260);
  assert.equal(clampSidebarWidth(Number.NaN), 260);
  assert.equal(clampSidebarWidth(120), 210);
  assert.equal(clampSidebarWidth(600), 420);
  assert.equal(clampSidebarWidth("315.4"), 315);
  assert.equal(clampSidebarWidth(315.4), 315);
});

test("project section height preserves room for both lists", () => {
  assert.equal(clampProjectHeight(null, 700), 434);
  assert.equal(clampProjectHeight(Number.NaN, 700), 434);
  assert.equal(clampProjectHeight(20, 700), 110);
  assert.equal(clampProjectHeight(680, 700), 580);
  assert.equal(clampProjectHeight(325.7, 700), 326);
  assert.equal(clampProjectHeight("325.7", 700), 326);
});

test("project section share survives viewport height changes", () => {
  const share = projectShareFromHeight(434, 700);
  assert.equal(share, 0.62);
  assert.equal(projectHeightFromShare(share, 900), 558);
  assert.equal(projectHeightFromShare(share, 700), 434);
  assert.equal(projectHeightFromShare(null, 700), 434);
});
