import fs from "node:fs/promises";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { SFTPWrapper, Stats as SftpStats } from "ssh2";
import type { Entry } from "../shared/types.js";

export interface Provider {
  home: string;
  paths: typeof path.posix;
  list(p: string): Promise<Entry[]>;
  stat(p: string): Promise<Entry>;
  realpath(p: string): Promise<string>;
  mkdir(p: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
  rmdir(p: string): Promise<void>;
  readlink(p: string): Promise<string>;
  symlink(target: string, p: string): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
  read(p: string): Readable;
  write(p: string): Writable;
}

function entry(p: string, stats: Stats | SftpStats, paths = path.posix): Entry {
  const name = paths.basename(p);
  return {
    name,
    path: p,
    kind: stats.isSymbolicLink()
      ? "symlink"
      : stats.isDirectory()
        ? "directory"
        : stats.isFile()
          ? "file"
          : "other",
    size: stats.size,
    modified: "mtimeMs" in stats ? stats.mtimeMs : stats.mtime * 1000,
    mode: stats.mode,
    hidden: name.startsWith("."),
  };
}

export class LocalProvider implements Provider {
  paths = path;
  constructor(public home: string) {}
  async list(p: string) {
    const names = await fs.readdir(p);
    const results: Entry[] = [];
    // Bound concurrent metadata requests for large folders and mounted volumes.
    for (let i = 0; i < names.length; i += 64) {
      const batch = await Promise.all(
        names.slice(i, i + 64).map(async (name) => {
          try {
            return await this.stat(path.join(p, name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        }),
      );
      results.push(...batch.filter((e): e is Entry => e !== null));
    }
    return results;
  }
  async stat(p: string) {
    return entry(p, await fs.lstat(p), path);
  }
  realpath(p: string) {
    return fs.realpath(p);
  }
  async mkdir(p: string) {
    await fs.mkdir(p);
  }
  async rename(from: string, to: string) {
    if (await exists(this, to))
      throw new Error("같은 이름의 항목이 이미 있습니다.");
    const info = await this.stat(from);
    if (info.kind === "file" || info.kind === "symlink") {
      // link fails with EEXIST instead of silently replacing an existing file.
      await fs.link(from, to);
      try {
        await fs.unlink(from);
      } catch (error) {
        await fs.unlink(to).catch(() => {});
        throw error;
      }
    } else {
      await fs.rename(from, to);
    }
  }
  async unlink(p: string) {
    await fs.unlink(p);
  }
  async rmdir(p: string) {
    await fs.rmdir(p);
  }
  readlink(p: string) {
    return fs.readlink(p);
  }
  async symlink(target: string, p: string) {
    await fs.symlink(target, p);
  }
  async chmod(p: string, mode: number) {
    await fs.chmod(p, mode & 0o777);
  }
  read(p: string) {
    return createReadStream(p);
  }
  write(p: string) {
    return createWriteStream(p, { flags: "wx", mode: 0o600 });
  }
}

export class SftpProvider implements Provider {
  paths = path.posix;
  constructor(
    public home: string,
    private sftp: SFTPWrapper,
  ) {}
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error("서버 응답 시간이 초과되었습니다. 다시 연결해 주세요."),
        );
      }, 30000);
      const closed = () => {
        cleanup();
        reject(new Error("SSH 연결이 끊어졌습니다. 다시 연결해 주세요."));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.sftp.removeListener("close", closed);
      };
      this.sftp.once("close", closed);
      const callback = (err: Error | null, result: T) => {
        cleanup();
        err ? reject(err) : resolve(result);
      };
      try {
        (this.sftp as unknown as Record<string, (...args: unknown[]) => void>)[
          method
        ](...args, callback);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
  async list(p: string) {
    const files = await this.call<{ filename: string; attrs: SftpStats }[]>(
      "readdir",
      p,
    );
    return files
      .filter((f) => f.filename !== "." && f.filename !== "..")
      .map((f) => entry(path.posix.join(p, validName(f.filename)), f.attrs));
  }
  async stat(p: string) {
    return entry(p, await this.call<SftpStats>("lstat", p));
  }
  realpath(p: string) {
    return this.call<string>("realpath", p);
  }
  mkdir(p: string) {
    return this.call<void>("mkdir", p);
  }
  async rename(from: string, to: string) {
    if (await exists(this, to))
      throw new Error("같은 이름의 항목이 이미 있습니다.");
    await this.call<void>("rename", from, to);
  }
  unlink(p: string) {
    return this.call<void>("unlink", p);
  }
  rmdir(p: string) {
    return this.call<void>("rmdir", p);
  }
  readlink(p: string) {
    return this.call<string>("readlink", p);
  }
  symlink(target: string, p: string) {
    return this.call<void>("symlink", target, p);
  }
  chmod(p: string, mode: number) {
    return this.call<void>("chmod", p, mode & 0o777);
  }
  read(p: string) {
    return this.sftp.createReadStream(p);
  }
  write(p: string) {
    return this.sftp.createWriteStream(p, { flags: "wx", mode: 0o600 });
  }
}

export async function exists(provider: Provider, p: string) {
  try {
    await provider.stat(p);
    return true;
  } catch (error) {
    const code = (error as { code: unknown }).code;
    if (code === "ENOENT" || code === 2) return false;
    throw error;
  }
}

export function validName(name: string) {
  if (!name.trim() || name === "." || name === ".." || /[\/\\\0]/.test(name))
    throw new Error("파일 이름에 경로 구분자나 빈 이름을 사용할 수 없습니다.");
  if (
    process.platform === "win32" &&
    /[<>:"|?*]|[. ]$|^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)
  )
    throw new Error("Windows에서 사용할 수 없는 이름입니다.");
  return name;
}

export function protectRoot(provider: Provider, p: string) {
  if (provider.paths.dirname(p) === p)
    throw new Error("파일 시스템 루트에는 이 작업을 할 수 없습니다.");
}

export async function removeTree(provider: Provider, p: string) {
  protectRoot(provider, p);
  const info = await provider.stat(p);
  if (info.kind === "directory") {
    for (const child of await provider.list(p))
      await removeTree(provider, child.path);
    await provider.rmdir(p);
  } else await provider.unlink(p);
}
