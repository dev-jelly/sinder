import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { durableExclusiveFile, durableJson } from "../electron/durable-json.js";

test("exclusive recovery preserves an existing editor cache", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-durable-"));
  try {
    const filename = path.join(directory, "document.txt");
    const original = Buffer.from("The editor saved this version.\n");
    await fs.writeFile(filename, original);

    await durableExclusiveFile(
      filename,
      Buffer.from("Recovered old version.\n"),
    );

    assert.deepEqual(await fs.readFile(filename), original);
    assert.deepEqual(await fs.readdir(directory), ["document.txt"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("concurrent recovery publishers leave exactly one complete version", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-durable-"));
  try {
    const filename = path.join(directory, "document.txt");
    const versions = [
      Buffer.alloc(256 * 1024 + 13, 0x41),
      Buffer.alloc(512 * 1024 + 7, 0x42),
    ];

    await Promise.all(
      versions.map((bytes) => durableExclusiveFile(filename, bytes)),
    );

    const winner = await fs.readFile(filename);
    assert.ok(
      versions.some((bytes) => bytes.equals(winner)),
      "the cache must contain one entire submitted version",
    );
    await durableExclusiveFile(
      filename,
      Buffer.from("A later publisher must lose."),
    );
    assert.deepEqual(await fs.readFile(filename), winner);
    assert.deepEqual(await fs.readdir(directory), ["document.txt"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a partial temporary write never publishes a partial cache and can be retried", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-durable-"));
  const filename = path.join(directory, "document.txt");
  const bytes = Buffer.from("The complete recovered editor version.\n");
  const originalOpen = fs.open;
  let partialWritten: Buffer | undefined;
  try {
    context.mock.method(
      fs,
      "open",
      async (
        openedPath: Parameters<typeof fs.open>[0],
        flags: Parameters<typeof fs.open>[1],
        mode?: Parameters<typeof fs.open>[2],
      ) => {
        const file = await originalOpen(openedPath, flags, mode);
        if (flags === "wx") {
          context.mock.method(file, "writeFile", async () => {
            await file.write(bytes.subarray(0, 7));
            partialWritten = await fs.readFile(openedPath);
            throw Object.assign(new Error("Injected partial write failure"), {
              code: "ENOSPC",
            });
          });
        }
        return file;
      },
    );

    await assert.rejects(durableExclusiveFile(filename, bytes), {
      code: "ENOSPC",
    });
    context.mock.restoreAll();

    assert.deepEqual(partialWritten, bytes.subarray(0, 7));
    await assert.rejects(fs.lstat(filename), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(directory), []);

    await durableExclusiveFile(filename, bytes);
    assert.deepEqual(await fs.readFile(filename), bytes);
    assert.deepEqual(await fs.readdir(directory), ["document.txt"]);
  } finally {
    context.mock.restoreAll();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("JSON write, sync and rename failures preserve the original and remove staging", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-json-"));
  const filename = path.join(directory, "settings.json");
  const originalOpen = fs.open;
  try {
    for (const phase of ["writeFile", "sync", "rename"] as const) {
      await fs.writeFile(filename, '{"version":"original"}');
      const failure = Object.assign(new Error(`Injected ${phase} failure`), {
        code: "EIO",
      });
      if (phase === "rename")
        context.mock.method(fs, "rename", async () => {
          throw failure;
        });
      else
        context.mock.method(
          fs,
          "open",
          async (
            openedPath: Parameters<typeof fs.open>[0],
            flags: Parameters<typeof fs.open>[1],
            mode?: Parameters<typeof fs.open>[2],
          ) => {
            const file = await originalOpen(openedPath, flags, mode);
            if (flags === "wx")
              context.mock.method(file, phase, async () => {
                throw failure;
              });
            return file;
          },
        );

      await assert.rejects(durableJson(filename, { version: "replacement" }), {
        code: "EIO",
      });
      context.mock.restoreAll();
      assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), {
        version: "original",
      });
      assert.deepEqual(await fs.readdir(directory), ["settings.json"]);
      await durableJson(filename, { version: "retry" });
      assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), {
        version: "retry",
      });
    }
  } finally {
    context.mock.restoreAll();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
