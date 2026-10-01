import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listLocation } from "../electron/list-location";
import { LocalProvider } from "../electron/providers";
import { Connections } from "../electron/connections";
import { Store } from "../electron/store";
import { startSshd } from "./sshd";

test("a file path lists just that file in its parent folder", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-file-path-"));
  try {
    const file = path.join(folder, ".notes");
    await fs.writeFile(file, "notes");
    await fs.writeFile(path.join(folder, "another.txt"), "another");
    const result = await listLocation(new LocalProvider(folder), file);
    const canonical = await fs.realpath(file);
    assert.equal(result.path, path.dirname(canonical));
    assert.equal(result.target, canonical);
    assert.deepEqual(result.entries.map((entry) => entry.path), [canonical]);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test("a folder path still lists its contents", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-folder-path-"));
  try {
    await fs.writeFile(path.join(folder, "file"), "contents");
    const result = await listLocation(new LocalProvider(folder), folder);
    assert.equal(result.path, await fs.realpath(folder));
    assert.equal(result.target, undefined);
    assert.deepEqual(result.entries.map((entry) => entry.name), ["file"]);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test("a symlink to a file is identified as a file target", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-link-path-"));
  try {
    const file = path.join(folder, "document");
    const link = path.join(folder, "shortcut");
    await fs.writeFile(file, "contents");
    await fs.symlink(file, link);
    const result = await listLocation(new LocalProvider(folder), link);
    assert.equal(result.target, await fs.realpath(file));
    assert.deepEqual(result.entries.map((entry) => entry.kind), ["file"]);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test("SSH file paths and symlinks select the actual file without changing folder listings", async () => {
  const server = await startSshd();
  const connections = new Connections(
    new Store(path.join(server.root, "settings.json")),
    async () => true,
  );
  try {
    const folder = path.join(server.root, "files");
    await fs.mkdir(folder);
    const file = path.join(folder, ".notes");
    const link = path.join(folder, "shortcut");
    await fs.writeFile(file, "remote notes");
    await fs.symlink(file, link);
    await connections.connect({
      id: "file-path-test", name: "Temporary SSH", host: "127.0.0.1",
      port: server.port, username: server.username, auth: "key",
      keyPath: server.key, initialPath: server.root,
    }, {});
    const provider = connections.get("file-path-test");
    for (const requested of [file, link]) {
      const result = await listLocation(provider, requested);
      assert.equal(result.path, await fs.realpath(folder));
      assert.equal(result.target, await fs.realpath(file));
      assert.equal(result.entries.length, 1);
      assert.equal(result.entries[0].kind, "file");
      assert.equal(result.entries[0].hidden, true);
    }
    const listing = await listLocation(provider, folder);
    assert.equal(listing.target, undefined);
    assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), [".notes", "shortcut"]);
    await assert.rejects(listLocation(provider, path.join(folder, "missing")));
  } finally {
    connections.close();
    await server.close();
  }
});
