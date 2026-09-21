import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { installScreenshotFixture } from "./screenshot-fixture.mjs";

const dist = path.resolve("dist");
const output = path.resolve("docs/screenshots");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    const file = path.resolve(
      dist,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!file.startsWith(`${dist}${path.sep}`))
      throw new Error("Invalid asset path");
    response.writeHead(200, {
      "Content-Type": mime[path.extname(file)] ?? "application/octet-stream",
    });
    response.end(await fs.readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await fs.mkdir(output, { recursive: true });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, theme, split] of [
    ["workspace", "light", false],
    ["split-view", "dark", true],
    ["ssh-config", "light", false],
  ]) {
    const context = await browser.newContext({
      viewport: { width: 1240, height: 760 },
      deviceScaleFactor: 1,
      colorScheme: theme,
    });
    await context.addInitScript(installScreenshotFixture, { theme, split });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page
      .getByRole("option", { name: "release-notes.md", exact: true })
      .last()
      .waitFor();
    if (name === "ssh-config") {
      await page
        .getByRole("button", { name: "SSH 연결 추가", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "로컬 SSH 호스트" })
        .selectOption("dev-server");
    } else {
      await page
        .getByRole("button", { name: "숨김 파일", exact: true })
        .click();
      await page
        .getByRole("option", { name: "release-notes.md", exact: true })
        .last()
        .click();
    }
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    if (errors.length) throw new Error(errors.join("\n"));
    await context.close();
    console.log(`Captured ${name}.png with public demo data`);
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
