import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import fs from "node:fs/promises";
import net, { type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { startSshd } from "./sshd";

const modifier = process.platform === "darwin" ? "Meta" : "Control";
const appPath = process.env.SINDER_E2E_APP ?? process.cwd();

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-desktop-"));
  const home = path.join(root, "Workspace");
  await fs.mkdir(home);
  for (const folder of [
    "Desktop",
    "Documents",
    "Downloads",
    "Projects",
    "Design assets",
  ])
    await fs.mkdir(path.join(home, folder));
  await fs.writeFile(
    path.join(home, "Project notes.md"),
    "# Sinder\n로컬과 원격을 하나의 작업 공간으로.\n",
  );
  await fs.writeFile(
    path.join(home, "package.json"),
    JSON.stringify({ name: "workspace", version: "1.0.0" }, null, 2),
  );
  await fs.writeFile(path.join(home, ".hidden-config"), "hidden");
  const app = await electron.launch({
    args: [appPath],
    cwd: appPath,
    executablePath: process.env.SINDER_ELECTRON_EXECUTABLE,
    env: {
      ...process.env,
      SINDER_DATA_DIR: path.join(root, "settings"),
      SINDER_HOME: home,
    },
  });
  const page = await app.firstWindow({ timeout: 180000 });
  await page.waitForURL("**/dist/index.html", {
    waitUntil: "domcontentloaded",
    timeout: 180000,
  });
  await expect(
    page.getByRole("option", { name: "Project notes.md", exact: true }),
  ).toBeVisible();
  return {
    root,
    home,
    app,
    page,
    close: async () => {
      await app.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("local SSH config fills fields, imports disconnected locations and avoids duplicates", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.home, ".ssh"));
    await fs.writeFile(
      path.join(f.home, ".ssh/config"),
      'Include hosts.conf\nHost workstation alternate\n HostName 192.0.2.10\n User developer\n Port 2222\n IdentityFile "~/.ssh/work key"\n ProxyCommand /usr/bin/nc %h %p\n',
    );
    await fs.writeFile(
      path.join(f.home, ".ssh/hosts.conf"),
      "Host included\n HostName 192.0.2.11\n User worker\n",
    );
    await f.page
      .getByRole("button", { name: "SSH 연결 추가", exact: true })
      .click();
    const dialog = f.page.getByRole("dialog");
    await expect(
      dialog.getByRole("textbox", { name: "호스트", exact: true }),
    ).toBeFocused();
    await expect(
      dialog
        .getByRole("combobox", { name: "로컬 SSH 호스트" })
        .locator("option"),
    ).toHaveCount(3);
    await dialog
      .getByRole("combobox", { name: "로컬 SSH 호스트" })
      .selectOption("workstation");
    await expect(
      dialog.getByRole("textbox", { name: "호스트", exact: true }),
    ).toHaveValue("192.0.2.10");
    await expect(dialog.getByRole("spinbutton", { name: "포트" })).toHaveValue(
      "2222",
    );
    await expect(
      dialog.getByRole("textbox", { name: "사용자 이름" }),
    ).toHaveValue("developer");
    await expect(
      dialog.getByRole("textbox", { name: "키 파일", exact: true }),
    ).toHaveValue(path.join(f.home, ".ssh/work key"));
    await f.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(860, 580),
    );
    await dialog
      .getByRole("button", { name: "모두 추가", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      f.page.getByRole("button", {
        name: "workstation 192.0.2.10",
        exact: true,
      }),
    ).toBeVisible();
    let data = await f.page.evaluate(() => window.sinder.bootstrap());
    expect(data.profiles).toHaveLength(2);
    const imported = await f.page.evaluate(() => window.sinder.readSshConfig());
    expect(imported.entries.map((entry) => entry.profile.id)).toEqual(
      data.profiles.map((profile) => profile.id),
    );
    expect(
      data.connections
        .filter((connection) => connection.kind === "ssh")
        .every((connection) => connection.status === "disconnected"),
    ).toBe(true);
    await f.page
      .getByRole("button", { name: "SSH 연결 추가", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "모두 추가", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    data = await f.page.evaluate(() => window.sinder.bootstrap());
    expect(data.profiles).toHaveLength(2);
    const saved = JSON.parse(
      await fs.readFile(path.join(f.root, "settings/settings.json"), "utf8"),
    );
    expect(
      saved.profiles.map(
        (profile: { sshConfigHost: string }) => profile.sshConfigHost,
      ),
    ).toEqual(["included", "workstation"]);
  } finally {
    await f.close();
  }
});

test("desktop local workflow: navigation, selection, preview, split copy, rename, hidden files and tabs", async () => {
  const { root, home, page, app, close } = await fixture();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    expect(
      await page.evaluate(
        () => typeof (window as unknown as { require: unknown }).require,
      ),
    ).toBe("undefined");
    await page
      .getByRole("option", { name: "Project notes.md", exact: true })
      .click();
    await page.keyboard.press("Space");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("pre")).toContainText("로컬과 원격");
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "새 폴더 (⌘⇧N)", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "이름", exact: true })
      .fill("새 프로젝트");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(
      page.getByRole("option", { name: "새 프로젝트", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("option", { name: "새 프로젝트", exact: true })
      .click();
    await page.keyboard.press("F2");
    await page
      .getByRole("textbox", { name: "이름", exact: true })
      .fill("완료 프로젝트");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(
      page.getByRole("option", { name: "완료 프로젝트", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "분할 보기 (⌘\\)", exact: true })
      .click();
    await expect(page.locator(".pane")).toHaveCount(2);
    const left = page.locator(".pane").nth(0);
    const right = page.locator(".pane").nth(1);
    await right
      .getByRole("option", { name: "Downloads", exact: true })
      .dblclick();
    await expect(
      right.getByText("비어 있는 폴더", { exact: true }),
    ).toBeVisible();
    await left
      .getByRole("option", { name: "Project notes.md", exact: true })
      .click();
    await page.keyboard.press("Meta+c");
    await expect(page.locator(".workspace-status")).toContainText(
      "1개 항목 복사 준비",
    );
    await right.locator(".file-area").click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Meta+v");
    await expect(
      right.getByRole("option", { name: "Project notes.md", exact: true }),
    ).toBeVisible();
    expect(
      await fs.readFile(path.join(home, "Downloads/Project notes.md"), "utf8"),
    ).toContain("Sinder");
    await page.keyboard.press("Meta+v");
    await expect(page.getByRole("dialog")).toContainText("같은 이름의 항목");
    await page.getByRole("button", { name: "계속", exact: true }).click();
    await expect(
      right.getByRole("option", { name: "Project notes (2).md", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "전송 패널 닫기", exact: true })
      .click();
    await page.getByRole("button", { name: "숨김 파일", exact: true }).click();
    await expect(
      left.getByRole("option", { name: ".hidden-config", exact: true }),
    ).toBeVisible();
    await left
      .getByRole("textbox", { name: "이 폴더에서 검색" })
      .fill("package");
    await expect(left.getByRole("listbox").getByRole("option")).toHaveCount(1);
    await left.getByRole("textbox", { name: "이 폴더에서 검색" }).fill("");
    await right
      .getByRole("button", { name: "이 폴더 즐겨찾기", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Downloads 즐겨찾기 제거" }),
    ).toBeVisible();
    expect(
      (await page.evaluate(() => window.sinder.bootstrap())).bookmarks[0]
        .location.path,
    ).toBe(await fs.realpath(path.join(home, "Downloads")));
    await page
      .getByRole("button", { name: "Workspace 펼치기", exact: true })
      .click();
    await expect(
      page
        .getByRole("tree")
        .getByRole("button", { name: "Projects", exact: true }),
    ).toBeVisible();
    const external = path.join(root, "Finder import.txt");
    await fs.writeFile(external, "Native file drop through Electron webUtils");
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "drop-fixture";
      input.hidden = true;
      document.body.appendChild(input);
    });
    await page.locator("#drop-fixture").setInputFiles(external);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#drop-fixture")!;
      const transfer = new DataTransfer();
      transfer.items.add(input.files![0]);
      document.querySelector(".pane-active .file-area")!.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
      input.remove();
    });
    await expect(
      page
        .locator(".pane-active")
        .getByRole("option", { name: "Finder import.txt", exact: true }),
    ).toBeVisible();
    expect(
      await fs.readFile(
        path.join(home, "Downloads", "Finder import.txt"),
        "utf8",
      ),
    ).toContain("Native file drop");
    await page.getByRole("button", { name: "새 탭 (⌘T)", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await page.keyboard.press("Meta+l");
    await page
      .getByRole("textbox", { name: "폴더 경로", exact: true })
      .fill(home);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("option", { name: "Project notes.md", exact: true }),
    ).toBeVisible();
    expect(
      (await page.evaluate(() => window.sinder.bootstrap())).bookmarks[0]
        .location.path,
    ).toBe(await fs.realpath(path.join(home, "Downloads")));
    await page.screenshot({ path: "test-results/local-light.png" });
    await page.getByRole("button", { name: "화면 테마: system" }).click();
    await page.getByRole("button", { name: "화면 테마: light" }).click();
    await page.screenshot({ path: "test-results/local-dark.png" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(900, 650),
    );
    await expect(
      page.getByRole("button", { name: "복사 (⌘C)", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/compact.png" });
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test("desktop SSH workflow through connection form and split-pane transfer", async () => {
  const sshd = await startSshd();
  const { home, page, app, close } = await fixture();
  try {
    const remote = path.join(sshd.root, "Remote workspace");
    await fs.mkdir(remote);
    await fs.writeFile(path.join(remote, "server.txt"), "실제 OpenSSH 서버");
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (
        _window: unknown,
        options?: { message?: string },
      ) => ({ response: 1, checkboxChecked: false });
    });
    await page
      .getByRole("button", { name: "분할 보기 (⌘\\)", exact: true })
      .click();
    const left = page.locator(".pane").nth(0);
    const right = page.locator(".pane").nth(1);
    await right.locator(".file-area").click({ position: { x: 20, y: 400 } });
    await page
      .getByRole("button", { name: "SSH 연결 추가", exact: true })
      .first()
      .click();
    await page.getByRole("textbox", { name: "연결 이름" }).fill("테스트 서버");
    await page
      .getByRole("textbox", { name: "호스트", exact: true })
      .fill("127.0.0.1");
    await page
      .getByRole("spinbutton", { name: "포트", exact: true })
      .fill(String(sshd.port));
    await page
      .getByRole("textbox", { name: "사용자 이름", exact: true })
      .fill(sshd.username);
    await page.getByLabel("인증 방식").selectOption("key");
    await page
      .getByRole("textbox", { name: "키 파일", exact: true })
      .fill(sshd.key);
    await page
      .getByRole("textbox", { name: "시작 폴더", exact: true })
      .fill(remote);
    await page.getByRole("button", { name: "연결", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      right.getByRole("option", { name: "server.txt", exact: true }),
    ).toBeVisible();
    await left
      .getByRole("option", { name: "Project notes.md", exact: true })
      .click();
    await page.getByRole("button", { name: "복사 (⌘C)", exact: true }).click();
    await right.locator(".file-area").click({ position: { x: 20, y: 150 } });
    await page
      .getByRole("button", { name: "붙여넣기 (⌘V)", exact: true })
      .click();
    await expect(
      right.getByRole("option", { name: "Project notes.md", exact: true }),
    ).toBeVisible();
    expect(
      await fs.readFile(path.join(remote, "Project notes.md"), "utf8"),
    ).toContain("로컬과 원격");
    await right
      .getByRole("option", { name: "server.txt", exact: true })
      .dblclick();
    await expect(page.locator("pre")).toContainText("실제 OpenSSH 서버");
    await page.keyboard.press("Escape");
    await page.screenshot({ path: "test-results/ssh-split.png" });
    await right
      .getByRole("option", { name: "server.txt", exact: true })
      .click();
    await page.keyboard.press("F2");
    await page
      .getByRole("textbox", { name: "이름", exact: true })
      .fill("renamed.txt");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(
      right.getByRole("option", { name: "renamed.txt", exact: true }),
    ).toBeVisible();
    await right
      .getByRole("option", { name: "renamed.txt", exact: true })
      .click();
    await page.keyboard.press("Delete");
    await expect(
      right.getByRole("option", { name: "renamed.txt", exact: true }),
    ).toHaveCount(0);
    const trash = path.join(sshd.root, ".sinder-trash");
    const batch = (await fs.readdir(trash))[0];
    expect(
      await fs.readFile(path.join(trash, batch, "renamed.txt"), "utf8"),
    ).toBe("실제 OpenSSH 서버");
    await page.keyboard.press("Meta+l");
    await right
      .getByRole("textbox", { name: "폴더 경로", exact: true })
      .fill(path.join(trash, batch));
    await page.keyboard.press("Enter");
    await right
      .getByRole("option", { name: "renamed.txt", exact: true })
      .click();
    await page.keyboard.press("Meta+x");
    await page.keyboard.press("Meta+l");
    await right
      .getByRole("textbox", { name: "폴더 경로", exact: true })
      .fill(remote);
    await page.keyboard.press("Enter");
    await expect(
      right.getByRole("option", { name: "Project notes.md", exact: true }),
    ).toBeVisible();
    await right.locator(".file-area").click({ position: { x: 20, y: 120 } });
    await page.keyboard.press("Meta+v");
    await expect(
      right.getByRole("option", { name: "renamed.txt", exact: true }),
    ).toBeVisible();
    expect(await fs.readFile(path.join(remote, "renamed.txt"), "utf8")).toBe(
      "실제 OpenSSH 서버",
    );
    await page
      .getByRole("button", { name: "테스트 서버 연결 메뉴", exact: true })
      .click();
    await page.getByRole("button", { name: "연결 해제", exact: true }).click();
    await expect(
      right.getByRole("button", { name: "다시 연결", exact: true }),
    ).toBeVisible();
    expect(
      await fs.readFile(path.join(home, "Project notes.md"), "utf8"),
    ).toContain("Sinder");
  } finally {
    await close();
    await sshd.close();
  }
});

test("compact window keeps files readable and remembers sidebar and inspector choices", async () => {
  const { app, page, close } = await fixture();
  try {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(860, 580),
    );
    const notes = page.getByRole("option", {
      name: "Project notes.md",
      exact: true,
    });
    await expect(page.locator(".inspector")).toHaveCount(0);
    await expect
      .poll(async () => (await page.getByRole("listbox").boundingBox())!.y)
      .toBeLessThanOrEqual(200);
    const metrics = await notes.evaluate((row) => ({
      rowHeight: row.getBoundingClientRect().height,
      nameSize: parseFloat(
        getComputedStyle(row.querySelector(".name-cell > span")!).fontSize,
      ),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.rowHeight).toBeLessThanOrEqual(30);
    expect(metrics.nameSize).toBeGreaterThanOrEqual(13);
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);

    await page.getByRole("button", { name: "사이드바", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await page.reload();
    await expect(notes).toBeVisible();
    await expect(page.locator(".sidebar")).toBeHidden();
    await notes.click();
    await page.getByRole("button", { name: "정보 패널", exact: true }).click();
    await expect(page.locator(".inspector")).toBeVisible();
    await expect(page.locator(".inspector h2")).toHaveText("Project notes.md");
    await page.reload();
    await expect(notes).toBeVisible();
    await expect(page.locator(".inspector")).toBeVisible();
    await page
      .getByRole("button", { name: "정보 패널 닫기", exact: true })
      .click();

    await page.keyboard.press(`${modifier}+b`);
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.keyboard.press(`${modifier}+\\`);
    await expect(page.getByRole("listbox")).toHaveCount(2);
    await page.keyboard.press(`${modifier}+i`);
    await expect(page.locator(".inspector")).toBeVisible();
    const closeInspector = page.getByRole("button", {
      name: "정보 패널 닫기",
      exact: true,
    });
    await expect(closeInspector).toBeInViewport();
    await closeInspector.click();
    await expect(page.locator(".inspector")).toHaveCount(0);
    await expect(page.getByRole("listbox").nth(0)).toBeVisible();
    await expect(page.getByRole("listbox").nth(1)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: "test-results/compact-860.png" });
  } finally {
    await close();
  }
});

test("keyboard selection, pane focus and activity panels stay aligned with file operations", async () => {
  const { home, page, close } = await fixture();
  try {
    const otherText = "Selected from the other pane\n";
    await fs.writeFile(
      path.join(home, "Downloads", "Other pane.txt"),
      otherText,
    );
    const copyButton = page.getByRole("button", { name: /^복사 \(/ });

    await page
      .getByRole("option", { name: "Project notes.md", exact: true })
      .click();
    await page.getByRole("tab").click();
    await expect(copyButton).toBeEnabled();
    await expect(
      page.getByRole("listbox").getByRole("option", { selected: true }),
    ).toHaveCount(1);
    await page.keyboard.press(`${modifier}+t`);
    await expect(page.getByRole("tab")).toHaveCount(2);
    await page
      .getByRole("option", { name: "Project notes.md", exact: true })
      .click();
    await page
      .locator(".tab")
      .first()
      .getByRole("button", { name: "탭 닫기", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(copyButton).toBeEnabled();
    await expect(
      page.getByRole("listbox").getByRole("option", { selected: true }),
    ).toHaveAttribute("aria-label", "Project notes.md");

    const hiddenToggle = page.getByRole("button", {
      name: "숨김 파일",
      exact: true,
    });
    await hiddenToggle.click();
    await page
      .getByRole("option", { name: ".hidden-config", exact: true })
      .click();
    await hiddenToggle.click();
    await expect(
      page.getByRole("option", { name: ".hidden-config", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("listbox").getByRole("option", { selected: true }),
    ).toHaveCount(0);
    await expect(copyButton).toBeDisabled();
    expect(await fs.readFile(path.join(home, ".hidden-config"), "utf8")).toBe(
      "hidden",
    );

    const tree = page.getByRole("tree", { name: "폴더 트리" });
    await page
      .getByRole("option", { name: "Project notes.md", exact: true })
      .click();
    const treeRoot = tree.getByRole("treeitem", {
      name: "Workspace",
      exact: true,
    });
    await treeRoot.focus();
    await page.keyboard.press("Delete");
    await page.keyboard.press("F2");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      await fs.readFile(path.join(home, "Project notes.md"), "utf8"),
    ).toContain("Sinder");
    await page.keyboard.press("ArrowRight");
    await expect(treeRoot).toHaveAttribute("aria-expanded", "true");
    await expect(tree.getByRole("treeitem")).toHaveCount(6);
    await page.keyboard.press("ArrowDown");
    await expect(tree.getByRole("treeitem").nth(1)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(treeRoot).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      tree.getByRole("treeitem", { name: "Projects", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(treeRoot).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(treeRoot).toHaveAttribute("aria-expanded", "false");

    await page.keyboard.press(`${modifier}+\\`);
    const left = page.locator(".pane").nth(0);
    const right = page.locator(".pane").nth(1);
    const leftList = left.getByRole("listbox");
    const rightList = right.getByRole("listbox");
    const leftFilter = left.getByRole("textbox", { name: "이 폴더에서 검색" });
    await leftList.focus();
    await page.keyboard.press(`${modifier}+f`);
    await expect(leftFilter).toBeFocused();
    await leftFilter.fill("package");
    await expect(left.getByRole("listbox").getByRole("option")).toHaveCount(1);
    await expect(
      right.getByRole("option", { name: "Project notes.md", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(leftFilter).toHaveValue("");
    await expect(leftList).toBeFocused();

    await page.keyboard.press("Home");
    const anchor = await leftList
      .getByRole("option", { selected: true })
      .getAttribute("aria-label");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(leftList.getByRole("option", { selected: true })).toHaveCount(
      2,
    );
    await page.keyboard.press("Shift+ArrowUp");
    await expect(leftList.getByRole("option", { selected: true })).toHaveCount(
      1,
    );
    await expect(
      leftList.getByRole("option", { selected: true }),
    ).toHaveAttribute("aria-label", anchor!);

    await right
      .getByRole("option", { name: "Downloads", exact: true })
      .dblclick();
    await expect(
      right.getByRole("option", { name: "Other pane.txt", exact: true }),
    ).toBeVisible();
    await left
      .getByRole("option", { name: "Project notes.md", exact: true })
      .click();
    await leftList.focus();
    await page.keyboard.press("Tab");
    await expect(right).toHaveClass(/pane-active/);
    await rightList.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("Space");
    await expect(page.getByRole("dialog")).toContainText("Other pane.txt");
    await expect(page.locator("pre")).toHaveText(otherText);
    await page.keyboard.press("Escape");
    await expect(rightList).toBeFocused();

    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "파일 작업" });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: /^열기 \/ 미리보기/ }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: /^복사/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(rightList).toBeFocused();
    await page.keyboard.press(`${modifier}+c`);

    await left
      .getByRole("option", { name: "Projects", exact: true })
      .dblclick();
    await expect(
      left.getByText("비어 있는 폴더", { exact: true }),
    ).toBeVisible();
    await left.getByRole("button", { name: "새 폴더", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "새 폴더", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "원격 편집 작업 보기", exact: true })
      .click();
    await expect(page.locator(".edits-panel")).toBeVisible();
    await leftList.focus();
    await page.keyboard.press(`${modifier}+v`);
    await expect(
      left.getByRole("option", { name: "Other pane.txt", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".transfers-panel")).toBeVisible();
    await expect(page.locator(".edits-panel")).toHaveCount(0);
    expect(
      await fs.readFile(path.join(home, "Projects", "Other pane.txt"), "utf8"),
    ).toBe(otherText);
    expect(
      await fs.readFile(path.join(home, "Downloads", "Other pane.txt"), "utf8"),
    ).toBe(otherText);
  } finally {
    await close();
  }
});

test("canceling an unresponsive SSH handshake closes promptly without saving a profile", async () => {
  const sockets = new Set<Socket>();
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.on("data", () => {});
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  const { page, close } = await fixture();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    await page
      .getByRole("button", { name: "SSH 연결 추가", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("textbox", { name: "호스트", exact: true }),
    ).toBeFocused();
    await dialog
      .getByRole("textbox", { name: "연결 이름", exact: true })
      .fill("Cancelled handshake");
    await dialog
      .getByRole("textbox", { name: "호스트", exact: true })
      .fill("127.0.0.1");
    await dialog
      .getByRole("spinbutton", { name: "포트", exact: true })
      .fill(String(port));
    await dialog
      .getByRole("textbox", { name: "사용자 이름", exact: true })
      .fill("fixture-user");
    await dialog.getByLabel("인증 방식").selectOption("password");
    await dialog
      .getByLabel("비밀번호", { exact: true })
      .fill("fixture-only-password");
    await dialog.getByRole("button", { name: "연결", exact: true }).click();
    await expect.poll(() => accepted).toBe(1);
    await expect(dialog.locator("form")).toHaveAttribute("aria-busy", "true");
    await dialog
      .getByRole("button", { name: "연결 취소", exact: true })
      .click();
    await expect(dialog).toHaveCount(0, { timeout: 3000 });
    await expect.poll(() => sockets.size, { timeout: 5000 }).toBe(0);
    await expect(page.locator(".toast-error")).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("option", { name: "Project notes.md", exact: true }),
    ).toBeVisible();
    const state = await page.evaluate(() => window.sinder.bootstrap());
    expect(state.profiles).toEqual([]);
    expect(
      state.connections.filter((connection) => connection.kind === "ssh"),
    ).toEqual([]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close();
  }
});

test("remote editor saves, resolves a conflict, reconnects in place and restores its cache after relaunch", async () => {
  const server = await startSshd();
  const f = await fixture();
  let second: ElectronApplication | undefined;
  try {
    const remote = path.join(server.root, "Remote project");
    const nested = path.join(remote, "Nested folder");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "notes.txt"), "Starting document\n");
    await f.app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: ["/usr/bin/true"],
      });
    });
    const page = f.page;
    await page
      .getByRole("button", { name: "원격 편집 작업 보기", exact: true })
      .click();
    await page
      .getByRole("button", { name: "편집기 선택", exact: true })
      .click();
    await page
      .getByRole("button", { name: "SSH 연결 추가", exact: true })
      .first()
      .click();
    await page.getByRole("textbox", { name: "연결 이름" }).fill("Edit server");
    await page
      .getByRole("textbox", { name: "호스트", exact: true })
      .fill("127.0.0.1");
    await page
      .getByRole("spinbutton", { name: "포트", exact: true })
      .fill(String(server.port));
    await page
      .getByRole("textbox", { name: "사용자 이름", exact: true })
      .fill(server.username);
    await page.getByLabel("인증 방식").selectOption("key");
    await page
      .getByRole("textbox", { name: "키 파일", exact: true })
      .fill(server.key);
    await page
      .getByRole("textbox", { name: "시작 폴더", exact: true })
      .fill(remote);
    await page.getByRole("button", { name: "연결", exact: true }).click();
    await page
      .getByRole("option", { name: "Nested folder", exact: true })
      .dblclick();
    await page
      .getByRole("option", { name: "notes.txt", exact: true })
      .dblclick();
    await page.getByRole("button", { name: "원격 편집", exact: true }).click();
    const row = page.getByRole("article", {
      name: "notes.txt 편집 작업",
      exact: true,
    });
    await expect(row).toContainText("저장됨");
    const session = (await page.evaluate(() => window.sinder.bootstrap()))
      .edits[0];
    const temporary = session.localPath + ".saved";
    await fs.writeFile(temporary, "Saved in external editor\n");
    await fs.rename(temporary, session.localPath);
    await expect
      .poll(() => fs.readFile(path.join(nested, "notes.txt"), "utf8"))
      .toBe("Saved in external editor\n");
    await expect(row).toContainText("이전 서버본 1개");
    await fs.writeFile(
      path.join(nested, "notes.txt"),
      "Server changed independently\n",
    );
    await fs.writeFile(session.localPath, "My local changes\n");
    await expect(row).toContainText("버전 충돌");
    expect(await fs.readFile(path.join(nested, "notes.txt"), "utf8")).toBe(
      "Server changed independently\n",
    );
    await page.screenshot({ path: "test-results/remote-edit-conflict.png" });
    await row
      .getByRole("button", { name: "서버본 별도로 열기", exact: true })
      .click();
    await fs.writeFile(session.localPath, "Reviewed merge\n");
    await row.getByRole("button", { name: "수정본 적용", exact: true }).click();
    await expect(row).toContainText("저장됨");
    await page
      .getByRole("button", { name: "Edit server 연결 메뉴", exact: true })
      .click();
    await page.getByRole("button", { name: "연결 해제", exact: true }).click();
    await fs.writeFile(session.localPath, "Offline saved changes\n");
    await expect(row).toContainText("재연결 대기");
    await row.getByRole("button", { name: "다시 연결", exact: true }).click();
    await page.getByRole("button", { name: "연결", exact: true }).click();
    await expect(
      page.getByRole("option", { name: "notes.txt", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => fs.readFile(path.join(nested, "notes.txt"), "utf8"))
      .toBe("Offline saved changes\n");
    await expect(row).toContainText("저장됨");
    await page.screenshot({ path: "test-results/remote-edit-saved.png" });
    await f.app.close();
    // Simulate the editor saving again while Sinder is closed.
    await fs.writeFile(session.localPath, "Saved while Sinder was closed\n");
    second = await electron.launch({
      executablePath: process.env.SINDER_ELECTRON_EXECUTABLE,
      args: [appPath],
      cwd: appPath,
      env: {
        ...process.env,
        SINDER_DATA_DIR: path.join(f.root, "settings"),
        SINDER_HOME: f.home,
      },
    });
    const restored = await second.firstWindow({ timeout: 180000 });
    await restored.waitForURL("**/dist/index.html", {
      waitUntil: "domcontentloaded",
      timeout: 180000,
    });
    await second.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    await restored
      .locator(".pane")
      .getByRole("button", { name: "다시 연결", exact: true })
      .click();
    await restored.getByRole("button", { name: "연결", exact: true }).click();
    await expect(
      restored.getByRole("option", { name: "notes.txt", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => fs.readFile(path.join(nested, "notes.txt"), "utf8"))
      .toBe("Saved while Sinder was closed\n");
    expect(
      (await restored.evaluate(() => window.sinder.bootstrap())).edits[0]
        .localPath,
    ).toBe(session.localPath);
  } finally {
    await second?.close();
    await f.close();
    await server.close();
  }
});
