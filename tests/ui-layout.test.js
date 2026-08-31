import test from "node:test";
import assert from "node:assert/strict";

await import("../public/ui-layout.js");

const {
  clampSidebarWidth,
  clampProjectHeight,
  projectHeightFromShare,
  projectShareFromHeight,
  directionalNeighbor,
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

test("directional window navigation follows tile geometry", () => {
  const tiles = [
    { id: "top-left", left: 0, top: 0, width: 100, height: 100 },
    { id: "top-right", left: 110, top: 0, width: 100, height: 100 },
    { id: "bottom-left", left: 0, top: 110, width: 100, height: 100 },
    { id: "bottom-right", left: 110, top: 110, width: 100, height: 100 },
  ];
  assert.equal(directionalNeighbor(tiles, "top-left", "right"), "top-right");
  assert.equal(directionalNeighbor(tiles, "top-left", "down"), "bottom-left");
  assert.equal(directionalNeighbor(tiles, "bottom-right", "left"), "bottom-left");
  assert.equal(directionalNeighbor(tiles, "bottom-right", "up"), "top-right");
  assert.equal(directionalNeighbor(tiles, "top-left", "left"), null);
  assert.equal(directionalNeighbor(tiles, "missing", "right"), null);
});
