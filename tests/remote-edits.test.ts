import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Connections } from "../electron/connections.js";
import { Store } from "../electron/store.js";
import { RemoteEdits } from "../electron/remote-edits.js";
import { startSshd } from "./sshd.js";

test(
  "backup names preserve long file names and cannot collide with the staged upload",
  { timeout: 90000 },
  async () => {
    const f = await setup();
    try {
      for (const name of ["a".repeat(251) + ".txt", "next", "next.tmp"]) {
        const remote = path.join(f.server.root, name);
        await fs.writeFile(remote, "Before\n");
        const session = await f.edits.open({ ...f.location, path: remote });
        await fs.writeFile(session.localPath, "After\n");
        await f.edits.action(session.id, "retry");
        const saved = f.edits.list().find((s) => s.id === session.id)!;
        assert.equal(saved.status, "clean", saved.error);
        assert.equal(
          await fs.readFile(
            path.join(saved.backupLocation!.path, name),
            "utf8",
          ),
          "Before\n",
        );
        assert.equal(await fs.readFile(remote, "utf8"), "After\n");
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "an interrupted acknowledgement recognizes an already published save without overwriting later edits",
  { timeout: 90000 },
  async () => {
    const f = await setup();
    let recovered: RemoteEdits | undefined;
    try {
      const session = await f.edits.open(f.location);
      await fs.writeFile(session.localPath, "Published before disconnect\n");
      const provider = f.connections.get(f.profile.id);
      const rename = provider.rename.bind(provider);
      provider.rename = async (from, to) => {
        await rename(from, to);
        if (to === session.location.path && path.basename(from) === "next") {
          f.connections.disconnect(f.profile.id);
          throw new Error("Injected lost acknowledgement");
        }
      };
      await f.edits.action(session.id, "retry");
      assert.equal(
        await fs.readFile(f.remotePath, "utf8"),
        "Published before disconnect\n",
      );
      await f.edits.dispose();
      recovered = new RemoteEdits(f.connections, f.directory, async () => {});
      await recovered.init();
      await f.connections.connect(f.profile, {});
      await recovered.action(session.id, "retry");
      assert.equal(recovered.list()[0].status, "clean");
      assert.equal(recovered.list()[0].backupCount, 1);
      assert.equal(
        await fs.readFile(
          path.join(recovered.list()[0].backupLocation!.path, "document.txt"),
          "utf8",
        ),
        "Original document\n",
      );
    } finally {
      await recovered?.dispose();
      await f.close();
    }
  },
);

test(
  "a writer racing either rename keeps its data and the editor's local copy",
  { timeout: 90000 },
  async () => {
    for (const phase of ["capture", "publish"]) {
      const f = await setup();
      try {
        const session = await f.edits.open(f.location);
        await fs.writeFile(session.localPath, "Local version\n");
        const provider = f.connections.get(f.profile.id);
        const rename = provider.rename.bind(provider);
        provider.rename = async (from, to) => {
          if (phase === "capture" && from === session.location.path)
            await fs.writeFile(f.remotePath, "Racing server version\n");
          if (phase === "publish" && path.basename(from) === "next")
            await fs.writeFile(f.remotePath, "Racing server version\n");
          await rename(from, to);
        };
        await f.edits.action(session.id, "retry");
        assert.equal(f.edits.list()[0].status, "conflict");
        assert.equal(
          await fs.readFile(f.remotePath, "utf8"),
          "Racing server version\n",
        );
        assert.equal(
          await fs.readFile(session.localPath, "utf8"),
          "Local version\n",
        );
        if (phase === "publish")
          assert.equal(
            await fs.readFile(
              path.join(f.edits.list()[0].backupLocation!.path, "document.txt"),
              "utf8",
            ),
            "Original document\n",
          );
      } finally {
        await f.close();
      }
    }
  },
);

async function setup() {
  const server = await startSshd();
  const store = new Store(path.join(server.root, "settings.json"));
  const connections = new Connections(store, async () => true, server.root);
  const profile = {
    id: randomUUID(),
    name: "Edit server",
    host: "127.0.0.1",
    port: server.port,
    username: server.username,
    auth: "key" as const,
    keyPath: server.key,
    initialPath: server.root,
  };
  await connections.connect(profile, {});
  const remotePath = path.join(server.root, "document.txt");
  await fs.writeFile(remotePath, "Original document\n");
  const directory = path.join(server.root, "cache");
  const launched: string[] = [];
  const edits = new RemoteEdits(connections, directory, async (p) => {
    launched.push(p);
  });
  await edits.init();
  const location = { connectionId: profile.id, path: remotePath };
  return {
    server,
    connections,
    profile,
    remotePath,
    directory,
    launched,
    edits,
    location,
    close: async () => {
      await edits.dispose();
      connections.close();
      await server.close();
    },
  };
}

test(
  "remote edit uploads exact bytes, retains original, detects content conflicts and accepts a reviewed merge",
  { timeout: 90000 },
  async () => {
    const f = await setup();
    try {
      const session = await f.edits.open(f.location);
      assert.deepEqual(f.launched, [session.localPath]);
      assert.equal(
        await fs.readFile(session.localPath, "utf8"),
        "Original document\n",
      );
      const replacement = session.localPath + ".new";
      await fs.writeFile(replacement, "First saved edit\n");
      await fs.rename(replacement, session.localPath);
      await f.edits.action(session.id, "retry");
      assert.equal(f.edits.list()[0].status, "clean");
      assert.equal(
        await fs.readFile(f.remotePath, "utf8"),
        "First saved edit\n",
      );
      const backup = f.edits.list()[0].backupLocation!;
      assert.equal(
        await fs.readFile(path.join(backup.path, "document.txt"), "utf8"),
        "Original document\n",
      );
      const prior = await fs.stat(f.remotePath);
      // Same length and timestamp: metadata-only comparisons would miss this change.
      await fs.writeFile(f.remotePath, "Other saved edit\n");
      await fs.utimes(f.remotePath, prior.atime, prior.mtime);
      await fs.writeFile(session.localPath, "My newer edit\n");
      await f.edits.action(session.id, "retry");
      assert.equal(f.edits.list()[0].status, "conflict");
      assert.equal(
        await fs.readFile(f.remotePath, "utf8"),
        "Other saved edit\n",
      );
      await f.edits.action(session.id, "server-copy");
      assert.equal(
        await fs.readFile(f.launched.at(-1)!, "utf8"),
        "Other saved edit\n",
      );
      assert.notEqual(f.launched.at(-1), session.localPath);
      await fs.writeFile(session.localPath, "Merged document\n");
      await f.edits.action(session.id, "apply-local");
      assert.equal(f.edits.list()[0].status, "clean");
      assert.equal(
        await fs.readFile(f.remotePath, "utf8"),
        "Merged document\n",
      );
      assert.equal(
        await fs.readFile(
          path.join(f.edits.list()[0].backupLocation!.path, "document.txt"),
          "utf8",
        ),
        "Other saved edit\n",
      );
      await f.edits.action(session.id, "pause");
      await fs.writeFile(session.localPath, "Paused changes\n");
      await f.edits.poll(true);
      assert.equal(
        await fs.readFile(f.remotePath, "utf8"),
        "Merged document\n",
      );
      assert.equal(f.edits.list()[0].status, "paused");
    } finally {
      await f.close();
    }
  },
);

test(
  "external editor atomic saves synchronize automatically and offline edits survive a manager restart",
  { timeout: 90000 },
  async () => {
    const f = await setup();
    let recovered: RemoteEdits | undefined;
    try {
      const session = await f.edits.open(f.location);
      const replacement = session.localPath + ".new";
      await fs.writeFile(replacement, "Automatic save\n");
      await fs.rename(replacement, session.localPath);
      const deadline = Date.now() + 10000;
      while (
        (await fs.readFile(f.remotePath, "utf8")) !== "Automatic save\n" &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await fs.readFile(f.remotePath, "utf8"), "Automatic save\n");
      f.connections.disconnect(f.profile.id);
      await fs.writeFile(session.localPath, "Saved while offline\n");
      await f.edits.action(session.id, "retry");
      assert.equal(f.edits.list()[0].status, "offline");
      await f.edits.dispose();
      recovered = new RemoteEdits(f.connections, f.directory, async () => {});
      await recovered.init();
      assert.equal(recovered.list()[0].localPath, session.localPath);
      await f.connections.connect(f.profile, {});
      await recovered.action(session.id, "retry");
      assert.equal(
        await fs.readFile(f.remotePath, "utf8"),
        "Saved while offline\n",
      );
      assert.equal(recovered.list()[0].status, "clean");
    } finally {
      await recovered?.dispose();
      await f.close();
    }
  },
);

test(
  "interrupted promotion restores the original after reconnect and preserves the local edit",
  { timeout: 90000 },
  async () => {
    const f = await setup();
    let recovered: RemoteEdits | undefined;
    try {
      const session = await f.edits.open(f.location);
      await fs.writeFile(session.localPath, "Recovery edit\n");
      const provider = f.connections.get(f.profile.id);
      const rename = provider.rename.bind(provider);
      provider.rename = async (from, to) => {
        if (to === session.location.path && path.basename(from) === "next") {
          f.connections.disconnect(f.profile.id);
          throw new Error("Injected connection loss after original capture");
        }
        await rename(from, to);
      };
      await f.edits.action(session.id, "retry");
      assert.equal(f.edits.list()[0].status, "offline");
      await assert.rejects(fs.stat(f.remotePath), { code: "ENOENT" });
      await f.edits.dispose();
      recovered = new RemoteEdits(f.connections, f.directory, async () => {});
      await recovered.init();
      await f.connections.connect(f.profile, {});
      // The reconnect event automatically replays the persisted journal.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          await fs.stat(f.remotePath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.equal(
        await fs.readFile(f.remotePath, "utf8"),
        "Original document\n",
      );
      assert.equal(
        await fs.readFile(session.localPath, "utf8"),
        "Recovery edit\n",
      );
      await recovered.action(session.id, "apply-local");
      assert.equal(await fs.readFile(f.remotePath, "utf8"), "Recovery edit\n");
    } finally {
      await recovered?.dispose();
      await f.close();
    }
  },
);

test(
  "reconnect restores a captured server original even when the editor cache is missing",
  { timeout: 90000 },
  async () => {
    for (const recreatedTarget of [false, true]) {
      const f = await setup();
      let recovered: RemoteEdits | undefined;
      try {
        const session = await f.edits.open(f.location);
        await fs.writeFile(session.localPath, "Unfinished local save\n");
        const provider = f.connections.get(f.profile.id);
        const rename = provider.rename.bind(provider);
        provider.rename = async (from, to) => {
          if (to === session.location.path && path.basename(from) === "next") {
            f.connections.disconnect(f.profile.id);
            throw new Error("Injected disconnect before promotion");
          }
          await rename(from, to);
        };
        await f.edits.action(session.id, "retry");
        await assert.rejects(fs.stat(f.remotePath), { code: "ENOENT" });
        await f.edits.dispose();
        if (recreatedTarget)
          await fs.writeFile(f.remotePath, "Concurrent server save\n");
        // A crashed editor may leave its cache unlinked; the server journal is independent.
        await fs.unlink(session.localPath);
        recovered = new RemoteEdits(f.connections, f.directory, async () => {});
        await recovered.init();
        await f.connections.connect(f.profile, {});
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          // Conflict is assigned before cache restoration finishes; wait for
          // the completed recovery journal, as the change event does.
          const records = JSON.parse(
            await fs.readFile(path.join(f.directory, "sessions.json"), "utf8"),
          );
          if (!records[0].transaction) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(
          await fs.readFile(f.remotePath, "utf8"),
          recreatedTarget ? "Concurrent server save\n" : "Original document\n",
        );
        assert.equal(
          await fs.readFile(session.localPath, "utf8"),
          "Unfinished local save\n",
        );
        assert.equal(recovered.list()[0].status, "conflict");
        const records = JSON.parse(
          await fs.readFile(path.join(f.directory, "sessions.json"), "utf8"),
        );
        assert.equal(records[0].transaction, undefined);
      } finally {
        await recovered?.dispose();
        await f.close();
      }
    }
  },
);

test(
  "a reused profile ID cannot send edits to a different SSH endpoint",
  { timeout: 90000 },
  async () => {
    const f = await setup();
    const other = await startSshd();
    try {
      const session = await f.edits.open(f.location);
      await fs.writeFile(session.localPath, "Must stay local\n");
      await f.connections.connect(
        { ...f.profile, port: other.port, keyPath: other.key },
        {},
      );
      await f.edits.action(session.id, "retry");
      assert.equal(f.edits.list()[0].status, "conflict");
      assert.match(f.edits.list()[0].error!, /서버 또는 계정/);
      assert.equal(
        await fs.readFile(f.remotePath, "utf8"),
        "Original document\n",
      );
    } finally {
      await f.close();
      await other.close();
    }
  },
);
