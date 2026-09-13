import assert from "node:assert/strict";
import test from "node:test";
import { emptySelection, pruneSelection, selectItem } from "../src/selection";

const files = ["a", "b", "c", "d", "e"];

test("a range extends, contracts, and crosses its anchor", () => {
  let selection = selectItem(emptySelection(), files, "c");
  selection = selectItem(selection, files, "e", "extend");
  assert.deepEqual(selection.paths, ["c", "d", "e"]);
  selection = selectItem(selection, files, "d", "extend");
  assert.deepEqual(selection.paths, ["c", "d"]);
  selection = selectItem(selection, files, "b", "extend");
  assert.deepEqual(selection, { paths: ["b", "c"], anchor: "c", cursor: "b" });
  selection = selectItem(selection, files, "c", "extend");
  assert.deepEqual(selection.paths, ["c"]);
});

test("pointer toggle and keyboard ranges share the same anchor", () => {
  let selection = selectItem(emptySelection(), files, "a");
  selection = selectItem(selection, files, "c", "toggle");
  assert.deepEqual(selection.paths, ["a", "c"]);
  selection = selectItem(selection, files, "e", "extend");
  assert.deepEqual(selection.paths, ["c", "d", "e"]);
  selection = selectItem(selection, files, "e", "toggle");
  assert.deepEqual(selection.paths, ["c", "d"]);
  assert.equal(selection.cursor, "e");
});

test("filtering removes invisible paths and repairs the range anchor", () => {
  const selection = selectItem(
    selectItem(emptySelection(), files, "b"),
    files,
    "e",
    "extend",
  );
  const pruned = pruneSelection(selection, ["a", "d"]);
  assert.deepEqual(pruned, { paths: ["d"], anchor: "d", cursor: "d" });
  assert.deepEqual(selectItem(pruned, ["a", "d"], "a", "extend").paths, [
    "a",
    "d",
  ]);
  assert.deepEqual(pruneSelection(pruned, []), emptySelection());
  assert.equal(pruneSelection(selection, files), selection);
});

test("a fresh or stale selection never sweeps an unintended range", () => {
  assert.deepEqual(selectItem(emptySelection(), files, "d", "extend").paths, [
    "d",
  ]);
  const stale = { paths: ["missing"], anchor: "missing", cursor: "missing" };
  assert.deepEqual(selectItem(stale, files, "d", "extend").paths, ["d"]);
});
