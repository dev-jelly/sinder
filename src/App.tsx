import { useEffect, useRef, useState } from "react";
import {
  DownloadSimple,
  ArrowRight,
  ArrowsLeftRight,
  Check,
  CircleHalf,
  ClipboardText,
  Copy,
  Desktop,
  DotsThree,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrives,
  House,
  Info,
  Keyboard,
  LinkBreak,
  Monitor,
  PencilSimple,
  Plus,
  Scissors,
  SidebarSimple,
  Star,
  TerminalWindow,
  Trash,
  X,
} from "./icons";
import type {
  Bookmark,
  Bootstrap,
  Connection,
  Entry,
  Location,
  Preview,
  Profile,
  Transfer,
  TransferRequest,
} from "../shared/types";
import { ConnectionDialog } from "./ConnectionDialog";
import { RemoteEditsPanel } from "./RemoteEditsPanel";
import type { EditSession } from "../shared/types";
import { FolderTree } from "./FolderTree";
import { FileIcon, Modal, Tool } from "./components";
import { Pane, type Clipboard, type Command, type PaneHandle } from "./Pane";
import {
  basename,
  date,
  errorText,
  join,
  kindLabel,
  locationKey,
  size,
  shortcut,
} from "./utils";
import {
  newPane,
  newTab,
  navigatePane,
  reconnectPane,
  updatePane,
  type PaneState,
  type Tab,
} from "./workspace";

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tabId, setTabId] = useState("");
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [selected, setSelected] = useState<Entry[]>([]);
  const [hidden, setHidden] = useState(
    localStorage.getItem("sinder-hidden") === "true",
  );
  const [inspector, setInspector] = useState(
    localStorage.getItem("sinder-inspector") === "true",
  );
  const [sidebarVisible, setSidebarVisible] = useState(
    localStorage.getItem("sinder-sidebar") !== "false",
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [connectionDialog, setConnectionDialog] = useState<
    Profile | "new" | null
  >(null);
  const [preview, setPreview] = useState<{
    location: Location;
    entry: Entry;
  } | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [activityPanel, setActivityPanel] = useState<
    "transfers" | "edits" | null
  >(null);
  const [editSessions, setEditSessions] = useState<EditSession[]>([]);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [naming, setNaming] = useState<{
    title: string;
    initial: string;
    resolve: (value: string | null) => void;
  } | null>(null);
  const [pendingTransfer, setPendingTransfer] =
    useState<TransferRequest | null>(null);
  const [connectionMenu, setConnectionMenu] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    const saved = localStorage.getItem("sinder-theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const paneRefs = useRef(new Map<string, PaneHandle>());
  const transferStates = useRef(new Map<string, string>());
  const editStates = useRef(new Map<string, string>());
  const pendingNavigation = useRef<Location | null>(null);
  const activeTab = tabs.find((t) => t.id === tabId) ?? tabs[0];
  const activePane =
    activeTab?.panes.find((p) => p.id === activeTab.active) ??
    activeTab?.panes[0];
  const activeConnection = connections.find(
    (c) => c.id === activePane?.location.connectionId,
  );
  const activeTransfers = transfers.filter(
    (t) => t.status === "running" || t.status === "queued",
  );
  const modalOpen = Boolean(
    connectionDialog || preview || naming || pendingTransfer || shortcuts,
  );
  const activeEdits = editSessions.filter(
    (session) => session.status !== "paused",
  ).length;
  const keyLabel = (keys: string) => shortcut(boot?.platform ?? "darwin", keys);

  const notify = (message: string, error = false) =>
    setToast({ message, error });
  const guard = (promise: Promise<unknown>) => {
    void promise.catch((e) => notify(errorText(e), true));
  };
  useEffect(() => {
    if (!window.sinder) {
      setBootError(
        "Sinder는 데스크톱 앱입니다. 터미널에서 npm run dev로 실행해 주세요.",
      );
      return;
    }
    let live = true;
    void window.sinder
      .bootstrap()
      .then((data) => {
        if (!live) return;
        setBoot(data);
        setConnections(data.connections);
        setProfiles(data.profiles);
        setBookmarks(data.bookmarks);
        setTransfers(data.transfers);
        setEditSessions(data.edits);
        let saved: Tab[] = [];
        try {
          const parsed = JSON.parse(
            localStorage.getItem("sinder-tabs") ?? "[]",
          );
          if (Array.isArray(parsed))
            saved = parsed
              .slice(0, 20)
              .filter(
                (t) =>
                  t &&
                  typeof t.id === "string" &&
                  Array.isArray(t.panes) &&
                  t.panes.length > 0 &&
                  t.panes.length <= 2 &&
                  t.panes.every(
                    (p: PaneState) =>
                      p &&
                      typeof p.id === "string" &&
                      typeof p.location?.path === "string" &&
                      p.location.path.length > 0 &&
                      data.connections.some(
                        (c) => c.id === p.location.connectionId,
                      ),
                  ),
              )
              .map((t) => ({
                id: t.id,
                active: t.panes.some((pane: PaneState) => pane.id === t.active)
                  ? t.active
                  : t.panes[0].id,
                panes: t.panes.map((p: PaneState) => ({
                  ...p,
                  history: [p.location],
                  cursor: 0,
                })),
              }));
        } catch {
          /* An invalid saved window layout falls back to home. */
        }
        const initial = saved.length
          ? saved
          : [newTab({ connectionId: "local", path: data.home })];
        setTabs(initial);
        setTabId(initial[0].id);
      })
      .catch((e) => setBootError(errorText(e)));
    const offConnections = window.sinder.onConnections((data) => {
      setConnections(data);
      setRefreshKey((k) => k + 1);
    });
    const offTransfers = window.sinder.onTransfers((data) => {
      setTransfers(data);
      const finished = data.filter(
        (t) =>
          ["done", "error", "cancelled"].includes(t.status) &&
          transferStates.current.get(t.id) !== t.status,
      );
      transferStates.current = new Map(data.map((t) => [t.id, t.status]));
      if (finished.length) setRefreshKey((k) => k + 1);
      if (finished.some((t) => t.move && t.status === "done"))
        setClipboard(null);
    });
    const offEdits = window.sinder.onEdits((data) => {
      setEditSessions(data);
      if (
        data.some(
          (s) =>
            s.status === "clean" &&
            editStates.current.get(s.id) !== `${s.status}:${s.updated}`,
        )
      )
        setRefreshKey((k) => k + 1);
      editStates.current = new Map(
        data.map((s) => [s.id, `${s.status}:${s.updated}`]),
      );
    });
    const offEditErrors = window.sinder.onEditError((message) =>
      notify(message, true),
    );
    return () => {
      live = false;
      offConnections();
      offTransfers();
      offEdits();
      offEditErrors();
    };
  }, []);
  useEffect(() => {
    if (tabs.length)
      localStorage.setItem(
        "sinder-tabs",
        JSON.stringify(
          tabs.map((t) => ({
            ...t,
            panes: t.panes.map((p) => ({
              ...p,
              history: [p.location],
              cursor: 0,
            })),
          })),
        ),
      );
  }, [tabs]);
  useEffect(() => {
    localStorage.setItem("sinder-hidden", String(hidden));
  }, [hidden]);
  useEffect(() => {
    localStorage.setItem("sinder-inspector", String(inspector));
  }, [inspector]);
  useEffect(() => {
    localStorage.setItem("sinder-sidebar", String(sidebarVisible));
  }, [sidebarVisible]);
  useEffect(() => {
    localStorage.setItem("sinder-theme", theme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);
  useEffect(() => {
    document.title = activePane
      ? `${basename(activePane.location.path)} — Sinder`
      : "Sinder";
  }, [activePane?.location.path]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 10000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  function command(c: Command) {
    if (activePane) paneRefs.current.get(activePane.id)?.command(c);
  }
  function addTab(location?: Location) {
    const destination = location ?? activePane?.location;
    if (!destination) return;
    const tab = newTab(destination);
    setTabs((previous) => [...previous, tab]);
    setTabId(tab.id);
    setSelected([]);
  }
  function closeTab(id: string) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (tabs.length <= 1 || index < 0) return;
    setTabs((previous) => previous.filter((tab) => tab.id !== id));
    if (id === activeTab?.id) {
      setTabId(tabs[index === 0 ? 1 : index - 1].id);
      setSelected([]);
    }
  }
  function toggleSplit() {
    if (!activeTab || !activePane) return;
    setTabs((previous) =>
      previous.map((t) =>
        t.id !== activeTab.id
          ? t
          : t.panes.length === 2
            ? { ...t, panes: [activePane], active: activePane.id }
            : { ...t, panes: [...t.panes, newPane(activePane.location)] },
      ),
    );
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (modalOpen || event.defaultPrevented) return;
      const element = event.target as HTMLElement;
      if (element.closest('[role="menu"]')) return;
      const input =
        ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ||
        element.isContentEditable;
      const mod = event.metaKey || event.ctrlKey;
      if (input && !(mod && ["l", "f"].includes(event.key.toLowerCase())))
        return;
      let action: Command | undefined;
      if (mod) {
        const key = event.key.toLowerCase();
        action = (
          {
            c: "copy",
            x: "cut",
            v: "paste",
            a: "selectAll",
            l: "path",
            f: "filter",
            r: "refresh",
            "[": "back",
            "]": "forward",
          } as Record<string, Command>
        )[key];
        if (key === "n" && event.shiftKey) action = "mkdir";
        if (key === "t") {
          event.preventDefault();
          addTab();
        }
        if (key === "w") {
          event.preventDefault();
          if (activeTab) closeTab(activeTab.id);
        }
        if (key === "\\") {
          event.preventDefault();
          toggleSplit();
        }
        if (key === "i") {
          event.preventDefault();
          setInspector((visible) => !visible);
        }
        if (key === "b") {
          event.preventDefault();
          setSidebarVisible((visible) => !visible);
        }
        if (key === ".") {
          event.preventDefault();
          setHidden((h) => !h);
        }
        if (event.key === "Backspace") action = "trash";
        if (event.key === "ArrowUp") action = "up";
      } else if (event.altKey && event.key === "ArrowLeft") action = "back";
      else if (event.altKey && event.key === "ArrowRight") action = "forward";
      else if (event.altKey && event.key === "ArrowUp") action = "up";
      else if (event.key === "F2") action = "rename";
      else if (event.key === "F5") action = "refresh";
      else if (event.key === " " || event.key === "Enter") {
        if (element.matches('.file-area[role="listbox"]')) action = "preview";
      } else if (event.key === "Delete") action = "trash";
      if (action) {
        if (
          element.closest('[role="tree"]') &&
          [
            "copy",
            "cut",
            "paste",
            "rename",
            "trash",
            "mkdir",
            "selectAll",
          ].includes(action)
        )
          return;
        event.preventDefault();
        command(action);
      }
    };
    const onClipboard = (event: ClipboardEvent) => {
      if (
        modalOpen ||
        (event.target as HTMLElement).closest('[role="tree"]') ||
        (event.target as HTMLElement).isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          (event.target as HTMLElement).tagName,
        )
      )
        return;
      event.preventDefault();
      command(event.type as "copy" | "cut" | "paste");
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("copy", onClipboard);
    document.addEventListener("cut", onClipboard);
    document.addEventListener("paste", onClipboard);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", onClipboard);
      document.removeEventListener("cut", onClipboard);
      document.removeEventListener("paste", onClipboard);
    };
  });
  function editConnection(id?: string, destination?: Location) {
    pendingNavigation.current = destination ?? null;
    setConnectionDialog(profiles.find((profile) => profile.id === id) ?? "new");
  }
  function changePane(
    tabId: string,
    paneId: string,
    update: (pane: PaneState) => PaneState,
  ) {
    setTabs((previous) => updatePane(previous, tabId, paneId, update));
  }
  function navigate(location: Location) {
    if (!activeTab || !activePane) return;
    const connection = connections.find(
      (connection) => connection.id === location.connectionId,
    );
    if (connection?.status === "disconnected") {
      editConnection(connection.id, location);
      return;
    }
    changePane(activeTab.id, activePane.id, (pane) =>
      navigatePane(pane, location),
    );
  }
  async function bookmark(bookmark: Bookmark) {
    const next = bookmarks.some(
      (b) => locationKey(b.location) === locationKey(bookmark.location),
    )
      ? bookmarks.filter(
          (b) => locationKey(b.location) !== locationKey(bookmark.location),
        )
      : [...bookmarks, bookmark];
    await window.sinder.bookmarks(next);
    setBookmarks(next);
  }
  async function beginTransfer(request: TransferRequest) {
    await window.sinder.transfer(request);
    setPendingTransfer(null);
    setActivityPanel("transfers");
  }
  async function transfer(request: TransferRequest) {
    const listing = await window.sinder.list(request.destination);
    if (
      request.source.some((l) =>
        listing.entries.some((e) => e.name === basename(l.path)),
      )
    )
      setPendingTransfer(request);
    else await beginTransfer(request);
  }
  const askName = (title: string, initial: string) =>
    new Promise<string | null>((resolve) =>
      setNaming({ title, initial, resolve }),
    );
  if (bootError)
    return (
      <div className="boot-state">
        <HardDrives size={48} />
        <h1>Sinder</h1>
        <p role="alert">{bootError}</p>
      </div>
    );
  if (!boot || !activeTab || !activePane)
    return (
      <div className="boot-state">
        <div className="loader" />
        <p>작업 공간을 여는 중…</p>
      </div>
    );
  const homeLocations = [
    { name: "홈", icon: House, path: boot.home },
    { name: "데스크탑", icon: Desktop, path: join(boot.home, "Desktop") },
    {
      name: "다운로드",
      icon: DownloadSimple,
      path: join(boot.home, "Downloads"),
    },
    { name: "문서", icon: Folder, path: join(boot.home, "Documents") },
  ];
  const detail = selected[0];
  return (
    <div
      className={`app-shell platform-${boot.platform} ${sidebarVisible ? "" : "sidebar-hidden"}`}
    >
      <aside className="sidebar">
        <div className="window-drag-area" />
        <div className="sidebar-scroll">
          <div className="sidebar-heading">즐겨찾기</div>
          {homeLocations.map(({ name, icon: Icon, path }) => (
            <button
              key={name}
              className={`sidebar-item ${locationKey(activePane.location) === locationKey({ connectionId: "local", path }) ? "current" : ""}`}
              onClick={() => navigate({ connectionId: "local", path })}
            >
              <Icon size={19} weight="duotone" />
              <span>{name}</span>
            </button>
          ))}
          {bookmarks.map((b) => (
            <div className="bookmark-row" key={b.id}>
              <button
                className={`sidebar-item ${locationKey(activePane.location) === locationKey(b.location) ? "current" : ""}`}
                title={b.location.path}
                onClick={() => navigate(b.location)}
              >
                <Star size={18} />
                <span>{b.name}</span>
                {b.location.connectionId !== "local" && (
                  <span className="remote-bookmark">SSH</span>
                )}
              </button>
              <button
                className="bookmark-remove"
                aria-label={`${b.name} 즐겨찾기 제거`}
                onClick={() => guard(bookmark(b))}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <div className="sidebar-heading connections-heading">위치</div>
          {connections.map((connection) => (
            <div key={connection.id} className="connection-row">
              <button
                className={`sidebar-item connection-item ${activePane.location.connectionId === connection.id ? "connection-current" : ""}`}
                onClick={() =>
                  connection.status === "disconnected"
                    ? editConnection(connection.id)
                    : navigate({
                        connectionId: connection.id,
                        path: connection.home,
                      })
                }
              >
                {connection.kind === "local" ? (
                  <Monitor size={20} weight="duotone" />
                ) : (
                  <TerminalWindow size={20} weight="duotone" />
                )}
                <span>
                  <strong>
                    {connection.kind === "local" && boot.platform !== "darwin"
                      ? "이 컴퓨터"
                      : connection.name}
                  </strong>
                  {connection.kind === "ssh" && (
                    <small>{connection.host}</small>
                  )}
                </span>
                <span
                  className={`status-dot ${connection.status === "connected" ? "online" : ""}`}
                />
              </button>
              {connection.kind === "ssh" && (
                <>
                  <button
                    className="connection-more"
                    aria-label={`${connection.name} 연결 메뉴`}
                    onClick={() =>
                      setConnectionMenu(
                        connectionMenu === connection.id ? null : connection.id,
                      )
                    }
                  >
                    <DotsThree size={20} />
                  </button>
                  {connectionMenu === connection.id && (
                    <div className="connection-popover">
                      <button
                        onClick={() => {
                          setConnectionMenu(null);
                          editConnection(connection.id);
                        }}
                      >
                        <PencilSimple size={14} />
                        연결 설정
                      </button>
                      {connection.status === "connected" && (
                        <button
                          onClick={() => {
                            setConnectionMenu(null);
                            guard(window.sinder.disconnect(connection.id));
                          }}
                        >
                          <LinkBreak size={14} />
                          연결 해제
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setConnectionMenu(null);
                          guard(
                            window.sinder
                              .removeProfile(connection.id)
                              .then(async () => {
                                const fresh = await window.sinder.bootstrap();
                                setProfiles(fresh.profiles);
                                setBookmarks(fresh.bookmarks);
                              }),
                          );
                        }}
                      >
                        <Trash size={14} />
                        저장된 연결 제거
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          <button className="add-connection" onClick={() => editConnection()}>
            <Plus size={17} />
            SSH 연결 추가
          </button>
          <button
            className="open-folder"
            onClick={() =>
              guard(
                window.sinder.pickFolder().then((p) => {
                  if (p) navigate({ connectionId: "local", path: p });
                }),
              )
            }
          >
            <FolderOpen size={17} />
            다른 폴더 열기
          </button>
          {activeConnection?.status === "connected" && (
            <>
              <div className="sidebar-heading tree-heading">폴더 트리</div>
              <FolderTree
                root={{
                  connectionId: activeConnection.id,
                  path: activeConnection.home,
                }}
                current={activePane.location}
                hidden={hidden}
                refreshKey={refreshKey}
                onNavigate={navigate}
              />
            </>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-utilities">
            <Tool
              label={`화면 테마: ${theme}`}
              onClick={() =>
                setTheme(
                  theme === "system"
                    ? "light"
                    : theme === "light"
                      ? "dark"
                      : "system",
                )
              }
            >
              <CircleHalf size={17} />
            </Tool>
            <span>
              {theme === "system"
                ? "시스템 테마"
                : theme === "light"
                  ? "라이트 모드"
                  : "다크 모드"}
            </span>
            <Tool label="키보드 단축키" onClick={() => setShortcuts(true)}>
              <Keyboard size={18} />
            </Tool>
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="toolbar">
          <Tool
            label="사이드바"
            title={`사이드바 (${keyLabel("⌘B")})`}
            active={sidebarVisible}
            onClick={() => setSidebarVisible((visible) => !visible)}
          >
            <SidebarSimple size={20} />
          </Tool>
          <div className="toolbar-title">
            <strong>{basename(activePane.location.path)}</strong>
            <small>
              {activeConnection?.kind === "ssh"
                ? `${activeConnection.name} · SSH`
                : "로컬 작업 공간"}
            </small>
          </div>
          <div className="toolbar-actions">
            <Tool
              label={keyLabel("새 폴더 (⌘⇧N)")}
              onClick={() => command("mkdir")}
            >
              <FolderPlus size={20} />
            </Tool>
            <span className="toolbar-divider" />
            <Tool
              label={keyLabel("잘라내기 (⌘X)")}
              disabled={!selected.length}
              onClick={() => command("cut")}
            >
              <Scissors size={20} />
            </Tool>
            <Tool
              label={keyLabel("복사 (⌘C)")}
              disabled={!selected.length}
              onClick={() => command("copy")}
            >
              <Copy size={20} />
            </Tool>
            <Tool
              label={keyLabel("붙여넣기 (⌘V)")}
              disabled={!clipboard}
              onClick={() => command("paste")}
            >
              <ClipboardText size={20} />
            </Tool>
            <span className="toolbar-divider" />
            <Tool
              label={keyLabel("분할 보기 (⌘\\)")}
              active={activeTab.panes.length === 2}
              onClick={toggleSplit}
            >
              <SidebarSimple size={20} />
            </Tool>
            <Tool
              label="정보 패널"
              title={`정보 패널 (${keyLabel("⌘I")})`}
              active={inspector}
              onClick={() => setInspector((visible) => !visible)}
            >
              <Info size={20} />
            </Tool>
            <button
              className={`transfer-button ${activityPanel === "transfers" ? "active" : ""}`}
              aria-pressed={activityPanel === "transfers"}
              onClick={() =>
                setActivityPanel((panel) =>
                  panel === "transfers" ? null : "transfers",
                )
              }
            >
              <ArrowsLeftRight size={18} />
              <span>전송</span>
              {activeTransfers.length > 0 && <b>{activeTransfers.length}</b>}
            </button>
            <button
              className={`edit-panel-toggle ${activityPanel === "edits" ? "active" : ""}`}
              title="원격 편집 작업"
              aria-label="원격 편집 작업 보기"
              aria-pressed={activityPanel === "edits"}
              onClick={() =>
                setActivityPanel((panel) =>
                  panel === "edits" ? null : "edits",
                )
              }
            >
              <PencilSimple size={18} />
              {activeEdits > 0 && <b>{activeEdits}</b>}
            </button>
          </div>
        </header>
        <div className="tabbar" role="tablist" aria-label="탐색 탭">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${activeTab.id === tab.id ? "selected-tab" : ""}`}
            >
              <button
                role="tab"
                aria-selected={activeTab.id === tab.id}
                onClick={() => {
                  if (tab.id !== activeTab.id) {
                    setTabId(tab.id);
                    setSelected([]);
                  }
                }}
              >
                {tab.panes.some((p) => p.location.connectionId !== "local") ? (
                  <TerminalWindow size={15} />
                ) : (
                  <Folder size={16} weight="duotone" />
                )}
                <span>
                  {basename(
                    tab.panes.find((p) => p.id === tab.active)?.location.path ??
                      tab.panes[0].location.path,
                  )}
                </span>
                {tab.panes.length === 2 && <SidebarSimple size={13} />}
              </button>
              <button
                disabled={tabs.length === 1}
                aria-label="탭 닫기"
                className="close-tab"
                onClick={() => closeTab(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <Tool label={keyLabel("새 탭 (⌘T)")} onClick={() => addTab()}>
            <Plus size={17} />
          </Tool>
          <div className="tabs-spacer" />
          <button
            className={`hidden-toggle ${hidden ? "enabled" : ""}`}
            aria-pressed={hidden}
            title={keyLabel("숨김 파일 (⌘.)")}
            onClick={() => setHidden(!hidden)}
          >
            {hidden && <Check size={12} />}숨김 파일
          </button>
        </div>
        <div
          className={`workspace-body ${activeTab.panes.length === 2 ? "split" : ""} ${inspector ? "with-inspector" : ""}`}
        >
          <div className="panes">
            {activeTab.panes.map((pane) => (
              <Pane
                key={pane.id}
                ref={(handle) => {
                  if (handle) paneRefs.current.set(pane.id, handle);
                  else paneRefs.current.delete(pane.id);
                }}
                state={pane}
                active={activeTab.active === pane.id}
                connection={connections.find(
                  (c) => c.id === pane.location.connectionId,
                )}
                hidden={hidden}
                platform={boot.platform}
                refreshKey={refreshKey}
                clipboard={clipboard}
                bookmarks={bookmarks}
                onActivate={() => {
                  if (activeTab.active !== pane.id)
                    setTabs((previous) =>
                      previous.map((t) =>
                        t.id === activeTab.id ? { ...t, active: pane.id } : t,
                      ),
                    );
                }}
                onChange={(next) =>
                  changePane(activeTab.id, pane.id, () => next)
                }
                onClipboard={setClipboard}
                onPreview={(location, entry) => setPreview({ location, entry })}
                onSelection={setSelected}
                onTransfer={(request) => guard(transfer(request))}
                onBookmark={(b) => guard(bookmark(b))}
                askName={askName}
                notify={notify}
                onReconnect={() => editConnection(pane.location.connectionId)}
              />
            ))}
          </div>
          {inspector && (
            <aside className="inspector">
              <div className="inspector-heading">
                정보
                <Tool
                  label="정보 패널 닫기"
                  onClick={() => setInspector(false)}
                >
                  <X size={14} />
                </Tool>
              </div>
              <div className="inspector-preview">
                {detail ? (
                  <FileIcon entry={detail} large />
                ) : (
                  <Folder size={76} weight="duotone" className="folder-icon" />
                )}
              </div>
              <h2>
                {selected.length > 1
                  ? `${selected.length}개 항목`
                  : (detail?.name ?? basename(activePane.location.path))}
              </h2>
              <p className="inspector-kind">
                {selected.length > 1
                  ? "다중 선택"
                  : detail
                    ? kindLabel(detail)
                    : "폴더"}
              </p>
              <dl>
                <dt>위치</dt>
                <dd>{activeConnection?.name ?? "연결 없음"}</dd>
                {detail && (
                  <>
                    <dt>크기</dt>
                    <dd>
                      {detail.kind === "directory"
                        ? "—"
                        : size(selected.reduce((n, e) => n + e.size, 0))}
                    </dd>
                    <dt>수정한 날짜</dt>
                    <dd>{date(detail.modified)}</dd>
                    <dt>권한</dt>
                    <dd className="mono">
                      {(detail.mode & 0o777).toString(8)}
                    </dd>
                  </>
                )}
                <dt>경로</dt>
                <dd className="inspector-path">
                  {detail?.path ?? activePane.location.path}
                </dd>
              </dl>
              {detail && selected.length === 1 && (
                <button
                  className="inspector-action"
                  onClick={() => command("preview")}
                >
                  {detail.kind === "directory" ? "폴더 열기" : "미리보기"}
                  <ArrowRight size={15} />
                </button>
              )}
              {detail && (
                <div className="inspector-file-actions">
                  <Tool
                    label="이름 변경 (F2)"
                    disabled={selected.length !== 1}
                    onClick={() => command("rename")}
                  >
                    <PencilSimple size={17} />
                  </Tool>
                  <Tool
                    label="휴지통으로 이동"
                    onClick={() => command("trash")}
                  >
                    <Trash size={17} />
                  </Tool>
                </div>
              )}
              <div className="inspector-tip">
                <Keyboard size={17} />
                <p>
                  <kbd>Space</kbd> 빠른 미리보기
                  <br />
                  <kbd>{keyLabel("⌘L")}</kbd> 경로로 바로 이동
                </p>
              </div>
            </aside>
          )}
        </div>
        {activityPanel === "transfers" && (
          <section className="transfers-panel">
            <div className="transfers-heading">
              <ArrowsLeftRight size={18} />
              <strong>전송</strong>
              <span>
                {activeTransfers.length
                  ? `${activeTransfers.length}개 작업 진행 중`
                  : "모든 위치의 파일 작업"}
              </span>
              <Tool
                label="전송 패널 닫기"
                onClick={() => setActivityPanel(null)}
              >
                <X size={16} />
              </Tool>
            </div>
            {transfers.length === 0 ? (
              <div className="transfers-empty">
                파일을 복사하거나 다른 패널로 드래그하면 이곳에서 진행 상황을
                확인할 수 있습니다.
              </div>
            ) : (
              <div className="transfer-list">
                {transfers.map((t) => (
                  <div
                    key={t.id}
                    className={`transfer-row transfer-${t.status}`}
                  >
                    <div className="transfer-icon">
                      {t.status === "done" ? (
                        <Check size={20} />
                      ) : (
                        <ArrowsLeftRight size={20} />
                      )}
                    </div>
                    <div className="transfer-description">
                      <strong>
                        {t.label}
                        <small>{t.move ? "이동" : "복사"}</small>
                      </strong>
                      <span>
                        {connections.find(
                          (c) => c.id === t.source[0]?.connectionId,
                        )?.name ?? "원본"}
                        <ArrowRight size={12} />
                        {connections.find(
                          (c) => c.id === t.destination.connectionId,
                        )?.name ?? "목적지"}{" "}
                        · {t.destination.path}
                      </span>
                      {t.error && <p role="alert">{t.error}</p>}
                      {t.status === "running" && (
                        <progress
                          max={Math.max(1, t.total)}
                          value={t.bytes}
                          aria-label={`${t.label} 전송 진행률`}
                        />
                      )}
                    </div>
                    <div className="transfer-status">
                      <span>
                        {
                          (
                            {
                              queued: "대기 중",
                              running: "전송 중",
                              done: "완료",
                              cancelled: "취소됨",
                              error: "실패",
                            } as const
                          )[t.status]
                        }
                      </span>
                      <small>
                        {size(t.bytes)}
                        {t.total > 0 && ` / ${size(t.total)}`}
                      </small>
                    </div>
                    {["running", "queued"].includes(t.status) && (
                      <Tool
                        label={`${t.label} 전송 취소`}
                        onClick={() =>
                          guard(window.sinder.cancelTransfer(t.id))
                        }
                      >
                        <X size={16} />
                      </Tool>
                    )}
                    {t.status === "error" && !t.move && (
                      <button
                        onClick={() =>
                          guard(
                            transfer({
                              source: t.source,
                              destination: t.destination,
                              move: false,
                              conflict: "keep-both",
                            }),
                          )
                        }
                      >
                        재시도
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        {activityPanel === "edits" && (
          <RemoteEditsPanel
            sessions={editSessions}
            connections={connections}
            onClose={() => setActivityPanel(null)}
            onAction={(id, action) =>
              guard(window.sinder.editAction(id, action))
            }
            onNavigate={navigate}
            onReconnect={(id) => editConnection(id)}
            onChooseEditor={() =>
              guard(
                window.sinder.chooseEditor().then((editor) => {
                  if (editor)
                    notify(`${basename(editor)}에서 원격 파일을 편집합니다.`);
                }),
              )
            }
          />
        )}
        <footer className="workspace-status">
          <span className="status-dot online" />
          <span>
            {connections.filter((c) => c.status === "connected").length}개 위치
            연결됨
          </span>
          <span className="status-spacer" />
          {clipboard && (
            <span>
              <ClipboardText size={13} />
              {clipboard.source.length}개 항목{" "}
              {clipboard.move ? "이동" : "복사"} 준비
            </span>
          )}
          <span className="status-hint">
            {activeTab.panes.length === 2
              ? "패널 사이 드래그로 복사 · Shift로 이동"
              : `${keyLabel("⌘\\")} 분할 보기`}
          </span>
        </footer>
      </main>
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <Info size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <Tool label="알림 닫기" onClick={() => setToast(null)}>
            <X size={15} />
          </Tool>
        </div>
      )}
      {connectionDialog && (
        <ConnectionDialog
          profile={connectionDialog === "new" ? undefined : connectionDialog}
          onImported={(added) => {
            setConnectionDialog(null);
            pendingNavigation.current = null;
            guard(
              window.sinder.bootstrap().then((data) => {
                setProfiles(data.profiles);
                setConnections(data.connections);
                setToast({
                  message: added
                    ? `SSH 연결 ${added}개를 추가했습니다.`
                    : "이미 추가된 SSH 설정입니다.",
                  error: false,
                });
              }),
            );
          }}
          onClose={() => {
            setConnectionDialog(null);
            pendingNavigation.current = null;
          }}
          onConnected={(connection) => {
            setConnectionDialog(null);
            guard(
              window.sinder.bootstrap().then((data) => {
                setProfiles(data.profiles);
                setConnections(data.connections);
              }),
            );
            const requested = pendingNavigation.current;
            pendingNavigation.current = null;
            changePane(activeTab.id, activePane.id, (pane) =>
              reconnectPane(pane, connection, requested),
            );
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
      {naming && (
        <NameDialog
          title={naming.title}
          initial={naming.initial}
          onDone={(value) => {
            naming.resolve(value);
            setNaming(null);
          }}
        />
      )}
      {preview && (
        <PreviewDialog
          {...preview}
          onClose={() => setPreview(null)}
          onDownload={() =>
            guard(
              window.sinder.pickFolder().then((p) => {
                if (p) {
                  void transfer({
                    source: [preview.location],
                    destination: { connectionId: "local", path: p },
                    move: false,
                    conflict: "keep-both",
                  }).catch((e) => notify(errorText(e), true));
                  setPreview(null);
                }
              }),
            )
          }
          notify={notify}
          onEdit={() =>
            guard(
              window.sinder.editRemote(preview.location).then(() => {
                setPreview(null);
                setActivityPanel("edits");
                notify("편집기에서 저장하면 서버에 자동으로 반영됩니다.");
              }),
            )
          }
        />
      )}
      {pendingTransfer && (
        <Modal
          title="같은 이름의 항목이 있습니다"
          onClose={() => setPendingTransfer(null)}
        >
          <p className="dialog-copy">
            목적지에 이미 있는 항목을 어떻게 처리할까요?
          </p>
          <div className="conflict-options">
            {(
              [
                {
                  value: "keep-both",
                  label: "둘 다 유지",
                  description: "새 항목의 이름에 번호를 붙입니다.",
                },
                {
                  value: "skip",
                  label: "기존 항목 건너뛰기",
                  description: "겹치지 않는 항목만 전송합니다.",
                },
                {
                  value: "error",
                  label: "충돌 시 중단",
                  description: "전송 전 충돌이 있으면 작업을 중단합니다.",
                },
              ] as const
            ).map((option) => (
              <label key={option.value}>
                <input
                  type="radio"
                  name="conflict"
                  checked={pendingTransfer.conflict === option.value}
                  onChange={() =>
                    setPendingTransfer({
                      ...pendingTransfer,
                      conflict: option.value,
                    })
                  }
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <button onClick={() => setPendingTransfer(null)}>취소</button>
            <button
              className="primary"
              onClick={() => guard(beginTransfer(pendingTransfer))}
            >
              계속
            </button>
          </div>
        </Modal>
      )}
      {shortcuts && (
        <Modal
          title="손끝에서 이어지는 작업"
          onClose={() => setShortcuts(false)}
        >
          <div className="shortcut-list">
            {[
              ["새 탭", "⌘ T"],
              ["탭 닫기", "⌘ W"],
              ["분할 보기", "⌘ \\"],
              ["경로 입력", "⌘ L"],
              ["폴더에서 검색", "⌘ F"],
              ["사이드바", "⌘ B"],
              ["정보 패널", "⌘ I"],
              ["새 폴더", "⌘ ⇧ N"],
              ["복사 / 잘라내기 / 붙여넣기", "⌘ C / X / V"],
              ["전체 선택", "⌘ A"],
              ["숨김 파일", "⌘ ."],
              ["미리보기 / 폴더 열기", "Space / Enter"],
              ["이름 변경", "F2"],
              ["휴지통으로 이동", "⌘ ⌫ / Delete"],
              ["새로 고침", "⌘ R / F5"],
            ].map(([label, key]) => (
              <div key={label}>
                <span>{label}</span>
                <kbd>{keyLabel(key)}</kbd>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function NameDialog({
  title,
  initial,
  onDone,
}: {
  title: string;
  initial: string;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <Modal title={title} onClose={() => onDone(null)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onDone(value);
        }}
      >
        <label>
          이름
          <input
            ref={ref}
            autoFocus
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={() => onDone(null)}>
            취소
          </button>
          <button className="primary" type="submit" disabled={!value.trim()}>
            저장
          </button>
        </div>
      </form>
    </Modal>
  );
}
function PreviewDialog({
  location,
  entry,
  onClose,
  onDownload,
  notify,
  onEdit,
}: {
  location: Location;
  entry: Entry;
  onClose: () => void;
  onDownload: () => void;
  notify: (message: string, error?: boolean) => void;
  onEdit: () => void;
}) {
  const [content, setContent] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void window.sinder
      .preview(location)
      .then((value) => {
        if (live) setContent(value);
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [location]);
  return (
    <Modal title={entry.name} wide onClose={onClose}>
      <div className="preview-meta">
        <span>
          {kindLabel(entry)} · {size(entry.size)}
        </span>
        <span>{location.connectionId === "local" ? "로컬" : "SSH 원격"}</span>
      </div>
      <div className="preview-content">
        {error ? (
          <p className="inline-error">{error}</p>
        ) : !content ? (
          <div className="loader" />
        ) : content.kind === "image" ? (
          <img src={content.content} alt={entry.name} />
        ) : content.kind === "text" ? (
          <pre>{content.content}</pre>
        ) : (
          <div className="unsupported-preview">
            <FileIcon entry={entry} large />
            <p>{content.content}</p>
          </div>
        )}
      </div>
      {content?.truncated && (
        <p className="field-help">처음 128 KB만 표시합니다.</p>
      )}
      <div className="preview-bottom">
        <span title={location.path}>{location.path}</span>
        {location.connectionId !== "local" &&
          content?.kind === "text" &&
          entry.kind === "file" &&
          entry.size <= 32 * 1024 * 1024 && (
            <button className="primary" onClick={onEdit}>
              <PencilSimple size={16} />
              원격 편집
            </button>
          )}
        {location.connectionId === "local" ? (
          <button
            onClick={() => {
              void window.sinder
                .open(location)
                .catch((e) => notify(errorText(e), true));
            }}
          >
            기본 앱에서 열기
          </button>
        ) : (
          <button onClick={onDownload}>
            <DownloadSimple size={16} />
            로컬로 다운로드
          </button>
        )}
      </div>
    </Modal>
  );
}
