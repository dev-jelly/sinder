import { Client } from "ssh2";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { LocalProvider, SftpProvider, type Provider } from "./providers.js";
import type {
  CancelConnectionResult,
  Connection,
  Credentials,
  Profile,
} from "../shared/types.js";
import type { Store } from "./store.js";
import { SshConfig } from "./ssh-config.js";
import { openSshProxy } from "./ssh-proxy.js";

type PendingConnection = {
  client: Client;
  controller: AbortController;
  committed: boolean;
  proxy?: import("node:stream").Duplex;
};

export class Connections extends EventEmitter {
  private sessions = new Map<
    string,
    { client: Client; provider: Provider; info: Connection; identity: string }
  >();
  private connecting = new Map<string, PendingConnection>();
  local: LocalProvider;
  readonly sshConfig: SshConfig;
  constructor(
    private store: Store,
    private trust: (profile: Profile, fingerprint: string) => Promise<boolean>,
    home = os.homedir(),
  ) {
    super();
    this.local = new LocalProvider(home);
    this.sshConfig = new SshConfig(home);
  }
  list(): Connection[] {
    return [
      {
        id: "local",
        name: "이 Mac",
        kind: "local",
        status: "connected",
        home: this.local.home,
      },
      ...this.store.data.profiles.map(
        (p) =>
          this.sessions.get(p.id)?.info ?? {
            id: p.id,
            name: p.name,
            kind: "ssh" as const,
            status: "disconnected" as const,
            home: p.initialPath,
            host: p.host,
          },
      ),
    ];
  }
  get(id: string): Provider {
    if (id === "local") return this.local;
    const session = this.sessions.get(id);
    if (!session)
      throw new Error(
        "SSH 연결이 끊어졌습니다. 사이드바에서 다시 연결해 주세요.",
      );
    return session.provider;
  }
  identity(id: string): string {
    const session = this.sessions.get(id);
    if (!session)
      throw new Error("SSH 연결이 끊어졌습니다. 다시 연결해 주세요.");
    return session.identity;
  }
  async connect(profile: Profile, credentials: Credentials) {
    if (this.connecting.has(profile.id)) throw new Error("이미 연결 중입니다.");
    const attempt: PendingConnection = {
      client: new Client(),
      controller: new AbortController(),
      committed: false,
    };
    const { signal } = attempt.controller;
    this.connecting.set(profile.id, attempt);
    let aborted: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
    });
    try {
      // Cancellation must settle even while a key read or trust prompt is pending.
      return await Promise.race([
        this.establish(profile, credentials, attempt),
        cancelled,
      ]);
    } catch (error) {
      attempt.client.end();
      attempt.proxy?.destroy();
      throw error;
    } finally {
      signal.removeEventListener("abort", aborted);
      if (this.connecting.get(profile.id) === attempt)
        this.connecting.delete(profile.id);
    }
  }
  cancel(id: string): CancelConnectionResult {
    const attempt = this.connecting.get(id);
    if (attempt?.committed || (!attempt && this.sessions.has(id)))
      return "committed";
    if (!attempt) return "cancelled";
    this.connecting.delete(id);
    attempt.controller.abort(new Error("SSH 연결을 취소했습니다."));
    attempt.client.destroy();
    attempt.proxy?.destroy();
    return "cancelled";
  }
  private async establish(
    profile: Profile,
    credentials: Credentials,
    attempt: PendingConnection,
  ) {
    const { client, controller } = attempt;
    const { signal } = controller;
    let approvedFingerprint: string | undefined;
    let observedFingerprint = "";
    const hostId = `${profile.host.toLowerCase()}:${profile.port}`;
    let verificationError: string | undefined;
    const route = profile.sshConfigHost
      ? await this.sshConfig.route(profile.sshConfigHost, profile)
      : undefined;
    const privateKey =
      profile.auth === "key"
        ? await fs.readFile(
            profile.keyPath!.replace(/^~(?=[/\\])/, os.homedir()),
            { signal },
          )
        : undefined;
    signal.throwIfAborted();
    const agent =
      route?.agent !== undefined
        ? route.agent
        : process.platform === "win32"
          ? "pageant"
          : process.env.SSH_AUTH_SOCK;
    if (profile.auth === "agent" && !agent)
      throw new Error(
        "SSH agent를 찾지 못했습니다. 키 파일 또는 비밀번호 인증을 선택해 주세요.",
      );
    if (route?.command.length) {
      attempt.proxy = openSshProxy(route.command, this.sshConfig.home, signal);
      client.once("close", () => attempt.proxy?.destroy());
    }
    await new Promise<void>((resolve, reject) => {
      client.once("ready", resolve);
      client.on("error", (err) =>
        reject(new Error(verificationError ?? err.message)),
      );
      client.once("close", () =>
        reject(
          signal.reason ??
            new Error(verificationError ?? "SSH 연결이 끊어졌습니다."),
        ),
      );
      client.connect({
        host: profile.host,
        port: profile.port,
        username: profile.username,
        sock: attempt.proxy,
        privateKey,
        passphrase: credentials.passphrase,
        password:
          profile.auth === "password" ? credentials.password : undefined,
        agent: profile.auth === "agent" ? (agent ?? undefined) : undefined,
        readyTimeout: 60000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          if (signal.aborted) return verify(false);
          const fingerprint =
            "SHA256:" +
            createHash("sha256")
              .update(key)
              .digest("base64")
              .replace(/=+$/, "");
          const known = this.store.data.hosts[hostId];
          observedFingerprint = fingerprint;
          if (known) {
            if (known !== fingerprint)
              verificationError =
                "서버 호스트 키가 변경되었습니다. 서버 관리자에게 확인한 후 저장된 키를 관리해 주세요.";
            verify(known === fingerprint);
          } else
            this.trust(profile, fingerprint)
              .then((approved) => {
                if (signal.aborted) return verify(false);
                if (approved) approvedFingerprint = fingerprint;
                else verificationError = "서버 키 확인을 취소했습니다.";
                verify(approved);
              })
              .catch(() => verify(false));
        },
      });
    });
    signal.throwIfAborted();
    const sftp = await new Promise<import("ssh2").SFTPWrapper>(
      (resolve, reject) =>
        client.sftp((error, channel) =>
          error ? reject(error) : resolve(channel),
        ),
    );
    signal.throwIfAborted();
    const provider = new SftpProvider("/", sftp);
    const home = await provider.realpath(".");
    signal.throwIfAborted();
    provider.home = home;
    const initial =
      profile.initialPath === "~" || !profile.initialPath
        ? home
        : profile.initialPath.replace(/^~\//, home + "/");
    const start = await provider.realpath(initial);
    signal.throwIfAborted();
    if ((await provider.stat(start)).kind !== "directory")
      throw new Error("시작 경로가 폴더가 아닙니다.");
    signal.throwIfAborted();
    // Establishment is complete; commit the live session and its trusted profile.
    // Later cancellation cannot disconnect this session or an earlier live one.
    attempt.committed = true;
    this.disconnect(profile.id);
    const info: Connection = {
      id: profile.id,
      name: profile.name,
      kind: "ssh",
      status: "connected",
      home: start,
      host: profile.host,
    };
    this.sessions.set(profile.id, {
      client,
      provider,
      info,
      identity: JSON.stringify([
        profile.host.toLowerCase(),
        profile.port,
        profile.username,
        observedFingerprint,
      ]),
    });
    const closed = () => {
      if (this.sessions.get(profile.id)?.client === client) {
        this.sessions.delete(profile.id);
        this.emit("change", this.list());
      }
    };
    client.on("close", closed);
    client.on("error", () => {
      client.end();
      closed();
    });
    this.store.data.profiles = [
      ...this.store.data.profiles.filter((p) => p.id !== profile.id),
      profile,
    ];
    if (approvedFingerprint)
      this.store.data.hosts[hostId] = approvedFingerprint;
    await this.store.save();
    this.emit("change", this.list());
    return info;
  }
  disconnect(id: string) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    session?.client.end();
    this.emit("change", this.list());
  }
  close() {
    for (const id of this.connecting.keys()) this.cancel(id);
    for (const id of this.sessions.keys()) this.disconnect(id);
  }
  async removeProfile(id: string) {
    this.cancel(id);
    this.disconnect(id);
    this.store.data.profiles = this.store.data.profiles.filter(
      (p) => p.id !== id,
    );
    this.store.data.bookmarks = this.store.data.bookmarks.filter(
      (b) => b.location.connectionId !== id,
    );
    await this.store.save();
    this.emit("change", this.list());
  }
  async readSshConfig() {
    const snapshot = await this.sshConfig.scan();
    for (const entry of snapshot.entries) {
      const saved = this.store.data.profiles.find(
        (profile) => profile.sshConfigHost === entry.alias,
      );
      if (saved)
        Object.assign(entry.profile, {
          id: saved.id,
          name: saved.name,
          initialPath: saved.initialPath,
        });
    }
    return snapshot;
  }
  async importSshConfig() {
    const { entries } = await this.sshConfig.scan();
    const previous = this.store.data.profiles;
    const profiles = entries
      .filter(
        (entry) =>
          !entry.issue &&
          !previous.some((profile) => profile.sshConfigHost === entry.alias),
      )
      .map((entry) => entry.profile);
    if (profiles.length) {
      this.store.data.profiles = [...previous, ...profiles];
      try {
        await this.store.save();
      } catch (error) {
        this.store.data.profiles = this.store.data.profiles.filter(
          (profile) => !profiles.some((added) => added.id === profile.id),
        );
        throw error;
      }
      this.emit("change", this.list());
    }
    return {
      added: profiles.length,
      skipped: entries.length - profiles.length,
    };
  }
  resolve(id: string, p: string) {
    const provider = this.get(id);
    const expanded =
      p === "~"
        ? provider.home
        : p.replace(/^~[/\\]/, provider.home + provider.paths.sep);
    return provider.paths.resolve(provider.home, expanded);
  }
}
