import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Connections } from "./connections.js";
import type { Transfers } from "./transfers.js";
import type { Location, Transfer } from "../shared/types.js";

async function checkDownloadedTree(filename: string): Promise<void> {
  const info = await fs.lstat(filename);
  if (info.isSymbolicLink())
    throw new Error(
      "원격 폴더에 링크가 있습니다. 외부 앱에 잘못된 로컬 경로를 전달하지 않도록 링크를 제외하고 선택해 주세요.",
    );
  if (info.isDirectory())
    for (const name of await fs.readdir(filename))
      await checkDownloadedTree(path.join(filename, name));
}

/** Materialize remote files before handing them to an OS drag or application. */
export class ExternalFiles {
  constructor(
    private connections: Connections,
    private transfers: Transfers,
    private directory: string,
  ) {}

  private copy(source: Location, destination: string) {
    return new Promise<void>((resolve, reject) => {
      let id: string;
      const changed = (jobs: Transfer[]) => {
        const job = jobs.find((item) => item.id === id);
        if (!job || !["done", "error", "cancelled"].includes(job.status))
          return;
        this.transfers.off("change", changed);
        if (job.status === "done") resolve();
        else reject(new Error(job.error ?? "다운로드가 취소되었습니다."));
      };
      this.transfers.on("change", changed);
      try {
        id = this.transfers.start({
          source: [source],
          destination: { connectionId: "local", path: destination },
          move: false,
          conflict: "error",
        });
      } catch (error) {
        this.transfers.off("change", changed);
        reject(error);
      }
    });
  }

  async prepare(source: Location[]): Promise<string[]> {
    const files: string[] = [];
    const batch = path.join(this.directory, randomUUID());
    try {
      for (const [index, location] of source.entries()) {
        const provider = this.connections.get(location.connectionId);
        const absolute = this.connections.resolve(
          location.connectionId,
          location.path,
        );
        const info = await provider.stat(absolute);
        if (info.kind !== "file" && info.kind !== "directory")
          throw new Error(
            "외부로 꺼내기는 일반 파일과 폴더를 지원합니다. 링크는 먼저 실제 항목을 선택하세요.",
          );
        if (location.connectionId === "local") {
          files.push(absolute);
          continue;
        }
        const folder = path.join(batch, String(index));
        await fs.mkdir(folder, { recursive: true, mode: 0o700 });
        await this.copy({ ...location, path: absolute }, folder);
        const filename = path.join(folder, provider.paths.basename(absolute));
        await checkDownloadedTree(filename);
        files.push(filename);
      }
      return files;
    } catch (error) {
      await fs.rm(batch, { recursive: true, force: true });
      throw error;
    }
  }
}

// Scripts and executables are never launched through their file association.
export const textExtensions = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".conf",
  ".config",
  ".log",
  ".csv",
  ".tsv",
  ".xml",
  ".css",
  ".scss",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".java",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".sql",
]);
export const documentExtensions = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".tif",
  ".tiff",
  ".bmp",
  ".mp3",
  ".wav",
  ".m4a",
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
]);
