import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Connections } from "../electron/connections.js";
import { Store } from "../electron/store.js";
import { Transfers } from "../electron/transfers.js";
import { ExternalFiles } from "../electron/external-files.js";
import { startSshd } from "./sshd.js";

test(
  "external handoff copies remote trees, preserves duplicate names and rejects remote links",
  { timeout: 90000 },
  async () => {
    const server = await startSshd();
    const connections = new Connections(
      new Store(path.join(server.root, "settings.json")),
      async () => true,
      server.root,
    );
    const transfers = new Transfers(connections);
    const directory = path.join(server.root, "exports");
    const external = new ExternalFiles(connections, transfers, directory);
    const profile = {
      id: randomUUID(),
      name: "Export fixture",
      host: "127.0.0.1",
      port: server.port,
      username: server.username,
      auth: "key" as const,
      keyPath: server.key,
      initialPath: server.root,
    };
    try {
      await connections.connect(profile, {});
      for (const folder of ["one", "two"]) {
        await fs.mkdir(path.join(server.root, folder));
        await fs.writeFile(
          path.join(server.root, folder, "same.bin"),
          Buffer.from([0, 1, 2, folder.length]),
        );
      }
      const source = ["one", "two"].map((folder) => ({
        connectionId: profile.id,
        path: path.join(server.root, folder, "same.bin"),
      }));
      const files = await external.prepare(source);
      assert.equal(files.length, 2);
      assert.notEqual(files[0], files[1]);
      for (let i = 0; i < files.length; i++) {
        assert.equal(path.basename(files[i]), "same.bin");
        assert.deepEqual(
          await fs.readFile(files[i]),
          await fs.readFile(source[i].path),
        );
      }
      const [folder] = await external.prepare([
        { connectionId: profile.id, path: path.join(server.root, "one") },
      ]);
      assert.deepEqual(
        await fs.readFile(path.join(folder, "same.bin")),
        await fs.readFile(source[0].path),
      );
      assert.deepEqual(
        await external.prepare([
          { connectionId: "local", path: source[0].path },
        ]),
        [source[0].path],
      );
      await fs.symlink(source[0].path, path.join(server.root, "two", "link"));
      const before = (await fs.readdir(directory)).sort();
      await assert.rejects(
        external.prepare([
          { connectionId: profile.id, path: path.join(server.root, "two") },
        ]),
        /링크/,
      );
      assert.deepEqual(
        (await fs.readdir(directory)).sort(),
        before,
        "failed export cleans only its own batch",
      );
      assert.equal(
        await fs.readlink(path.join(server.root, "two", "link")),
        source[0].path,
      );
    } finally {
      await transfers.idle();
      connections.close();
      await server.close();
    }
  },
);
