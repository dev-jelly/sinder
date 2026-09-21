import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  nativeImage,
  type NativeImage,
  type IpcMainInvokeEvent,
} from "electron";
import path from "node:path";
import { existsSync, lstatSync } from "node:fs";
import {
  ExternalFiles,
  documentExtensions,
  textExtensions,
} from "./external-files.js";
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
import {
  editActions,
  type Result,
  type Location,
  type FileClipboard,
} from "../shared/types.js";
import { preview } from "./preview.js";
import {
  startFilePromises,
  activeFilePromises,
  waitForFilePromises,
} from "./file-promises.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const documentPath = path.join(dirname, "../../dist/index.html");
const appUrl = pathToFileURL(documentPath).href;
const dragIcon = nativeImage
  .createFromPath(path.join(dirname, "../../assets/icon.png"))
  .resize({ width: 32, height: 32 });
if (!app.isPackaged && process.env.SINDER_DATA_DIR)
  app.setPath("userData", process.env.SINDER_DATA_DIR);
app.setName("Sinder");
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
const windows = new Set<BrowserWindow>();
const windowOptions = new Map<
  number,
  { initialLocation?: Location; restoreWorkspace: boolean }
>();
let createWindow: (location?: Location) => Promise<void>;
let clipboard: FileClipboard | null = null;
let closing = false;
const dragExports = new Map<
  string,
  { owner: number; files: string[]; icon: NativeImage }
>();
const focusedWindow = () => BrowserWindow.getFocusedWindow() ?? [...windows][0];
const trusted = (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return owner &&
    windows.has(owner) &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === appUrl
    ? owner
    : undefined;
};
const emit = (channel: string, payload: unknown) => {
  for (const window of windows)
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
};
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
  handler: (args: z.infer<T>, window: BrowserWindow) => unknown,
) {
  ipcMain.handle(name, async (event, raw): Promise<Result<unknown>> => {
    const window = trusted(event);
    if (!window) return { ok: false, error: "허용되지 않은 요청입니다." };
    try {
      return { ok: true, value: await handler(schema.parse(raw), window) };
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
  const window = focusedWindow();
  if (window) {
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
          const result = await dialog.showMessageBox(focusedWindow(), {
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
      connections.on("change", (data) => emit("connections:changed", data));
      const completedMoves = new Set<string>();
      transfers.on("change", (data) => {
        emit("transfers:changed", data);
        for (const job of data as import("../shared/types.js").Transfer[]) {
          if (job.status !== "done" || !job.move || completedMoves.has(job.id))
            continue;
          completedMoves.add(job.id);
          if (
            clipboard?.move &&
            JSON.stringify(job.source) === JSON.stringify(clipboard.source)
          ) {
            clipboard = null;
            emit("clipboard:changed", null);
          }
        }
      });
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

      handle("bootstrap", z.undefined(), (_args, window) => ({
        ...windowOptions.get(window.id),
        clipboard,
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
        async (locations, window) => {
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
      const externalFiles = new ExternalFiles(
        connections,
        transfers,
        path.join(app.getPath("userData"), "external-files"),
      );
      handle("window:new", locationSchema.optional(), async (location) => {
        if (closing) throw new Error("종료 준비 중입니다.");
        await createWindow(location);
      });
      handle("window:close", z.undefined(), (_args, window) => {
        setImmediate(() => {
          if (!window.isDestroyed()) window.close();
        });
      });
      handle(
        "clipboard:set",
        z
          .object({
            source: z.array(locationSchema).min(1).max(10000),
            move: z.boolean(),
          })
          .nullable(),
        (value) => {
          clipboard = value;
          emit("clipboard:changed", value);
        },
      );
      handle(
        "files:prepare-export",
        z.array(locationSchema).min(1).max(1000),
        async (source, window) => {
          const files = await externalFiles.prepare(source);
          if (window.isDestroyed()) throw new Error("창이 닫혔습니다.");
          const id = randomUUID();
          // Only the latest prepared selection belongs to this window.
          for (const [key, value] of dragExports)
            if (value.owner === window.id) dragExports.delete(key);
          dragExports.set(id, { owner: window.id, files, icon: dragIcon });
          return { id, names: files.map((file) => path.basename(file)) };
        },
      );
      ipcMain.on("files:drag-remote", (event, raw) => {
        const window = trusted(event);
        if (!window) return;
        const report = (message: string) => {
          if (!event.sender.isDestroyed())
            event.sender.send("files:drag-error", message);
        };
        try {
          const entries = z
            .array(
              z.object({ location: locationSchema, directory: z.boolean() }),
            )
            .min(1)
            .max(1000)
            .parse(raw);
          const source = entries.map(({ location }) => location);
          const items = entries.map(({ location, directory }) => {
            const provider = connections.get(location.connectionId);
            const absolute = connections.resolve(
              location.connectionId,
              location.path,
            );
            return { name: provider.paths.basename(absolute), directory };
          });
          const downloads = new Map<number, Promise<string>>();
          startFilePromises(
            window,
            items,
            `SinderFiles:${JSON.stringify(source)}`,
            (index) => {
              if (!source[index])
                return Promise.reject(new Error("알 수 없는 파일 요청입니다."));
              let download = downloads.get(index);
              if (!download) {
                download = externalFiles
                  .prepare([source[index]])
                  .then((files) => files[0]);
                downloads.set(index, download);
              }
              return download;
            },
            report,
          );
        } catch (error) {
          report(error instanceof Error ? error.message : String(error));
        }
      });
      ipcMain.on("files:drag-local", (event, raw) => {
        if (!trusted(event)) return;
        try {
          const files = z
            .array(
              z
                .string()
                .min(1)
                .max(32768)
                .refine((p) => path.isAbsolute(p) && !p.includes("\0")),
            )
            .min(1)
            .max(1000)
            .parse(raw);
          for (const file of files) {
            const info = lstatSync(file);
            if (!info.isFile() && !info.isDirectory())
              throw new Error(
                "일반 파일과 폴더만 외부로 드래그할 수 있습니다.",
              );
          }
          event.sender.startDrag({
            file: files[0],
            files,
            icon: dragIcon,
          });
        } catch (error) {
          event.sender.send(
            "files:drag-error",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      ipcMain.on("files:start-drag", (event, id) => {
        const window = trusted(event);
        if (!window) return;
        try {
          const prepared =
            typeof id === "string" ? dragExports.get(id) : undefined;
          if (
            !prepared ||
            prepared.owner !== window.id ||
            !prepared.files.every(existsSync)
          )
            throw new Error("드래그할 파일을 다시 준비해 주세요.");
          event.sender.startDrag({
            file: prepared.files[0],
            files: prepared.files,
            icon: prepared.icon,
          });
        } catch (error) {
          event.sender.send(
            "files:drag-error",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      handle("files:open", locationSchema, async (location) => {
        if (location.connectionId === "local") {
          const error = await shell.openPath(
            connections.resolve("local", location.path),
          );
          if (error) throw new Error(error);
          return { kind: "local" };
        }
        const provider = connections.get(location.connectionId);
        const absolute = connections.resolve(
          location.connectionId,
          location.path,
        );
        const info = await provider.stat(absolute);
        if (info.kind !== "file")
          throw new Error("일반 파일만 외부 앱에서 열 수 있습니다.");
        const extension = path.posix.extname(absolute).toLowerCase();
        if (
          textExtensions.has(extension) ||
          !extension ||
          path.posix.basename(absolute).startsWith(".")
        ) {
          await edits.open(location);
          return { kind: "edit" };
        }
        if (!documentExtensions.has(extension))
          throw new Error(
            "이 형식은 실행 방지를 위해 바로 열지 않습니다. 미리보기 또는 로컬로 다운로드를 사용하세요.",
          );
        const [filename] = await externalFiles.prepare([location]);
        const error = await shell.openPath(filename);
        if (error) throw new Error(error);
        return { kind: "copy", localPath: filename };
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
      handle("dialog:key", z.undefined(), async (_args, window) => {
        const result = await dialog.showOpenDialog(window, {
          title: "SSH 비공개 키 선택",
          properties: ["openFile", "showHiddenFiles"],
        });
        return result.filePaths[0] ?? null;
      });
      handle("dialog:folder", z.undefined(), async (_args, window) => {
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
      handle("edits:choose-editor", z.undefined(), async (_args, window) => {
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
        async ({ id, action }, window) => {
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
      createWindow = async (location) => {
        const window = new BrowserWindow({
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
        window.webContents.on("will-navigate", (event) =>
          event.preventDefault(),
        );
        windows.add(window);
        windowOptions.set(window.id, {
          initialLocation: location,
          restoreWorkspace: windows.size === 1 && !location,
        });
        window.on("closed", () => {
          windows.delete(window);
          windowOptions.delete(window.id);
          for (const [id, value] of dragExports)
            if (value.owner === window.id) dragExports.delete(id);
        });
        let forceClose = false;
        let checkingClose = false;
        window.on("close", (event) => {
          if (forceClose || windows.size > 1) return;
          event.preventDefault();
          if (checkingClose) return;
          checkingClose = true;
          closing = true;
          void (async () => {
            try {
              await edits.stop();
              if (
                transfers.active() ||
                edits.unsettled() ||
                activeFilePromises()
              ) {
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
              await waitForFilePromises();
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
              closing = false;
            }
          })();
        });
        await window.loadFile(documentPath);
      };
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
            label: "파일",
            submenu: [
              {
                label: "새 창",
                accelerator: "CmdOrCtrl+N",
                click: () =>
                  focusedWindow()?.webContents.send("window:new-requested"),
              },
              {
                label: "창 닫기",
                accelerator: "CmdOrCtrl+Shift+W",
                click: () => focusedWindow()?.close(),
              },
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
      await createWindow();
    })
    .catch((error) => {
      // Closing a window while its first page loads aborts that navigation.
      if (!windows.size && closing) return;
      console.error("Sinder startup failed:", error);
      dialog.showErrorBox("Sinder를 시작하지 못했습니다", error.message);
      app.quit();
    });
app.on("window-all-closed", () => {
  connections?.close();
  app.quit();
});
