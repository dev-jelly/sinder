import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { SFTPWrapper } from "ssh2";
import { Store } from "../electron/store.js";
import { Connections } from "../electron/connections.js";
import { Transfers } from "../electron/transfers.js";
import { SftpProvider, validName } from "../electron/providers.js";
import { startSshd } from "./sshd.js";

test(
  "remote-to-remote copy across two independent OpenSSH connections",
  { timeout: 90000 },
  async () => {
    const first = await startSshd();
    const second = await startSshd();
    const connections = new Connections(
      new Store(path.join(first.root, "settings.json")),
      async () => true,
    );
    try {
      const sourcePath = path.join(first.root, "source.bin");
      const destPath = path.join(second.root, "destination");
      const content = Buffer.alloc(512 * 1024 + 71, "두 서버 사이 실제 전송");
      await fs.writeFile(sourcePath, content);
      await fs.mkdir(destPath);
      const profiles = [first, second].map((server, i) => ({
        id: randomUUID(),
        name: `Server ${i + 1}`,
        host: "127.0.0.1",
        port: server.port,
        username: server.username,
        auth: "key" as const,
        keyPath: server.key,
        initialPath: server.root,
      }));
      await connections.connect(profiles[0], {});
      await connections.connect(profiles[1], {});
      const transfers = new Transfers(connections);
      const id = transfers.start({
        source: [{ connectionId: profiles[0].id, path: sourcePath }],
        destination: { connectionId: profiles[1].id, path: destPath },
        move: false,
        conflict: "error",
      });
      await transfers.idle();
      assert.equal(
        transfers.jobs.find((j) => j.id === id)?.status,
        "done",
        transfers.jobs.find((j) => j.id === id)?.error,
      );
      assert.deepEqual(
        await fs.readFile(path.join(destPath, "source.bin")),
        content,
      );
      assert.deepEqual(await fs.readFile(sourcePath), content);
    } finally {
      connections.close();
      await first.close();
      await second.close();
    }
  },
);

test("untrusted SFTP directory names cannot escape the requested directory", async () => {
  for (const name of [
    "../../outside",
    "/absolute",
    "..\\outside",
    "bad\0name",
  ]) {
    const channel = Object.assign(new EventEmitter(), {
      readdir: (_path: string, callback: Function) =>
        callback(null, [{ filename: name, attrs: {} }]),
    });
    const provider = new SftpProvider("/", channel as unknown as SFTPWrapper);
    await assert.rejects(provider.list("/safe"), /파일 이름/);
  }
});

test(
  "two profiles for the same verified SSH endpoint protect source descendants before copying",
  { timeout: 90000 },
  async () => {
    const server = await startSshd();
    const connections = new Connections(
      new Store(path.join(server.root, "settings.json")),
      async () => true,
    );
    try {
      const profiles = ["Primary", "Alias"].map((name) => ({
        id: randomUUID(),
        name,
        host: "127.0.0.1",
        port: server.port,
        username: server.username,
        auth: "key" as const,
        keyPath: server.key,
        initialPath: server.root,
      }));
      await connections.connect(profiles[0], {});
      await connections.connect(profiles[1], {});
      const source = path.join(server.root, "source");
      const destination = path.join(source, "nested");
      await fs.mkdir(destination, { recursive: true });
      await fs.writeFile(path.join(source, "preserved.txt"), "preserved");
      const transfers = new Transfers(connections);
      const id = transfers.start({
        source: [{ connectionId: profiles[0].id, path: source }],
        destination: { connectionId: profiles[1].id, path: destination },
        move: true,
        conflict: "error",
      });
      await transfers.idle();
      const job = transfers.jobs.find((job) => job.id === id)!;
      assert.equal(job.status, "error");
      assert.match(job.error!, /하위 폴더/);
      assert.equal(job.bytes, 0);
      assert.deepEqual(await fs.readdir(destination), []);
      assert.equal(
        await fs.readFile(path.join(source, "preserved.txt"), "utf8"),
        "preserved",
      );
    } finally {
      connections.close();
      await server.close();
    }
  },
);

test(
  "moves between profile aliases of one SSH endpoint stream across mount boundaries",
  { timeout: 90000 },
  async () => {
    const server = await startSshd();
    const connections = new Connections(
      new Store(path.join(server.root, "settings.json")),
      async () => true,
    );
    try {
      const profiles = ["Primary", "Alias"].map((name) => ({
        id: randomUUID(),
        name,
        host: "127.0.0.1",
        port: server.port,
        username: server.username,
        auth: "key" as const,
        keyPath: server.key,
        initialPath: server.root,
      }));
      await connections.connect(profiles[0], {});
      await connections.connect(profiles[1], {});
      assert.equal(
        connections.identity(profiles[0].id),
        connections.identity(profiles[1].id),
      );

      const source = path.join(server.root, "source.bin");
      const destination = path.join(server.root, "destination");
      const content = Buffer.alloc(256 * 1024 + 37, "Cross-mount SSH move");
      await fs.writeFile(source, content);
      await fs.mkdir(destination);
      const canonicalSource = await fs.realpath(source);
      const targetProvider = connections.get(profiles[1].id);
      const rename = targetProvider.rename.bind(targetProvider);
      let directRenameAttempts = 0;
      const publishedSources: string[] = [];
      targetProvider.rename = async (from, to) => {
        if (from === source || from === canonicalSource) {
          directRenameAttempts++;
          throw Object.assign(new Error("Cross-device rename is unavailable"), {
            code: "EXDEV",
          });
        }
        publishedSources.push(from);
        await rename(from, to);
      };

      const transfers = new Transfers(connections);
      const id = transfers.start({
        source: [{ connectionId: profiles[0].id, path: source }],
        destination: { connectionId: profiles[1].id, path: destination },
        move: true,
        conflict: "error",
      });
      await transfers.idle();
      const job = transfers.jobs.find((job) => job.id === id)!;
      assert.equal(job.status, "done", job.error);
      assert.equal(directRenameAttempts, 0);
      assert.equal(publishedSources.length, 1);
      assert.equal(path.basename(publishedSources[0]), "item");
      assert.deepEqual(
        await fs.readFile(path.join(destination, "source.bin")),
        content,
      );
      await assert.rejects(fs.lstat(source), { code: "ENOENT" });
      assert.deepEqual(await fs.readdir(destination), ["source.bin"]);
    } finally {
      connections.close();
      await server.close();
    }
  },
);

test("staging creation failure does not delete an existing destination", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-staging-"));
  try {
    const connections = new Connections(
      new Store(path.join(root, "settings.json")),
      async () => false,
      root,
    );
    await fs.writeFile(path.join(root, "source.txt"), "source");
    await fs.mkdir(path.join(root, "dest"));
    let collided = "";
    connections.local.mkdir = async (p) => {
      collided = p;
      await fs.mkdir(p);
      await fs.writeFile(path.join(p, "existing.txt"), "preserve");
      throw Object.assign(new Error("Existing staging directory"), {
        code: "EEXIST",
      });
    };
    const transfers = new Transfers(connections);
    const id = transfers.start({
      source: [{ connectionId: "local", path: path.join(root, "source.txt") }],
      destination: { connectionId: "local", path: path.join(root, "dest") },
      move: false,
      conflict: "error",
    });
    await transfers.idle();
    assert.equal(transfers.jobs.find((j) => j.id === id)?.status, "error");
    assert.equal(
      await fs.readFile(path.join(collided, "existing.txt"), "utf8"),
      "preserve",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("active transfer cancellation removes staging and preserves source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-cancel-"));
  try {
    const connections = new Connections(
      new Store(path.join(root, "settings.json")),
      async () => false,
      root,
    );
    const source = path.join(root, "large.bin");
    const dest = path.join(root, "destination");
    await fs.mkdir(dest);
    await fs.writeFile(source, Buffer.alloc(4 * 1024 * 1024, 7));
    const originalRead = connections.local.read.bind(connections.local);
    connections.local.read = (p) =>
      Readable.from(
        (async function* () {
          for await (const chunk of originalRead(p)) {
            await new Promise((resolve) => setTimeout(resolve, 2));
            yield chunk;
          }
        })(),
      ) as ReturnType<typeof originalRead>;
    const transfers = new Transfers(connections);
    transfers.on("change", (jobs) => {
      for (const job of jobs)
        if (job.status === "running" && job.bytes > 0) transfers.cancel(job.id);
    });
    // Use a second connection identifier for the same local provider so the test exercises streaming, not same-provider rename.
    const get = connections.get.bind(connections);
    connections.get = (id) =>
      id === "stream-target" ? connections.local : get(id);
    const id = transfers.start({
      source: [{ connectionId: "local", path: source }],
      destination: { connectionId: "stream-target", path: dest },
      move: true,
      conflict: "error",
    });
    await transfers.idle();
    assert.equal(transfers.jobs.find((j) => j.id === id)?.status, "cancelled");
    assert.equal((await fs.stat(source)).size, 4 * 1024 * 1024);
    assert.deepEqual(await fs.readdir(dest), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("local transfer: nested files, collision, symlink, move, cancellation and descendant protection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-local-"));
  try {
    const store = new Store(path.join(root, "settings.json"));
    const connections = new Connections(store, async () => false, root);
    const transfers = new Transfers(connections);
    const source = path.join(root, "source");
    const dest = path.join(root, "dest");
    await fs.mkdir(path.join(source, "nested"), { recursive: true });
    await fs.mkdir(dest);
    await fs.writeFile(
      path.join(source, "nested", "한글 $ file.txt"),
      "actual file content",
    );
    await fs.writeFile(path.join(source, ".hidden"), "hidden content");
    await fs.symlink("nested/한글 $ file.txt", path.join(source, "link"));
    const request = {
      source: [{ connectionId: "local", path: source }],
      destination: { connectionId: "local", path: dest },
      move: false,
      conflict: "error" as const,
    };
    const id = transfers.start(request);
    await transfers.idle();
    assert.equal(transfers.jobs.find((j) => j.id === id)?.status, "done");
    assert.equal(
      await fs.readFile(
        path.join(dest, "source", "nested", "한글 $ file.txt"),
        "utf8",
      ),
      "actual file content",
    );
    assert.equal(
      await fs.readlink(path.join(dest, "source", "link")),
      "nested/한글 $ file.txt",
    );
    const collision = transfers.start(request);
    await transfers.idle();
    assert.equal(
      transfers.jobs.find((j) => j.id === collision)?.status,
      "error",
    );
    const both = transfers.start({ ...request, conflict: "keep-both" });
    await transfers.idle();
    assert.equal(transfers.jobs.find((j) => j.id === both)?.status, "done");
    assert.equal(
      await fs.readFile(path.join(dest, "source (2)", ".hidden"), "utf8"),
      "hidden content",
    );
    const descendant = transfers.start({
      ...request,
      destination: { connectionId: "local", path: path.join(source, "nested") },
    });
    await transfers.idle();
    assert.equal(
      transfers.jobs.find((j) => j.id === descendant)?.status,
      "error",
    );
    const cancelled = transfers.start({ ...request, conflict: "keep-both" });
    transfers.cancel(cancelled);
    await transfers.idle();
    assert.equal(
      transfers.jobs.find((j) => j.id === cancelled)?.status,
      "cancelled",
    );
    const move = transfers.start({
      ...request,
      move: true,
      conflict: "keep-both",
    });
    await transfers.idle();
    assert.equal(transfers.jobs.find((j) => j.id === move)?.status, "done");
    await assert.rejects(fs.stat(source));
    assert.ok(
      !(await fs.readdir(dest)).some((name) => name.endsWith(".partial")),
    );
    assert.throws(() => validName("../outside"));
    assert.throws(() => validName("bad\0name"));
    const original = path.join(dest, "existing.txt");
    await fs.writeFile(original, "preserve");
    await assert.rejects(
      connections.local.rename(path.join(dest, "source", ".hidden"), original),
    );
    assert.equal(await fs.readFile(original, "utf8"), "preserve");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "real OpenSSH: trust, SFTP browse, upload/download, remote copy, move, disconnect and host-key rejection",
  { timeout: 90000 },
  async () => {
    const sshd = await startSshd();
    const store = new Store(path.join(sshd.root, "settings.json"));
    let prompts = 0;
    const connections = new Connections(
      store,
      async () => {
        prompts++;
        return true;
      },
      sshd.root,
    );
    const transfers = new Transfers(connections);
    try {
      const remoteRoot = path.join(sshd.root, "remote");
      await fs.mkdir(remoteRoot);
      const profile = {
        id: randomUUID(),
        name: "Loopback SSH",
        host: "127.0.0.1",
        port: sshd.port,
        username: sshd.username,
        auth: "key" as const,
        keyPath: sshd.key,
        initialPath: remoteRoot,
      };
      const connection = await connections.connect(profile, {});
      assert.equal(connection.status, "connected");
      assert.equal(prompts, 1);
      const upload = path.join(sshd.root, "upload");
      await fs.mkdir(upload);
      const buffer = Buffer.alloc(1024 * 1024 + 123, "Sinder 실제 SSH 전송");
      await fs.writeFile(path.join(upload, "data.bin"), buffer);
      await fs.writeFile(path.join(upload, "hello.txt"), "안녕하세요, SSH");
      await fs.symlink("hello.txt", path.join(upload, "link"));
      const id = transfers.start({
        source: [{ connectionId: "local", path: upload }],
        destination: { connectionId: profile.id, path: remoteRoot },
        move: false,
        conflict: "error",
      });
      await transfers.idle();
      assert.equal(
        transfers.jobs.find((j) => j.id === id)?.status,
        "done",
        transfers.jobs.find((j) => j.id === id)?.error,
      );
      assert.deepEqual(
        await fs.readFile(path.join(remoteRoot, "upload/data.bin")),
        buffer,
      );
      assert.equal(
        await fs.readlink(path.join(remoteRoot, "upload/link")),
        "hello.txt",
      );
      const provider = connections.get(profile.id);
      assert.equal((await provider.list(remoteRoot))[0].name, "upload");
      const download = path.join(sshd.root, "download");
      await fs.mkdir(download);
      const down = transfers.start({
        source: [
          { connectionId: profile.id, path: path.join(remoteRoot, "upload") },
        ],
        destination: { connectionId: "local", path: download },
        move: false,
        conflict: "error",
      });
      await transfers.idle();
      assert.equal(
        transfers.jobs.find((j) => j.id === down)?.status,
        "done",
        transfers.jobs.find((j) => j.id === down)?.error,
      );
      assert.deepEqual(
        await fs.readFile(path.join(download, "upload/data.bin")),
        buffer,
      );
      await provider.mkdir(path.join(remoteRoot, "copies"));
      const copy = transfers.start({
        source: [
          { connectionId: profile.id, path: path.join(remoteRoot, "upload") },
        ],
        destination: {
          connectionId: profile.id,
          path: path.join(remoteRoot, "copies"),
        },
        move: false,
        conflict: "error",
      });
      await transfers.idle();
      assert.equal(
        transfers.jobs.find((j) => j.id === copy)?.status,
        "done",
        transfers.jobs.find((j) => j.id === copy)?.error,
      );
      const remoteFile = path.join(remoteRoot, "upload/hello.txt");
      const move = transfers.start({
        source: [{ connectionId: profile.id, path: remoteFile }],
        destination: { connectionId: "local", path: download },
        move: true,
        conflict: "error",
      });
      await transfers.idle();
      assert.equal(transfers.jobs.find((j) => j.id === move)?.status, "done");
      await assert.rejects(fs.stat(remoteFile));
      assert.equal(
        await fs.readFile(path.join(download, "hello.txt"), "utf8"),
        "안녕하세요, SSH",
      );
      connections.disconnect(profile.id);
      assert.throws(() => connections.get(profile.id));
      await connections.connect(profile, {});
      assert.equal(prompts, 1, "known host does not prompt again");
      connections.disconnect(profile.id);
      store.data.hosts[`127.0.0.1:${sshd.port}`] = "SHA256:changed";
      await assert.rejects(
        connections.connect(profile, {}),
        /호스트 키가 변경/,
      );
      assert.equal(prompts, 1);
      const persisted = await fs.readFile(
        path.join(sshd.root, "settings.json"),
        "utf8",
      );
      assert.ok(!persisted.includes("PRIVATE KEY"));
      assert.ok(!persisted.includes("passphrase"));
    } finally {
      connections.close();
      await sshd.close();
    }
  },
);
