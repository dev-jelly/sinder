import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/store.js";

test("queued settings saves publish their captured snapshots in order", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-store-"));
  const filename = path.join(directory, "settings.json");
  const store = new Store(filename);
  const originalRename = fs.rename;
  const published: string[] = [];
  try {
    context.mock.method(fs, "rename", async (from: string, to: string) => {
      published.push(JSON.parse(await fs.readFile(from, "utf8")).editorPath);
      await originalRename(from, to);
    });
    store.data.editorPath = "first";
    const first = store.save();
    store.data.editorPath = "second";
    const second = store.save();
    store.data.editorPath = "not saved";
    await Promise.all([first, second]);
    assert.deepEqual(published, ["first", "second"]);
    const restored = new Store(filename);
    await restored.load();
    assert.equal(restored.data.editorPath, "second");
    assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
  } finally {
    context.mock.restoreAll();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a failed settings save does not block the next queued snapshot", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-store-"));
  const filename = path.join(directory, "settings.json");
  const store = new Store(filename);
  const originalRename = fs.rename;
  let fail = true;
  try {
    context.mock.method(fs, "rename", async (from: string, to: string) => {
      if (fail) {
        fail = false;
        throw Object.assign(new Error("Injected save failure"), {
          code: "EIO",
        });
      }
      await originalRename(from, to);
    });
    store.data.editorPath = "failed";
    const failed = assert.rejects(store.save(), { code: "EIO" });
    store.data.editorPath = "saved";
    const saved = store.save();
    await Promise.all([failed, saved]);
    assert.equal(
      JSON.parse(await fs.readFile(filename, "utf8")).editorPath,
      "saved",
    );
    assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
  } finally {
    context.mock.restoreAll();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
