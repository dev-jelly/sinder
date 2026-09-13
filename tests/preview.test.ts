import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalProvider } from "../electron/providers.js";
import { preview } from "../electron/preview.js";

test("preview preserves text limits, image bounds, binary and symlink handling", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-preview-"));
  const provider = new LocalProvider(directory);
  const filename = path.join(directory, "document.txt");
  try {
    await fs.writeFile(filename, "hello");
    assert.deepEqual(await preview(provider, filename), {
      kind: "text",
      content: "hello",
      truncated: false,
    });
    await fs.writeFile(filename, "a".repeat(128 * 1024 + 1));
    const truncated = await preview(provider, filename);
    assert.equal(truncated.kind, "text");
    assert.equal(truncated.content.length, 128 * 1024);
    assert.equal(truncated.truncated, true);
    await fs.writeFile(filename, Buffer.from([1, 0, 2]));
    assert.equal((await preview(provider, filename)).kind, "unsupported");
    const image = path.join(directory, "image.PNG");
    await fs.writeFile(image, "image bytes");
    assert.deepEqual(await preview(provider, image), {
      kind: "image",
      content: `data:image/png;base64,${Buffer.from("image bytes").toString("base64")}`,
    });
    await fs.truncate(image, 8 * 1024 * 1024 + 1);
    assert.equal((await preview(provider, image)).kind, "unsupported");
    const link = path.join(directory, "link");
    await fs.symlink("document.txt", link);
    assert.deepEqual(await preview(provider, link), {
      kind: "unsupported",
      content: "링크 대상: document.txt",
    });
    assert.equal((await preview(provider, directory)).kind, "unsupported");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
