import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SshConfig, sshWords } from "../electron/ssh-config.js";
import { Connections } from "../electron/connections.js";
import { Store } from "../electron/store.js";
import { startSshd } from "./sshd.js";

async function fixture(text = "") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-config-"));
  await fs.mkdir(path.join(home, ".ssh"));
  const config = new SshConfig(home);
  if (text) await fs.writeFile(config.filename, text);
  return {
    home,
    config,
    close: () => fs.rm(home, { recursive: true, force: true }),
  };
}

test("SSH config: missing file, quoted values, defaults, first value and negated wildcard rules", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.config.scan()).exists, false);
    assert.deepEqual(sshWords('"a # b" c # comment'), ["a # b", "c"]);
    await fs.writeFile(
      f.config.filename,
      `hOsT=work work-alias\n HostName=example.com\n User "remote user" # comment\n Port 2201\n IdentityFile "~/.ssh/key with spaces"\nHost prod\n HostName production.example.com\nHost * !prod\n Port 2222\nHost *\n User fallback\n Port 22\n`,
    );
    const { entries } = await f.config.scan();
    assert.equal(
      entries.length,
      2,
      "wildcard and alternate aliases do not duplicate saved locations",
    );
    assert.deepEqual(entries[0].aliases, ["work", "work-alias"]);
    assert.equal(entries[0].profile.host, "example.com");
    assert.equal(entries[0].profile.port, 2201);
    assert.equal(entries[0].profile.username, "remote user");
    assert.equal(
      entries[0].profile.keyPath,
      path.join(f.home, ".ssh/key with spaces"),
    );
    assert.equal(entries[1].profile.port, 22);
    assert.equal(entries[1].profile.username, "fallback");
    assert.equal(entries[0].issue, undefined);
  } finally {
    await f.close();
  }
});

test("SSH Include expands from ~/.ssh in lexical order and rejects cycles", async () => {
  const f = await fixture(
    "Include conf/*.conf\nUser parent-default\nHost *\n User fallback\n",
  );
  try {
    await fs.mkdir(path.join(f.home, ".ssh/conf"));
    await fs.writeFile(
      path.join(f.home, ".ssh/conf/b.conf"),
      "User include-default\nHost second\n Port 2202\n",
    );
    await fs.writeFile(
      path.join(f.home, ".ssh/conf/a.conf"),
      "Host first\n Port 2201\n",
    );
    const { entries } = await f.config.scan();
    assert.deepEqual(
      entries.map((entry) => entry.alias),
      ["first", "second"],
    );
    assert.deepEqual(
      entries.map((entry) => entry.profile.port),
      [2201, 2202],
    );
    assert.deepEqual(
      entries.map((entry) => entry.profile.username),
      ["include-default", "include-default"],
    );
    await fs.writeFile(
      path.join(f.home, ".ssh/conf/a.conf"),
      "Include config\n",
    );
    await assert.rejects(f.config.scan(), /순환/);
  } finally {
    await f.close();
  }
});

test("SSH import does not execute Match or proxy commands, nor silently bypass unsupported routing", async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.home, "executed");
    await fs.writeFile(
      f.config.filename,
      `Host safe\n ProxyCommand /bin/touch ${marker}\nHost unsupported\n ProxyCommand echo unsafe | nc %h %p\n`,
    );
    const { entries } = await f.config.scan();
    assert.equal(entries[0].route, "proxy");
    assert.equal(entries[0].issue, undefined);
    assert.match(entries[1].issue!, /셸 연산자/);
    assert.equal(await fs.stat(marker).catch(() => null), null);
    await assert.rejects(f.config.route("unsupported"), /셸 연산자/);
    await fs.appendFile(
      f.config.filename,
      `Match exec "touch ${marker}"\n User changed\n`,
    );
    assert.ok((await f.config.scan()).entries.every((entry) => entry.issue));
    assert.equal(await fs.stat(marker).catch(() => null), null);
  } finally {
    await f.close();
  }
});

test("SSH routing preserves argv boundaries, tokens, first proxy option and removed aliases", async () => {
  const f = await fixture(
    `Host mesh\n HostName server\n User remote\n Port 2200\n ProxyCommand "~/.ssh/my proxy" %h %p %r %n %%\nHost jump\n ProxyJump one,two\n ProxyCommand ignored\n`,
  );
  try {
    assert.deepEqual((await f.config.route("mesh")).command, [
      path.join(f.home, ".ssh/my proxy"),
      "server",
      "2200",
      "remote",
      "mesh",
      "%",
    ]);
    const jump = (await f.config.route("jump")).command;
    assert.deepEqual(jump.slice(-6), [
      "-J",
      "one",
      "-W",
      "[jump]:22",
      "--",
      "two",
    ]);
    await fs.writeFile(f.config.filename, "Host other\n");
    await assert.rejects(f.config.route("mesh"), /찾지 못/);
    await fs.writeFile(
      f.config.filename,
      'Host quoted\n ProxyCommand "~/.ssh/proxy with spaces"\n IdentityAgent none\n',
    );
    const route = await f.config.route("quoted");
    assert.deepEqual(route.command, [
      path.join(f.home, ".ssh/proxy with spaces"),
    ]);
    assert.equal(route.agent, null);
  } finally {
    await f.close();
  }
});

test("SSH import saves disconnected profiles once and rolls back a failed save", async () => {
  const f = await fixture(
    "Host work alias\n HostName localhost\nHost another\n HostName example.com\n",
  );
  const store = new Store(path.join(f.home, "settings.json"));
  const connections = new Connections(
    store,
    async () => {
      throw new Error("Import must not request trust");
    },
    f.home,
  );
  try {
    assert.deepEqual(await connections.importSshConfig(), {
      added: 2,
      skipped: 0,
    });
    assert.ok(
      connections
        .list()
        .slice(1)
        .every((connection) => connection.status === "disconnected"),
    );
    const ids = store.data.profiles.map((profile) => profile.id);
    assert.deepEqual(
      (await connections.readSshConfig()).entries.map(
        (entry) => entry.profile.id,
      ),
      ids,
    );
    assert.deepEqual(await connections.importSshConfig(), {
      added: 0,
      skipped: 2,
    });
    assert.deepEqual(
      store.data.profiles.map((profile) => profile.id),
      ids,
    );
    const disk = new Store(path.join(f.home, "settings.json"));
    await disk.load();
    assert.deepEqual(
      disk.data.profiles,
      JSON.parse(JSON.stringify(store.data.profiles)),
    );
    await fs.appendFile(f.config.filename, "Host extra\n");
    store.save = async () => {
      throw new Error("disk full");
    };
    await assert.rejects(connections.importSshConfig(), /disk full/);
    assert.equal(store.data.profiles.length, 2);
  } finally {
    connections.close();
    await f.close();
  }
});

test(
  "Imported ProxyCommand reaches real SFTP and closes its child on disconnect",
  { timeout: 20000 },
  async () => {
    const server = await startSshd();
    const f = await fixture();
    const store = new Store(path.join(f.home, "settings.json"));
    const connections = new Connections(store, async () => true, f.home);
    try {
      const script = path.join(f.home, "proxy script.cjs");
      const pid = path.join(f.home, "proxy.pid");
      await fs.writeFile(
        script,
        `const fs=require('node:fs');const net=require('node:net');fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));const socket=net.connect(Number(process.argv[3]),process.argv[2]);process.stdin.pipe(socket).pipe(process.stdout);socket.on('error',()=>process.exit(1));socket.on('close',()=>process.exit(0));`,
      );
      await fs.writeFile(
        f.config.filename,
        `Host fixture\n HostName 127.0.0.1\n Port ${server.port}\n User ${server.username}\n IdentityFile "${server.key}"\n ProxyCommand "${process.execPath}" "${script}" %h %p\n`,
      );
      await connections.importSshConfig();
      const profile = store.data.profiles[0];
      await connections.connect(profile, {});
      assert.equal(
        (await connections.get(profile.id).stat(server.root)).kind,
        "directory",
      );
      const child = Number(await fs.readFile(pid, "utf8"));
      connections.disconnect(profile.id);
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(child, 0);
        } catch {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("Proxy process survived disconnect");
    } finally {
      connections.close();
      await server.close();
      await f.close();
    }
  },
);

test(
  "Cancelling a pending imported proxy stops its process and saves no profile",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    const store = new Store(path.join(f.home, "settings.json"));
    const connections = new Connections(store, async () => true, f.home);
    try {
      const script = path.join(f.home, "hang.cjs"),
        pid = path.join(f.home, "proxy.pid");
      await fs.writeFile(
        script,
        `require('node:fs').writeFileSync(${JSON.stringify(pid)},String(process.pid));setInterval(()=>{},1000);`,
      );
      await fs.writeFile(
        f.config.filename,
        `Host hanging\n ProxyCommand "${process.execPath}" "${script}"\n`,
      );
      const profile = (await f.config.scan()).entries[0].profile;
      // Avoid requiring a real agent while waiting for the SSH handshake.
      profile.auth = "password";
      const pending = connections.connect(profile, {});
      const rejected = assert.rejects(pending, /취소/);
      for (let i = 0; i < 100 && !(await fs.stat(pid).catch(() => null)); i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const child = Number(await fs.readFile(pid, "utf8"));
      assert.equal(connections.cancel(profile.id), "cancelled");
      await rejected;
      assert.equal(store.data.profiles.length, 0);
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(child, 0);
        } catch {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("Proxy process survived cancellation");
    } finally {
      connections.close();
      await f.close();
    }
  },
);

test(
  "Imported ProxyJump forwards through a real SSH hop using its local key and known_hosts",
  { timeout: 20000 },
  async () => {
    const [hop, server] = await Promise.all([startSshd(), startSshd()]);
    const f = await fixture();
    const store = new Store(path.join(f.home, "settings.json"));
    const connections = new Connections(store, async () => true, f.home);
    try {
      const knownHosts = path.join(f.home, ".ssh/known_hosts");
      await fs.writeFile(
        knownHosts,
        `[127.0.0.1]:${hop.port} ${await fs.readFile(path.join(hop.root, "host.pub"), "utf8")}`,
      );
      await fs.writeFile(
        f.config.filename,
        `Host destination\n HostName 127.0.0.1\n Port ${server.port}\n User ${server.username}\n IdentityFile "${server.key}"\n ProxyJump hop\nHost hop\n HostName 127.0.0.1\n Port ${hop.port}\n User ${hop.username}\n IdentityFile "${hop.key}"\n UserKnownHostsFile "${knownHosts}"\n`,
      );
      const profile = (await f.config.scan()).entries[0].profile;
      await connections.connect(profile, {});
      assert.equal(
        (await connections.get(profile.id).stat(server.root)).kind,
        "directory",
      );
      connections.disconnect(profile.id);
    } finally {
      connections.close();
      await hop.close();
      await server.close();
      await f.close();
    }
  },
);
