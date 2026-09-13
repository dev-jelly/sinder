import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

async function syncDirectory(directoryPath: string) {
  // Windows does not support opening directories through this Node API.
  if (process.platform === "win32") return;
  const directory = await fs.open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

// Flush the write-ahead journal before changing the remote file's name.
export async function durableJson(filename: string, value: unknown) {
  const temporary = filename + "." + randomUUID() + ".tmp";
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const file = await fs.open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(temporary, filename);
    // Persist the replacement directory entry before changing any remote names.
    await syncDirectory(path.dirname(filename));
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

// Publish complete recovered bytes without overwriting an editor's saved file.
export async function durableExclusiveFile(filename: string, bytes: Buffer) {
  const directoryPath = path.dirname(filename);
  const temporary = path.join(directoryPath, `.${randomUUID()}.tmp`);
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const file = await fs.open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await fs.link(temporary, filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await syncDirectory(directoryPath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
