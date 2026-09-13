import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { Store } from "./store.js";
import { Connections } from "./connections.js";
import { Transfers } from "./transfers.js";
import { RemoteEdits } from "./remote-edits.js";
import { exists, protectRoot, validName } from "./providers.js";
import { editActions, type Result } from "../shared/types.js";
import { preview } from "./preview.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const documentPath = path.join(dirname, "../../dist/index.html");
const appUrl = pathToFileURL(documentPath).href;
if (!app.isPackaged && process.env.SINDER_DATA_DIR)
  app.setPath("userData", process.env.SINDER_DATA_DIR);
app.setName("Sinder");
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
let window: BrowserWindow;
let connections: Connections;
let transfers: Transfers;
let edits: RemoteEdits;
const locationSchema = z.object({
  connectionId: z.string().min(1).max(200),
  path: z
    .string()
    .min(1)
    .max(32768)
    .refine((p) => !p.includes("\0")),
});
const profileSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    host: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((p) => !/[\s\0]/.test(p)),
    port: z.number().int().min(1).max(65535),
    username: z.string().trim().min(1).max(100),
    auth: z.enum(["agent", "key", "password"]),
    keyPath: z.string().max(32768).optional(),
    initialPath: z.string().min(1).max(32768),
    sshConfigHost: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[^\s*!?\0]+$/)
      .optional(),
  })
  .refine((p) => p.auth !== "key" || !!p.keyPath, {
    message: "키 파일을 선택해 주세요.",
  });
const stringId = z.string().min(1).max(200);

function handle<T extends z.ZodType>(
  name: string,
  schema: T,
  handler: (args: z.infer<T>) => unknown,
) {
  ipcMain.handle(name, async (event, raw): Promise<Result<unknown>> => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== appUrl
    )
      return { ok: false, error: "허용되지 않은 요청입니다." };
    try {
      return { ok: true, value: await handler(schema.parse(raw)) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof z.ZodError
            ? "입력 내용을 확인해 주세요."
            : error instanceof Error
              ? error.message
              : "작업을 완료하지 못했습니다.",
      };
    }
  });
}

app.on("second-instance", () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});
if (primaryInstance)
  app
    .whenReady()
    .then(async () => {
      const store = new Store(
        path.join(app.getPath("userData"), "settings.json"),
      );
      await store.load();
      connections = new Connections(
        store,
        async (profile, fingerprint) => {
          const result = await dialog.showMessageBox(window, {
            type: "question",
            title: "SSH 서버 확인",
            message: `${profile.host}:${profile.port}에 처음 연결합니다.`,
            detail: `서버의 SHA-256 지문이 맞는지 확인해 주세요.\n\n${fingerprint}\n\n확인한 키는 이 기기에 저장됩니다. 키가 변경되면 연결을 차단합니다.`,
            buttons: ["취소", "신뢰하고 연결"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return result.response === 1;
        },
        !app.isPackaged ? process.env.SINDER_HOME : undefined,
      );
      transfers = new Transfers(connections);
      window = new BrowserWindow({
        width: 1360,
        height: 880,
        minWidth: 860,
        minHeight: 580,
        title: "Sinder",
        backgroundColor: "#f7f8fa",
        titleBarStyle:
          process.platform === "darwin" ? "hiddenInset" : "default",
        trafficLightPosition: { x: 20, y: 22 },
        vibrancy: "sidebar",
        visualEffectState: "active",
        webPreferences: {
          preload: path.join(dirname, "preload.cjs"),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      const emit = (channel: string, payload: unknown) => {
        if (!window.isDestroyed()) window.webContents.send(channel, payload);
      };
      connections.on("change", (data) => emit("connections:changed", data));
      transfers.on("change", (data) => emit("transfers:changed", data));
      const launchEditor = async (filename: string) => {
        const editor =
          store.data.editorPath ??
          (process.platform === "darwin"
            ? "/System/Applications/TextEdit.app"
            : process.platform === "win32"
              ? "notepad.exe"
              : undefined);
        if (!editor)
          throw new Error("먼저 원격 편집 패널에서 편집기를 선택해 주세요.");
        // Launch an editor explicitly: never execute a downloaded file by its extension.
        if (process.platform === "darwin" && editor.endsWith(".app"))
          await promisify(execFile)("/usr/bin/open", ["-a", editor, filename]);
        else
          await new Promise<void>((resolve, reject) => {
            const child = spawn(editor, [filename], {
              windowsHide: false,
              stdio: "ignore",
              detached: true,
            });
            child.once("error", reject);
            child.once("spawn", () => {
              child.unref();
              resolve();
            });
          });
      };
      edits = new RemoteEdits(
        connections,
        path.join(app.getPath("userData"), "remote-edits"),
        launchEditor,
      );
      edits.on("change", (data) => emit("edits:changed", data));
      edits.on("failure", (error) =>
        emit(
          "edits:failure",
          error instanceof Error ? error.message : String(error),
        ),
      );
      await edits.init();

      handle("bootstrap", z.undefined(), () => ({
        connections: connections.list(),
        profiles: store.data.profiles,
        bookmarks: store.data.bookmarks,
        home: connections.local.home,
        platform: process.platform,
        transfers: transfers.jobs,
        edits: edits.list(),
      }));
      handle("files:list", locationSchema, async (location) => {
        const provider = connections.get(location.connectionId);
        const p = await provider.realpath(
          connections.resolve(location.connectionId, location.path),
        );
        return { path: p, entries: await provider.list(p) };
      });
      handle(
        "files:mkdir",
        z.object({ location: locationSchema, name: z.string().max(255) }),
        async ({ location, name }) => {
          const provider = connections.get(location.connectionId);
          await provider.mkdir(
            provider.paths.join(
              connections.resolve(location.connectionId, location.path),
              validName(name),
            ),
          );
        },
      );
      handle(
        "files:rename",
        z.object({ location: locationSchema, name: z.string().max(255) }),
        async ({ location, name }) => {
          const provider = connections.get(location.connectionId);
          const p = connections.resolve(location.connectionId, location.path);
          protectRoot(provider, p);
          await provider.rename(
            p,
            provider.paths.join(provider.paths.dirname(p), validName(name)),
          );
        },
      );
      handle(
        "files:trash",
        z.array(locationSchema).min(1).max(10000),
        async (locations) => {
          if (locations.some((l) => l.connectionId !== "local")) {
            const result = await dialog.showMessageBox(window, {
              type: "question",
              message: `${locations.length}개 항목을 휴지통으로 이동할까요?`,
              detail:
                "원격 항목은 서버 홈의 .sinder-trash에 보관됩니다. 이 폴더에서 다시 옮겨 복원할 수 있습니다.",
              buttons: ["취소", "휴지통으로 이동"],
              defaultId: 0,
              cancelId: 0,
            });
            if (result.response !== 1) return;
          }
          for (const location of locations) {
            const provider = connections.get(location.connectionId);
            const p = connections.resolve(location.connectionId, location.path);
            protectRoot(provider, p);
            if (location.connectionId === "local") await shell.trashItem(p);
            else {
              const trash = provider.paths.join(provider.home, ".sinder-trash");
              if (p === trash || p.startsWith(trash + "/"))
                throw new Error(
                  "원격 휴지통 안의 항목은 다른 폴더로 이동하여 복원할 수 있습니다.",
                );
              if (!(await exists(provider, trash))) await provider.mkdir(trash);
              const trashInfo = await provider.stat(trash);
              if (trashInfo.kind !== "directory")
                throw new Error("원격 휴지통 경로가 일반 폴더가 아닙니다.");
              const batch = provider.paths.join(
                trash,
                `${Date.now()}-${randomUUID().slice(0, 8)}`,
              );
              await provider.mkdir(batch);
              await provider.rename(
                p,
                provider.paths.join(batch, provider.paths.basename(p)),
              );
            }
          }
        },
      );
      handle("files:preview", locationSchema, async (location) => {
        const provider = connections.get(location.connectionId);
        const p = connections.resolve(location.connectionId, location.path);
        return preview(provider, p);
      });
      handle("files:open", locationSchema, async (location) => {
        if (location.connectionId !== "local")
          throw new Error("원격 파일은 로컬로 복사한 후 열어 주세요.");
        const error = await shell.openPath(
          connections.resolve("local", location.path),
        );
        if (error) throw new Error(error);
      });
      handle("files:reveal", locationSchema, (location) => {
        if (location.connectionId !== "local")
          throw new Error("로컬 파일만 Finder에서 표시할 수 있습니다.");
        shell.showItemInFolder(connections.resolve("local", location.path));
      });
      handle(
        "connections:connect",
        z.object({
          profile: profileSchema,
          credentials: z.object({
            password: z.string().max(4096).optional(),
            passphrase: z.string().max(4096).optional(),
          }),
        }),
        ({ profile, credentials }) => connections.connect(profile, credentials),
      );
      handle("connections:cancel", stringId, (id) => connections.cancel(id));
      handle("connections:ssh-config", z.undefined(), () =>
        connections.readSshConfig(),
      );
      handle("connections:import-ssh-config", z.undefined(), () =>
        connections.importSshConfig(),
      );
      handle("connections:disconnect", stringId, (id) =>
        connections.disconnect(id),
      );
      handle("connections:remove", stringId, (id) =>
        connections.removeProfile(id),
      );
      handle("dialog:key", z.undefined(), async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "SSH 비공개 키 선택",
          properties: ["openFile", "showHiddenFiles"],
        });
        return result.filePaths[0] ?? null;
      });
      handle("dialog:folder", z.undefined(), async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "폴더 열기",
          properties: ["openDirectory", "showHiddenFiles"],
        });
        return result.filePaths[0] ?? null;
      });
      handle(
        "bookmarks:save",
        z
          .array(
            z.object({
              id: stringId,
              name: z.string().min(1).max(255),
              location: locationSchema,
            }),
          )
          .max(100),
        async (bookmarks) => {
          store.data.bookmarks = bookmarks;
          await store.save();
        },
      );
      handle(
        "transfers:start",
        z.object({
          source: z.array(locationSchema).min(1).max(10000),
          destination: locationSchema,
          move: z.boolean(),
          conflict: z.enum(["skip", "keep-both", "error"]),
        }),
        (request) => transfers.start(request),
      );
      handle("transfers:cancel", stringId, (id) => transfers.cancel(id));
      handle("edits:open", locationSchema, (location) => edits.open(location));
      handle("edits:choose-editor", z.undefined(), async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "텍스트 편집기 선택",
          message: "원격 파일을 수정할 앱 또는 실행 파일을 선택하세요.",
          properties: ["openFile"],
        });
        const selected = result.filePaths[0];
        if (selected) {
          store.data.editorPath = selected;
          await store.save();
        }
        return selected ?? null;
      });
      handle(
        "edits:action",
        z.object({
          id: z.string().uuid(),
          action: z.enum(editActions),
        }),
        async ({ id, action }) => {
          const session = edits.list().find((s) => s.id === id);
          if (!session) throw new Error("편집 작업을 찾을 수 없습니다.");
          if (action === "reveal") {
            shell.showItemInFolder(session.localPath);
            return;
          }
          if (action === "apply-local") {
            const result = await dialog.showMessageBox(window, {
              type: "question",
              message: `${session.name}에 내 수정본을 적용할까요?`,
              detail:
                "현재 서버본은 서버의 숨김 백업 폴더에 보관됩니다. 비교 후 합친 수정본을 저장했다면 계속하세요.",
              buttons: ["취소", "수정본 적용"],
              defaultId: 0,
              cancelId: 0,
            });
            if (result.response !== 1) return;
          }
          await edits.action(id, action);
        },
      );
      let forceClose = false;
      let checkingClose = false;
      window.on("close", (event) => {
        if (forceClose) return;
        event.preventDefault();
        if (checkingClose) return;
        checkingClose = true;
        void (async () => {
          try {
            await edits.stop();
            if (transfers.active() || edits.unsettled()) {
              const result = await dialog.showMessageBox(window, {
                type: "question",
                message: "진행 중인 작업을 보관하고 종료할까요?",
                detail:
                  "서버에 반영하지 못한 편집 내용은 이 기기에 보관됩니다. 다음 실행에서 연결하면 다시 확인합니다. 진행 중인 파일 전송은 취소됩니다.",
                buttons: ["돌아가기", "보관하고 종료"],
                defaultId: 0,
                cancelId: 0,
              });
              if (result.response !== 1) {
                edits.resume();
                return;
              }
            }
            transfers.jobs.forEach((t) => transfers.cancel(t.id));
            await transfers.idle();
            forceClose = true;
            window.close();
          } catch (error) {
            edits.resume();
            dialog.showErrorBox(
              "작업 보관 실패",
              error instanceof Error ? error.message : String(error),
            );
          } finally {
            checkingClose = false;
          }
        })();
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "Sinder",
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          {
            label: "편집",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "보기",
            submenu: [
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
              { type: "separator" },
              { role: "togglefullscreen" },
              ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
            ],
          },
          {
            label: "윈도우",
            submenu: [{ role: "minimize" }, { role: "zoom" }],
          },
        ]),
      );
      await window.loadFile(documentPath);
    })
    .catch((error) => {
      // Closing a window while its first page loads aborts that navigation.
      if (window?.isDestroyed()) return;
      console.error("Sinder startup failed:", error);
      dialog.showErrorBox("Sinder를 시작하지 못했습니다", error.message);
      app.quit();
    });
app.on("window-all-closed", () => {
  connections?.close();
  app.quit();
});
