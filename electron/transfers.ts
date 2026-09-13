import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { exists, protectRoot, removeTree, type Provider } from "./providers.js";
import type { Entry, Transfer, TransferRequest } from "../shared/types.js";
import type { Connections } from "./connections.js";

type Manifest = { relative: string; info: Entry; target?: string }[];
const manifestBytes = (items: Manifest) =>
  items.reduce(
    (total, item) => total + (item.info.kind === "file" ? item.info.size : 0),
    0,
  );
const manifestSignature = (items: Manifest) =>
  items
    .map(
      ({ relative, info, target }) =>
        `${relative}\0${info.kind}\0${info.size}\0${info.modified}\0${target ?? ""}`,
    )
    .sort()
    .join("\n");
export class Transfers extends EventEmitter {
  jobs: Transfer[] = [];
  private controllers = new Map<string, AbortController>();
  private chain = Promise.resolve();
  constructor(private connections: Connections) {
    super();
  }
  start(request: TransferRequest) {
    const id = randomUUID();
    const job: Transfer = {
      ...request,
      id,
      label:
        request.source.length === 1
          ? this.connections
              .get(request.source[0].connectionId)
              .paths.basename(request.source[0].path)
          : `${request.source.length}개 항목`,
      status: "queued",
      bytes: 0,
      total: 0,
      files: 0,
      started: Date.now(),
    };
    this.jobs = [
      job,
      ...this.jobs
        .filter((j) => !["done", "cancelled", "error"].includes(j.status))
        .concat(
          this.jobs
            .filter((j) => ["done", "cancelled", "error"].includes(j.status))
            .slice(0, 49),
        ),
    ];
    this.controllers.set(id, new AbortController());
    this.changed();
    this.chain = this.chain.catch(() => {}).then(() => this.run(job, request));
    return id;
  }
  cancel(id: string) {
    this.controllers.get(id)?.abort();
  }
  private changed() {
    this.emit("change", this.jobs);
  }
  private async manifest(
    provider: Provider,
    p: string,
    signal: AbortSignal,
    relative = "",
  ): Promise<Manifest> {
    signal.throwIfAborted();
    const info = await provider.stat(p);
    if (info.kind === "other")
      throw new Error(`특수 파일은 전송할 수 없습니다: ${info.name}`);
    const result: Manifest = [
      {
        relative,
        info,
        target:
          info.kind === "symlink" ? await provider.readlink(p) : undefined,
      },
    ];
    if (info.kind === "directory")
      for (const child of await provider.list(p))
        result.push(
          ...(await this.manifest(
            provider,
            child.path,
            signal,
            provider.paths.join(relative, child.name),
          )),
        );
    return result;
  }
  private async run(job: Transfer, request: TransferRequest) {
    const controller = this.controllers.get(job.id)!;
    const signal = controller.signal;
    let staged: { provider: Provider; path: string } | undefined;
    try {
      signal.throwIfAborted();
      job.status = "running";
      this.changed();
      const dest = this.connections.get(request.destination.connectionId);
      const destFolder = await dest.realpath(request.destination.path);
      if ((await dest.stat(destFolder)).kind !== "directory")
        throw new Error("목적지가 폴더가 아닙니다.");
      const planned: {
        provider: Provider;
        source: string;
        target: string;
        manifest: Manifest;
        bytes: number;
        same: boolean;
      }[] = [];
      const reserved = new Set<string>();
      for (const location of request.source) {
        signal.throwIfAborted();
        const provider = this.connections.get(location.connectionId);
        const source = this.connections.resolve(
          location.connectionId,
          location.path,
        );
        protectRoot(provider, source);
        const sourceInfo = await provider.stat(source);
        const destinationId = request.destination.connectionId;
        const same = location.connectionId === destinationId;
        const sameEndpoint =
          same ||
          (location.connectionId !== "local" &&
            destinationId !== "local" &&
            this.connections.identity(location.connectionId) ===
              this.connections.identity(destinationId));
        if (sameEndpoint && sourceInfo.kind === "directory") {
          const canonical = await provider.realpath(source);
          const relative = provider.paths.relative(canonical, destFolder);
          if (
            relative === "" ||
            (!relative.startsWith(".." + provider.paths.sep) &&
              relative !== ".." &&
              !provider.paths.isAbsolute(relative))
          )
            throw new Error(
              "폴더를 자기 자신이나 하위 폴더로 전송할 수 없습니다.",
            );
        }
        let target = dest.paths.join(
          destFolder,
          provider.paths.basename(source),
        );
        if (same && source === target && request.move) continue;
        if (reserved.has(target) || (await exists(dest, target))) {
          if (request.conflict === "skip") continue;
          if (request.conflict === "error")
            throw new Error(
              `같은 이름의 항목이 있습니다: ${dest.paths.basename(target)}`,
            );
          const ext =
            sourceInfo.kind === "directory" ? "" : dest.paths.extname(target);
          const stem = dest.paths.basename(target, ext);
          let number = 2;
          do {
            target = dest.paths.join(destFolder, `${stem} (${number++})${ext}`);
          } while (reserved.has(target) || (await exists(dest, target)));
        }
        const manifest = await this.manifest(provider, source, signal);
        const bytes = manifestBytes(manifest);
        job.total += bytes;
        reserved.add(target);
        planned.push({ provider, source, target, manifest, bytes, same });
      }
      this.changed();
      for (const plan of planned) {
        signal.throwIfAborted();
        if (plan.same && request.move) {
          await dest.rename(plan.source, plan.target);
          job.files += plan.manifest.length;
          job.bytes += plan.bytes;
          this.changed();
          continue;
        }
        const temporary = dest.paths.join(
          destFolder,
          `.sinder-${randomUUID()}.partial`,
        );
        // Own the staging directory only after exclusive creation succeeds.
        // A failed open must never make cleanup remove someone else's file.
        await dest.mkdir(temporary);
        staged = { provider: dest, path: temporary };
        const stagedItem = dest.paths.join(temporary, "item");
        let lastNotification = 0;
        for (const item of plan.manifest) {
          signal.throwIfAborted();
          const output = item.relative
            ? dest.paths.join(
                stagedItem,
                ...item.relative.split(plan.provider.paths.sep),
              )
            : stagedItem;
          if (item.info.kind === "directory") await dest.mkdir(output);
          else if (item.info.kind === "symlink")
            await dest.symlink(item.target!, output);
          else {
            await pipeline(
              plan.provider.read(item.info.path),
              new Transform({
                transform: (chunk, _encoding, callback) => {
                  job.bytes += chunk.length;
                  if (Date.now() - lastNotification > 100) {
                    lastNotification = Date.now();
                    this.changed();
                  }
                  callback(null, chunk);
                },
              }),
              dest.write(output),
              { signal },
            );
            const copied = await dest.stat(output);
            if (copied.size !== item.info.size)
              throw new Error(
                `전송 중 원본 크기가 변경되었습니다: ${item.info.name}`,
              );
            await dest.chmod(output, item.info.mode);
          }
          job.files++;
          this.changed();
        }
        // Check the entire source again before publishing or deleting it.
        const after = await this.manifest(plan.provider, plan.source, signal);
        if (manifestSignature(after) !== manifestSignature(plan.manifest))
          throw new Error(
            "전송 중 원본이 변경되어 작업을 중단했습니다. 원본은 보존됩니다.",
          );
        signal.throwIfAborted();
        await dest.rename(stagedItem, plan.target);
        await dest.rmdir(temporary);
        staged = undefined;
        if (request.move) await removeTree(plan.provider, plan.source);
      }
      job.status = "done";
    } catch (error) {
      job.status = signal.aborted ? "cancelled" : "error";
      job.error = signal.aborted
        ? undefined
        : error instanceof Error
          ? error.message
          : String(error);
      if (staged)
        try {
          if (await exists(staged.provider, staged.path))
            await removeTree(staged.provider, staged.path);
        } catch {
          job.error =
            (job.error ?? "전송이 취소되었습니다.") +
            " 일부 임시 파일을 정리하지 못했습니다. 숨김 파일에서 .sinder-*.partial을 확인해 주세요.";
        }
    } finally {
      this.controllers.delete(job.id);
      this.changed();
    }
  }
  async idle() {
    await this.chain;
  }
  active() {
    return this.jobs.some(
      (j) => j.status === "queued" || j.status === "running",
    );
  }
}
