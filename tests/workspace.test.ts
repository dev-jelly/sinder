import { test } from "node:test";
import assert from "node:assert/strict";
import type { Connection, Location } from "../shared/types";
import {
  navigatePane,
  reconnectPane,
  updatePane,
  type PaneState,
  type Tab,
} from "../src/workspace";

const location = (path: string, connectionId = "local"): Location => ({
  connectionId,
  path,
});
const remote: Connection = {
  id: "server",
  name: "Server",
  kind: "ssh",
  status: "connected",
  home: "/home/user",
};

function pane(id = "left"): PaneState {
  const history = [
    location("/"),
    location("/projects"),
    location("/projects/old"),
  ];
  return { id, location: history[1], history, cursor: 1 };
}

test("navigation after going back replaces the forward branch without mutating history", () => {
  const previous = pane();
  const destination = location("/projects/new");
  const next = navigatePane(previous, destination);
  assert.deepEqual(next.history, [
    location("/"),
    location("/projects"),
    destination,
  ]);
  assert.equal(next.cursor, 2);
  assert.equal(next.location, destination);
  assert.deepEqual(previous.history.at(-1), location("/projects/old"));
  assert.equal(previous.cursor, 1);
});

test("revisiting the current location preserves the forward branch", () => {
  const previous = pane();
  assert.equal(navigatePane(previous, { ...previous.location }), previous);
  assert.notEqual(
    navigatePane(previous, location("/projects", "server")),
    previous,
  );
});

test("reconnecting an existing remote pane preserves its path and back/forward history", () => {
  const previous = pane();
  previous.location = location("/work/current", remote.id);
  previous.history[previous.cursor] = previous.location;
  assert.equal(reconnectPane(previous, remote), previous);
  assert.equal(
    reconnectPane(previous, remote, { ...previous.location }),
    previous,
  );
  const destination = location("/bookmarked", remote.id);
  assert.deepEqual(reconnectPane(previous, remote, destination).history, [
    location("/"),
    previous.location,
    destination,
  ]);
});

test("connecting another server navigates to its home and ignores unrelated pending locations", () => {
  const previous = pane();
  assert.deepEqual(
    reconnectPane(previous, remote).location,
    location(remote.home, remote.id),
  );
  assert.deepEqual(
    reconnectPane(previous, remote, location("/other", "different-server"))
      .location,
    location(remote.home, remote.id),
  );
});

test("pane updates affect only the requested pane and preserve its sibling and other tabs", () => {
  const left = pane();
  const right = pane("right");
  const other = { id: "other", panes: [pane("third")], active: "third" };
  const tabs: Tab[] = [
    { id: "first", panes: [left, right], active: left.id },
    other,
  ];
  const next = updatePane(tabs, "first", "right", (pane) =>
    navigatePane(pane, location("/target")),
  );
  assert.equal(next[0].panes[0], left);
  assert.equal(next[1], other);
  assert.equal(next[0].active, left.id);
  assert.deepEqual(next[0].panes[1].location, location("/target"));
  assert.equal(tabs[0].panes[1], right);
});
