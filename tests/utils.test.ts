import { test } from "node:test";
import assert from "node:assert/strict";
import { parent, pathParts, shortcut } from "../src/utils";

test("path decomposition preserves POSIX, drive, and UNC breadcrumb roots", () => {
  for (const [input, root, pieces] of [
    ["/", "/", []],
    ["/Users/test-user/Projects/", "/", ["Users", "test-user", "Projects"]],
    ["C:\\", "C:\\", []],
    ["C:\\Work\\Reports\\", "C:\\", ["Work", "Reports"]],
    ["D:/", "D:/", []],
    ["D:/Work/Reports", "D:/", ["Work", "Reports"]],
    ["\\\\server\\share", "\\\\server\\share", []],
    ["\\\\server\\share\\", "\\\\server\\share\\", []],
    [
      "\\\\server\\share\\Work\\Reports",
      "\\\\server\\share\\",
      ["Work", "Reports"],
    ],
    ["//server/share/Work/Reports", "//server/share/", ["Work", "Reports"]],
  ] as const) {
    assert.deepEqual(pathParts(input), { root, pieces }, input);
  }
});

test("every reconstructed UNC breadcrumb stays within the share", () => {
  const { root, pieces } = pathParts(
    "\\\\server\\share\\Projects\\Design\\Exports",
  );
  const targets = pieces.map(
    (_, index) =>
      root + pieces.slice(0, index + 1).join(root.includes("\\") ? "\\" : "/"),
  );
  assert.deepEqual(targets, [
    "\\\\server\\share\\Projects",
    "\\\\server\\share\\Projects\\Design",
    "\\\\server\\share\\Projects\\Design\\Exports",
  ]);
  assert.equal(parent(targets[0]), root);
});

test("parent navigation preserves POSIX, Windows drive, and UNC share roots", () => {
  for (const [input, expected] of [
    ["/", "/"],
    ["/file", "/"],
    ["/projects/folder/", "/projects"],
    ["C:\\", "C:\\"],
    ["C:\\folder", "C:\\"],
    ["C:\\folder\\child\\", "C:\\folder"],
    ["D:/", "D:/"],
    ["D:/folder", "D:/"],
    ["D:/folder/child", "D:/folder"],
    ["\\\\server\\share", "\\\\server\\share"],
    ["\\\\server\\share\\", "\\\\server\\share\\"],
    ["\\\\server\\share\\folder", "\\\\server\\share\\"],
    ["relative/folder", "relative"],
  ])
    assert.equal(parent(input), expected, input);
});

test("shortcut labels follow the host platform and preserve ordinary keys", () => {
  assert.equal(shortcut("darwin", "⌘⇧N"), "⌘⇧N");
  assert.equal(shortcut("win32", "⌘⇧N"), "Ctrl+Shift+N");
  assert.equal(shortcut("linux", "⌘ ⇧ N"), "Ctrl+Shift+N");
  assert.equal(shortcut("win32", "⌘ ⌫ / Delete"), "Ctrl+Backspace / Delete");
  assert.equal(shortcut("linux", "F2"), "F2");
});
