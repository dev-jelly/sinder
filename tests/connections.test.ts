import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate, setTimeout } from "node:timers/promises";
import { Client } from "ssh2";
import { Connections } from "../electron/connections.js";
import { Store } from "../electron/store.js";
import { startSshd } from "./sshd.js";
import type { Profile } from "../shared/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function promptlyCancelled(pending: Promise<unknown>) {
  await Promise.race([
    assert.rejects(pending, /취소/),
    setTimeout(1000, undefined, { ref: false }).then(() => {
      throw new Error("Cancellation did not settle promptly");
    }),
  ]);
}

test("cancelling during an unfinished key read never starts SSH or saves a profile", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-connect-"));
  const store = new Store(path.join(directory, "settings.json"));
  const connections = new Connections(store, async () => true, directory);
  const keyRead = deferred<Buffer>();
  const originalRead = fs.readFile;
  const profile: Profile = {
    id: randomUUID(),
    name: "Cancelled",
    host: "127.0.0.1",
    port: 22,
    username: "test",
    auth: "key",
    keyPath: path.join(directory, "key"),
    initialPath: "~",
  };
  const connect = context.mock.method(Client.prototype, "connect", () => {
    throw new Error("A cancelled attempt must never start SSH");
  });
  try {
    context.mock.method(
      fs,
      "readFile",
      (...args: Parameters<typeof fs.readFile>) =>
        args[0] === profile.keyPath ? keyRead.promise : originalRead(...args),
    );
    const pending = connections.connect(profile, {});
    assert.equal(connections.cancel(profile.id), "cancelled");
    await promptlyCancelled(pending);
    assert.deepEqual(store.data.profiles, []);
    keyRead.resolve(Buffer.from("ignored after cancellation"));
    await setImmediate();
    assert.equal(connect.mock.callCount(), 0);
    assert.deepEqual(
      connections.list().map((connection) => connection.id),
      ["local"],
    );
    await assert.rejects(fs.stat(path.join(directory, "settings.json")), {
      code: "ENOENT",
    });
  } finally {
    keyRead.resolve(Buffer.alloc(0));
    context.mock.restoreAll();
    connections.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test(
  "cancelling an in-flight SSH replacement preserves the live session and allows immediate retry",
  { timeout: 90000 },
  async () => {
    const first = await startSshd();
    const second = await startSshd();
    const store = new Store(path.join(first.root, "settings.json"));
    const prompted = deferred<void>();
    const approval = deferred<boolean>();
    const connections = new Connections(store, async (profile) => {
      if (profile.port !== second.port) return true;
      prompted.resolve();
      return approval.promise;
    });
    const profile: Profile = {
      id: randomUUID(),
      name: "Original",
      host: "127.0.0.1",
      port: first.port,
      username: first.username,
      auth: "key",
      keyPath: first.key,
      initialPath: first.root,
    };
    try {
      await connections.connect(profile, {});
      const originalProvider = connections.get(profile.id);
      const originalIdentity = connections.identity(profile.id);
      const pending = connections.connect(
        {
          ...profile,
          name: "Cancelled replacement",
          port: second.port,
          keyPath: second.key,
          initialPath: second.root,
        },
        {},
      );
      await prompted.promise;
      assert.equal(connections.cancel(profile.id), "cancelled");
      // A retry may begin before the cancelled attempt's finally block has run.
      const retry = connections.connect(profile, {});
      await promptlyCancelled(pending);
      assert.equal(connections.get(profile.id), originalProvider);
      assert.equal(connections.identity(profile.id), originalIdentity);
      assert.deepEqual(store.data.profiles, [profile]);
      assert.equal(store.data.hosts[`127.0.0.1:${second.port}`], undefined);
      await retry;
      approval.resolve(true);
      await setImmediate();
      await setImmediate();
      assert.equal(connections.identity(profile.id), originalIdentity);
      assert.deepEqual(store.data.profiles, [profile]);
      assert.equal(store.data.hosts[`127.0.0.1:${second.port}`], undefined);
      assert.equal(connections.cancel(profile.id), "committed");
      assert.equal(
        (await connections.get(profile.id).stat(first.root)).kind,
        "directory",
      );
    } finally {
      approval.resolve(false);
      connections.close();
      await first.close();
      await second.close();
    }
  },
);

test(
  "cancellation reports a committed connection while its settings save finishes",
  { timeout: 90000 },
  async () => {
    const server = await startSshd();
    const store = new Store(path.join(server.root, "settings.json"));
    const saving = deferred<void>();
    const finishSave = deferred<void>();
    const save = store.save.bind(store);
    store.save = async () => {
      saving.resolve();
      await finishSave.promise;
      return save();
    };
    const connections = new Connections(store, async () => true);
    const profile: Profile = {
      id: randomUUID(),
      name: "Committed",
      host: "127.0.0.1",
      port: server.port,
      username: server.username,
      auth: "key",
      keyPath: server.key,
      initialPath: server.root,
    };
    let settled = false;
    try {
      const pending = connections.connect(profile, {}).finally(() => {
        settled = true;
      });
      await saving.promise;
      assert.equal(connections.cancel(profile.id), "committed");
      assert.equal(
        settled,
        false,
        "connect still waits for required persistence",
      );
      assert.equal(
        (await connections.get(profile.id).stat(server.root)).kind,
        "directory",
      );
      await assert.rejects(connections.connect(profile, {}), /이미 연결 중/);
      finishSave.resolve();
      assert.equal((await pending).id, profile.id);
      assert.equal(connections.cancel(profile.id), "committed");
      assert.equal(
        (await connections.get(profile.id).stat(server.root)).kind,
        "directory",
      );
      assert.deepEqual(
        JSON.parse(
          await fs.readFile(path.join(server.root, "settings.json"), "utf8"),
        ).profiles,
        [profile],
      );
    } finally {
      finishSave.resolve();
      connections.close();
      await server.close();
    }
  },
);
