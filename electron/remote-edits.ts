import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { exists, validName, type Provider } from "./providers.js";
import { durableExclusiveFile, durableJson } from "./durable-json.js";
import type { Connections } from "./connections.js";
import type { EditAction, EditSession, Location } from "../shared/types.js";

const MAX_BYTES = 32 * 1024 * 1024;
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const transactionSchema = z.object({
  id: z.string().uuid(),
  digest: hashSchema,
});
const recordSchema = z.object({
  id: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .refine((name) => {
      try {
        validName(name);
        return true;
      } catch {
        return false;
      }
    }),
  location: z.object({
    connectionId: z.string().min(1),
    path: z
      .string()
      .startsWith("/")
      .refine((p) => !p.includes("\0")),
  }),
  identity: z.string(),
  baseline: hashSchema,
  enabled: z.boolean(),
  status: z.enum([
    "clean",
    "pending",
    "uploading",
    "offline",
    "conflict",
    "error",
    "paused",
  ]),
  error: z.string().optional(),
  updated: z.number(),
  backups: z.array(z.string().uuid()),
  transaction: transactionSchema.optional(),
});
type Record = z.infer<typeof recordSchema>;
class Conflict extends Error {}
class LocalChanging extends Error {}

async function remoteBytes(provider: Provider, p: string) {
  const before = await provider.stat(p);
  if (before.kind !== "file")
    throw new Conflict(
      "일반 파일만 편집할 수 있습니다. 링크나 폴더로 바뀌었는지 확인해 주세요.",
    );
  if (before.size > MAX_BYTES)
    throw new Error("원격 편집은 32 MB 이하의 텍스트 파일을 지원합니다.");
  const stream = provider.read(p);
  const chunks: Buffer[] = [];
  let length = 0;
  const timeout = setTimeout(
    () => stream.destroy(new Error("서버 파일 읽기 시간이 초과되었습니다.")),
    30000,
  );
  try {
    for await (const chunk of stream) {
      length += chunk.length;
      if (length > MAX_BYTES)
        throw new Error("편집 가능한 파일 크기를 초과했습니다.");
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    clearTimeout(timeout);
    stream.destroy();
  }
  const after = await provider.stat(p);
  if (
    after.kind !== "file" ||
    before.size !== after.size ||
    before.modified !== after.modified ||
    length !== after.size
  )
    throw new Conflict(
      "읽는 동안 서버 파일이 변경되었습니다. 다시 확인해 주세요.",
    );
  return { bytes: Buffer.concat(chunks), info: after };
}

export class RemoteEdits extends EventEmitter {
  private records: Record[] = [];
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private disposed = false;
  private ticking = false;
  private seen = new Map<string, { signature: string; changed: number }>();
  private changedConnection = () => {
    void this.poll(true).catch((error) => this.emit("failure", error));
  };
  constructor(
    private connections: Connections,
    private directory: string,
    private launch: (filename: string) => Promise<void>,
  ) {
    super();
  }
  private localPath(record: Record) {
    return path.join(this.directory, record.id, record.name);
  }
  private paths(record: Record, id: string) {
    const folder = path.posix.join(
      path.posix.dirname(record.location.path),
      `.sinder-edit-${id}`,
    );
    return {
      folder,
      next: path.posix.join(
        folder,
        record.name === "next" ? "next.tmp" : "next",
      ),
      previous: path.posix.join(folder, record.name),
    };
  }
  private view(record: Record): EditSession {
    return {
      id: record.id,
      name: record.name,
      location: { ...record.location },
      localPath: this.localPath(record),
      status: record.status,
      error: record.error,
      updated: record.updated,
      backupCount: record.backups.length,
      backupLocations: record.backups.map((id) => ({
        ...record.location,
        path: this.paths(record, id).folder,
      })),
      backupLocation: record.backups.length
        ? {
            ...record.location,
            path: this.paths(record, record.backups.at(-1)!).folder,
          }
        : undefined,
    };
  }
  list() {
    return this.records.map((record) => this.view(record));
  }
  private async save() {
    await durableJson(path.join(this.directory, "sessions.json"), this.records);
    this.emit("change", this.list());
  }
  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const promise = this.serial.catch(() => {}).then(operation);
    this.serial = promise;
    return promise;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      this.records = z
        .array(recordSchema)
        .parse(
          JSON.parse(
            await fs.readFile(
              path.join(this.directory, "sessions.json"),
              "utf8",
            ),
          ),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "원격 편집 복구 기록을 읽지 못했습니다. 로컬 수정본은 보존되어 있습니다.",
          { cause: error },
        );
    }
    for (const record of this.records) {
      if (record.status === "uploading") record.status = "pending";
      if (record.enabled && !["conflict", "error"].includes(record.status))
        record.status = "offline";
    }
    this.connections.on("change", this.changedConnection);
    this.resume();
  }
  resume() {
    this.stopping = false;
    if (!this.timer)
      this.timer = setInterval(() => {
        void this.poll().catch((error) => this.emit("failure", error));
      }, 1000);
    this.timer.unref();
  }
  private record(id: string) {
    const record = this.records.find((r) => r.id === id);
    if (!record) throw new Error("편집 작업을 찾을 수 없습니다.");
    return record;
  }
  private provider(record: Record) {
    if (
      this.connections.identity(record.location.connectionId) !==
      record.identity
    )
      throw new Conflict(
        "연결의 서버 또는 계정이 바뀌었습니다. 기존 수정본은 다른 서버에 업로드하지 않습니다.",
      );
    return this.connections.get(record.location.connectionId);
  }
  private async localBytes(record: Record) {
    const filename = this.localPath(record);
    const file = await fs.open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size > MAX_BYTES)
        throw new Error("로컬 수정본은 32 MB 이하의 일반 파일이어야 합니다.");
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await file.stat();
      const current = await fs.lstat(filename);
      if (
        !current.isFile() ||
        before.size !== length ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        current.ino !== after.ino ||
        current.mtimeMs !== after.mtimeMs
      )
        throw new LocalChanging("편집기의 저장이 끝나기를 기다립니다.");
      return buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  }
  async open(location: Location) {
    const session = await this.lock(async () => {
      if (location.connectionId === "local")
        throw new Error("로컬 파일은 기본 앱에서 열어 주세요.");
      const provider = this.connections.get(location.connectionId);
      const absolute = this.connections.resolve(
        location.connectionId,
        location.path,
      );
      // Resolve parent aliases but keep the leaf, so symlinks aren't silently edited.
      const canonical = path.posix.join(
        await provider.realpath(path.posix.dirname(absolute)),
        validName(path.posix.basename(absolute)),
      );
      const identity = this.connections.identity(location.connectionId);
      const existing = this.records.find(
        (r) =>
          r.location.connectionId === location.connectionId &&
          r.location.path === canonical &&
          r.identity === identity,
      );
      if (existing) {
        if (!existing.enabled) {
          existing.enabled = true;
          existing.status = "pending";
          existing.error = undefined;
          await this.save();
        }
        return this.view(existing);
      }
      const { bytes } = await remoteBytes(provider, canonical);
      if (bytes.includes(0))
        throw new Error("바이너리 파일은 텍스트 편집을 지원하지 않습니다.");
      const id = randomUUID();
      const name = validName(path.posix.basename(canonical));
      const record: Record = {
        id,
        name,
        location: { ...location, path: canonical },
        identity,
        baseline: digest(bytes),
        enabled: true,
        status: "clean",
        updated: Date.now(),
        backups: [],
      };
      await fs.mkdir(path.join(this.directory, id), { mode: 0o700 });
      await fs.writeFile(this.localPath(record), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      this.records.unshift(record);
      await this.save();
      return this.view(record);
    });
    await this.launch(session.localPath);
    return session;
  }
  async action(id: string, action: Exclude<EditAction, "reveal">) {
    if (action === "open") {
      await this.launch(this.localPath(this.record(id)));
      return;
    }
    await this.lock(async () => {
      const record = this.record(id);
      if (action === "server-copy") {
        const { bytes } = await remoteBytes(
          this.provider(record),
          record.location.path,
        );
        const folder = path.join(this.directory, id, `server-${randomUUID()}`);
        await fs.mkdir(folder, { mode: 0o700 });
        const filename = path.join(folder, record.name);
        await fs.writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
        await this.launch(filename);
        return;
      }
      if (action === "pause") {
        if (record.transaction)
          throw new Error(
            "중단된 서버 저장을 복구한 후 일시 중지할 수 있습니다. 먼저 다시 연결해 주세요.",
          );
        record.enabled = false;
        record.status = "paused";
        await this.save();
        return;
      }
      if (record.transaction) await this.recover(record, this.provider(record));
      if (action === "apply-local") {
        const { bytes } = await remoteBytes(
          this.provider(record),
          record.location.path,
        );
        record.baseline = digest(bytes);
      }
      record.enabled = true;
      record.status = "pending";
      record.error = undefined;
      await this.save();
      await this.sync(record);
    });
  }
  async poll(force = false) {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      await this.lock(async () => {
        for (const record of this.records) {
          if (
            this.stopping ||
            !record.enabled ||
            (["conflict", "error"].includes(record.status) &&
              !record.transaction)
          )
            continue;
          try {
            // Restore remote names even if an editor has removed its local cache.
            // Recovery uses the journal and server copies, not the editor's file.
            if (record.transaction) {
              await this.recover(record, this.provider(record));
              if (["conflict", "error"].includes(record.status)) continue;
            }
            const stat = await fs.lstat(this.localPath(record));
            const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
            const previous = this.seen.get(record.id);
            if (!force && previous?.signature !== signature) {
              this.seen.set(record.id, { signature, changed: Date.now() });
              continue;
            }
            if (!force && previous && Date.now() - previous.changed < 750)
              continue;
            if (
              force ||
              record.transaction ||
              record.status !== "clean" ||
              previous?.changed !== 0
            ) {
              await this.sync(record);
              this.seen.set(record.id, { signature, changed: 0 });
            }
          } catch (error) {
            await this.failed(record, error);
          }
        }
      });
    } finally {
      this.ticking = false;
    }
  }
  private async failed(record: Record, error: unknown) {
    const previous = `${record.status}:${record.error ?? ""}`;
    if (
      error instanceof LocalChanging ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // Editors often unlink then replace a file. Keep retrying without losing it.
      record.status = "pending";
      record.error = "편집기의 저장이 끝나기를 기다립니다.";
    } else {
      const connected = this.connections
        .list()
        .some(
          (c) =>
            c.id === record.location.connectionId && c.status === "connected",
        );
      record.status =
        error instanceof Conflict
          ? "conflict"
          : connected
            ? "error"
            : "offline";
      record.error = error instanceof Error ? error.message : String(error);
    }
    if (`${record.status}:${record.error ?? ""}` !== previous)
      await this.save();
  }
  private async sync(record: Record) {
    try {
      const provider = this.provider(record);
      if (record.transaction) await this.recover(record, provider);
      if (["conflict", "error"].includes(record.status)) return;
      const local = await this.localBytes(record);
      const hash = digest(local);
      if (hash === record.baseline) {
        if (record.status !== "clean") {
          record.status = "clean";
          record.error = undefined;
          await this.save();
        }
        return;
      }
      record.status = "uploading";
      record.error = undefined;
      await this.save();
      const current = await remoteBytes(provider, record.location.path);
      if (digest(current.bytes) !== record.baseline)
        throw new Conflict(
          "편집을 시작한 뒤 서버 파일도 변경되었습니다. 두 버전을 확인해 주세요.",
        );
      const transaction = { id: randomUUID(), digest: hash };
      const paths = this.paths(record, transaction.id);
      await provider.mkdir(paths.folder);
      // From this point the journal owns this directory, including uncertain network outcomes.
      record.transaction = transaction;
      await this.save();
      await pipeline(Readable.from([local]), provider.write(paths.next), {
        signal: AbortSignal.timeout(30000),
      });
      await provider.chmod(paths.next, current.info.mode);
      if (digest((await remoteBytes(provider, paths.next)).bytes) !== hash)
        throw new Error("서버에 작성한 수정본을 확인하지 못했습니다.");
      if (
        digest((await remoteBytes(provider, record.location.path)).bytes) !==
        record.baseline
      )
        throw new Conflict(
          "업로드 중 서버 파일이 변경되었습니다. 수정본은 로컬에 보존됩니다.",
        );
      await provider.rename(record.location.path, paths.previous);
      // Capture the old name first: a racing writer's version must also survive.
      if (
        digest((await remoteBytes(provider, paths.previous)).bytes) !==
        record.baseline
      )
        throw new Conflict(
          "저장 직전 서버 파일이 변경되었습니다. 서버 원본을 복구합니다.",
        );
      await provider.rename(paths.next, record.location.path);
      await this.recover(record, provider);
    } catch (error) {
      const interrupted = record.transaction;
      // Attempt rollback on the existing connection. The journal persists if it is offline.
      if (record.transaction) {
        try {
          await this.recover(record, this.provider(record));
        } catch {
          /* Recovery is retried on reconnect; neither version is deleted. */
        }
      }
      if (
        !(
          interrupted &&
          !record.transaction &&
          (record.status === "conflict" ||
            (record.status === "clean" &&
              record.baseline === interrupted.digest))
        )
      )
        await this.failed(record, error);
    }
  }
  private async recover(record: Record, provider: Provider) {
    const transaction = record.transaction!;
    const paths = this.paths(record, transaction.id);
    const hasPrevious = await exists(provider, paths.previous);
    const hasTarget = await exists(provider, record.location.path);
    if (hasPrevious && !hasTarget) {
      await provider.rename(paths.previous, record.location.path);
      await this.cleanStaging(record, provider, paths);
      record.transaction = undefined;
      record.status = "conflict";
      record.error =
        "중단된 저장의 서버 원본을 복원했습니다. 로컬 수정본을 확인한 후 다시 적용해 주세요.";
      await this.save();
      return;
    }
    if (!hasTarget)
      throw new Conflict(
        "서버 파일을 찾지 못했습니다. 로컬 수정본과 복구 기록은 보존됩니다.",
      );
    const target = digest(
      (await remoteBytes(provider, record.location.path)).bytes,
    );
    if (hasPrevious) {
      if (!record.backups.includes(transaction.id))
        record.backups.push(transaction.id);
      if (target === transaction.digest) {
        record.baseline = target;
        record.status = "clean";
        record.error = undefined;
        record.updated = Date.now();
      } else {
        record.status = "conflict";
        record.error =
          "서버 파일이 저장 중 변경되었습니다. 이전 서버본과 로컬 수정본을 모두 보존했습니다.";
      }
      // Retain the original as history. Only our unpromoted upload may be removed.
      await this.removeStagedUpload(record, provider, paths.next);
      record.transaction = undefined;
      await this.save();
      return;
    }
    // No rename happened (or a rollback finished before the app stopped).
    await this.cleanStaging(record, provider, paths);
    record.transaction = undefined;
    record.status = target === record.baseline ? "pending" : "conflict";
    if (record.status === "conflict")
      record.error = "서버 파일도 변경되었습니다. 로컬 수정본을 확인해 주세요.";
    await this.save();
  }
  private async cleanStaging(
    record: Record,
    provider: Provider,
    paths: { folder: string; next: string },
  ) {
    await this.removeStagedUpload(record, provider, paths.next);
    if (await exists(provider, paths.folder))
      await provider.rmdir(paths.folder);
  }
  private async removeStagedUpload(
    record: Record,
    provider: Provider,
    next: string,
  ) {
    if (await exists(provider, next)) {
      try {
        await fs.lstat(this.localPath(record));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const { bytes } = await remoteBytes(provider, next);
        if (digest(bytes) !== record.transaction!.digest)
          throw new Conflict(
            "서버의 임시 수정본이 변경되었습니다. 복구 파일을 보존합니다.",
          );
        // Preserve the last upload if an interrupted editor removed its cache.
        // Publish complete bytes exclusively; an editor's new save wins the race.
        await durableExclusiveFile(this.localPath(record), bytes);
      }
      await provider.unlink(next);
    }
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.lock(async () => {
      for (const record of this.records.filter((r) => r.enabled)) {
        try {
          if (
            digest(await this.localBytes(record)) !== record.baseline &&
            record.status === "clean"
          )
            record.status = "pending";
        } catch (error) {
          record.status = "error";
          record.error = error instanceof Error ? error.message : String(error);
        }
      }
      await this.save();
    });
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop();
    this.connections.removeListener("change", this.changedConnection);
  }
  unsettled() {
    return this.records.some((r) => r.enabled && r.status !== "clean");
  }
}
