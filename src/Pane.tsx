import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CaretDown,
  CaretRight,
  ClipboardText,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  House,
  Info,
  List,
  MagnifyingGlass,
  PencilSimple,
  Scissors,
  SquaresFour,
  Star,
  Trash,
  X,
} from "./icons";
import type {
  Bookmark,
  Connection,
  Entry,
  Location,
  TransferRequest,
} from "../shared/types";
import { FileIcon, Tool } from "./components";
import { emptySelection, pruneSelection, selectItem } from "./selection";
import { navigatePane, type PaneState } from "./workspace";
import {
  basename,
  date,
  errorText,
  join,
  kindLabel,
  locationKey,
  parent,
  pathParts,
  size,
  shortcut,
} from "./utils";

export type { PaneState } from "./workspace";
export type Clipboard = { source: Location[]; move: boolean };
export type Command =
  | "copy"
  | "cut"
  | "paste"
  | "mkdir"
  | "rename"
  | "trash"
  | "selectAll"
  | "preview"
  | "refresh"
  | "path"
  | "filter"
  | "up"
  | "back"
  | "forward";
export type PaneHandle = { command: (command: Command) => void };
type Props = {
  state: PaneState;
  platform: string;
  active: boolean;
  connection?: Connection;
  hidden: boolean;
  refreshKey: number;
  clipboard: Clipboard | null;
  bookmarks: Bookmark[];
  onActivate: () => void;
  onChange: (state: PaneState) => void;
  onClipboard: (clipboard: Clipboard) => void;
  onPreview: (location: Location, entry: Entry) => void;
  onSelection: (entries: Entry[]) => void;
  onTransfer: (request: TransferRequest) => void;
  onBookmark: (bookmark: Bookmark) => void;
  askName: (title: string, initial: string) => Promise<string | null>;
  notify: (message: string, error?: boolean) => void;
  onReconnect: () => void;
};

const sortColumns = [
  { key: "name", label: "이름" },
  { key: "modified", label: "수정한 날짜" },
  { key: "kind", label: "종류" },
  { key: "size", label: "크기" },
] as const;

const menuCommands = [
  { command: "preview", label: "열기 / 미리보기", icon: Info, keys: "Space" },
  { command: "copy", label: "복사", icon: Copy, keys: "⌘C" },
  { command: "cut", label: "잘라내기", icon: Scissors, keys: "⌘X" },
  { command: "paste", label: "붙여넣기", icon: ClipboardText, keys: "⌘V" },
  { command: "rename", label: "이름 변경", icon: PencilSimple, keys: "F2" },
  { command: "mkdir", label: "새 폴더", icon: FolderPlus, keys: "⌘⇧N" },
  { command: "trash", label: "휴지통으로 이동", icon: Trash, keys: "⌘⌫" },
] as const;

export const Pane = forwardRef<PaneHandle, Props>(function Pane(props, ref) {
  const { state, active, connection, hidden, refreshKey, clipboard } = props;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selection, setSelection] = useState(emptySelection);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "grid">(() =>
    localStorage.getItem("sinder-view") === "grid" ? "grid" : "list",
  );
  const [sort, setSort] = useState<"name" | "modified" | "size" | "kind">(
    "name",
  );
  const [descending, setDescending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pathInput, setPathInput] = useState(state.location.path);
  const [context, setContext] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const pathRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const loadedLocation = useRef("");
  const listing = useRef(false);
  const current = useRef(props);
  current.current = props;
  const load = useCallback(
    async (quiet = false) => {
      const seq = ++sequence.current;
      listing.current = true;
      if (!quiet) setLoading(true);
      try {
        const result = await window.sinder.list(state.location);
        if (
          seq !== sequence.current ||
          locationKey(current.current.state.location) !==
            locationKey(state.location)
        )
          return;
        setEntries(result.entries);
        setError("");
        if (result.path !== state.location.path) {
          const s = current.current.state;
          const location = { ...s.location, path: result.path };
          current.current.onChange({
            ...s,
            location,
            history: s.history.map((h, i) => (i === s.cursor ? location : h)),
          });
        }
      } catch (err) {
        if (
          seq === sequence.current &&
          locationKey(current.current.state.location) ===
            locationKey(state.location)
        ) {
          setError(errorText(err));
        }
      } finally {
        if (seq === sequence.current) {
          listing.current = false;
          setLoading(false);
        }
      }
    },
    [state.location.connectionId, state.location.path],
  );
  useEffect(() => {
    const key = locationKey(state.location);
    if (loadedLocation.current !== key) {
      loadedLocation.current = key;
      setSelection(emptySelection());
      setQuery("");
      setEntries([]);
      setError("");
      setPathInput(state.location.path);
      setEditing(false);
      setContext(null);
    }
    void load();
    return () => {
      sequence.current++;
    };
  }, [load, refreshKey]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && !listing.current && !error) void load(true);
    }, 5000);
    return () => clearInterval(timer);
  }, [load, error]);
  useEffect(() => {
    if (editing) {
      pathRef.current?.focus();
      pathRef.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    if (!context) return;
    const menu = menuRef.current;
    if (menu) {
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(context.x, innerWidth - rect.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(context.y, innerHeight - rect.height - 8))}px`;
      (
        menu.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? menu
      ).focus();
    }
    const outside = (event: MouseEvent) => {
      if (!menu?.contains(event.target as Node)) setContext(null);
    };
    const close = () => setContext(null);
    window.addEventListener("mousedown", outside);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("blur", close);
    };
  }, [context]);
  const visible = useMemo(
    () =>
      entries
        .filter(
          (e) =>
            (hidden || !e.hidden) &&
            e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )
        .sort((a, b) => {
          if ((a.kind === "directory") !== (b.kind === "directory"))
            return a.kind === "directory" ? -1 : 1;
          const comparison =
            sort === "name"
              ? a.name.localeCompare(b.name, "ko", {
                  numeric: true,
                  sensitivity: "base",
                })
              : sort === "kind"
                ? kindLabel(a).localeCompare(kindLabel(b))
                : a[sort] - b[sort];
          return (descending ? -1 : 1) * comparison;
        }),
    [entries, hidden, query, sort, descending],
  );
  const visiblePaths = useMemo(
    () => visible.map((entry) => entry.path),
    [visible],
  );
  const selected = selection.paths;
  const selectedEntries = useMemo(
    () => visible.filter((entry) => selected.includes(entry.path)),
    [visible, selected],
  );
  const cursorIndex = visiblePaths.indexOf(selection.cursor ?? "");
  const itemId = (index: number) => `pane-${state.id}-item-${index}`;
  useEffect(() => {
    setSelection((previous) => pruneSelection(previous, visiblePaths));
  }, [visiblePaths]);
  useEffect(() => {
    if (active) props.onSelection(selectedEntries);
  }, [selectedEntries, active]);
  const locations = () =>
    selectedEntries.map((e) => ({ ...state.location, path: e.path }));
  const navigate = (location: Location) => {
    props.onChange(navigatePane(state, location));
  };
  function history(delta: number) {
    const cursor = state.cursor + delta;
    if (cursor >= 0 && cursor < state.history.length)
      props.onChange({ ...state, cursor, location: state.history[cursor] });
  }
  async function open(entry: Entry) {
    const location = { ...state.location, path: entry.path };
    if (entry.kind === "directory") navigate(location);
    else if (entry.kind === "symlink") {
      try {
        const result = await window.sinder.list(location);
        navigate({ ...location, path: result.path });
      } catch {
        props.onPreview(location, entry);
      }
    } else props.onPreview(location, entry);
  }
  const perform = async (command: Command) => {
    setContext(null);
    if (context) listRef.current?.focus();
    try {
      if (command === "refresh") {
        await load();
        return;
      }
      if (command === "path") {
        setPathInput(state.location.path);
        setEditing(true);
        return;
      }
      if (command === "filter") {
        filterRef.current?.focus();
        filterRef.current?.select();
        return;
      }
      if (command === "back") {
        history(-1);
        return;
      }
      if (command === "forward") {
        history(1);
        return;
      }
      if (command === "up") {
        navigate({ ...state.location, path: parent(state.location.path) });
        return;
      }
      if (command === "selectAll") {
        setSelection({
          paths: visiblePaths,
          anchor: visiblePaths[0] ?? null,
          cursor: visiblePaths.at(-1) ?? null,
        });
        return;
      }
      if (command === "copy" || command === "cut") {
        if (selectedEntries.length) {
          props.onClipboard({ source: locations(), move: command === "cut" });
          props.notify(
            `${selectedEntries.length}개 항목 ${command === "cut" ? "잘라내기" : "복사"} · 목적지에서 붙여넣기`,
          );
        }
        return;
      }
      if (command === "paste") {
        if (clipboard)
          props.onTransfer({
            ...clipboard,
            destination: state.location,
            conflict: "keep-both",
          });
        return;
      }
      if (command === "preview") {
        if (selectedEntries[0]) await open(selectedEntries[0]);
        return;
      }
      if (loading || error) return;
      if (command === "mkdir") {
        const name = await props.askName("새 폴더", "새 폴더");
        if (name) {
          await window.sinder.mkdir(state.location, name);
          await load(true);
          const path = join(state.location.path, name);
          setSelection({ paths: [path], anchor: path, cursor: path });
        }
      }
      if (command === "rename" && selectedEntries.length === 1) {
        const name = await props.askName("이름 변경", selectedEntries[0].name);
        if (name && name !== selectedEntries[0].name) {
          await window.sinder.rename(locations()[0], name);
          await load(true);
          const path = join(state.location.path, name);
          setSelection({ paths: [path], anchor: path, cursor: path });
        }
      }
      if (command === "trash" && selectedEntries.length) {
        await window.sinder.trash(locations());
        await load(true);
      }
    } catch (err) {
      props.notify(errorText(err), true);
    }
  };
  useImperativeHandle(ref, () => ({
    command: (c) => {
      void perform(c);
    },
  }));
  function select(entry: Entry, event: React.MouseEvent) {
    props.onActivate();
    setSelection((previous) =>
      selectItem(
        previous,
        visiblePaths,
        entry.path,
        event.shiftKey
          ? "extend"
          : event.metaKey || event.ctrlKey
            ? "toggle"
            : "replace",
      ),
    );
    listRef.current?.focus();
  }
  function closeContext() {
    setContext(null);
    listRef.current?.focus();
  }
  function listKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (
      event.key === "ContextMenu" ||
      (event.key === "F10" && event.shiftKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      const item =
        cursorIndex >= 0
          ? document.getElementById(itemId(cursorIndex))
          : listRef.current;
      const rect = item?.getBoundingClientRect();
      if (rect)
        setContext({
          x: rect.left + 20,
          y: rect.top + Math.min(rect.height, 30),
        });
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const columns =
      view === "grid" && listRef.current
        ? getComputedStyle(listRef.current).gridTemplateColumns.split(" ")
            .length
        : 1;
    const delta =
      event.key === "ArrowDown"
        ? columns
        : event.key === "ArrowUp"
          ? -columns
          : view === "grid" && event.key === "ArrowRight"
            ? 1
            : view === "grid" && event.key === "ArrowLeft"
              ? -1
              : 0;
    if (delta || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next =
        event.key === "End"
          ? visible.length - 1
          : event.key === "Home" || cursorIndex < 0
            ? 0
            : Math.max(0, Math.min(visible.length - 1, cursorIndex + delta));
      const entry = visible[next];
      if (entry) {
        setSelection((previous) =>
          selectItem(
            previous,
            visiblePaths,
            entry.path,
            event.shiftKey ? "extend" : "replace",
          ),
        );
        document
          .getElementById(itemId(next))
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setSelection(emptySelection());
      setQuery("");
    }
  }
  function drop(event: React.DragEvent, destination = state.location) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(false);
    try {
      const internal = event.dataTransfer.getData("application/x-sinder");
      const source: Location[] = internal
        ? JSON.parse(internal)
        : Array.from(event.dataTransfer.files)
            .map((file) => ({
              connectionId: "local",
              path: window.sinder.pathForFile(file),
            }))
            .filter((l) => l.path);
      if (Array.isArray(source) && source.length)
        props.onTransfer({
          source,
          destination,
          move: event.shiftKey,
          conflict: "keep-both",
        });
    } catch {
      props.notify(
        "드래그한 파일을 읽지 못했습니다. 파일 선택 후 복사·붙여넣기를 사용해 주세요.",
        true,
      );
    }
  }
  const { root, pieces } = pathParts(state.location.path);
  const pinned = props.bookmarks.some(
    (b) => locationKey(b.location) === locationKey(state.location),
  );
  const changeSort = (value: typeof sort) => {
    if (sort === value) setDescending(!descending);
    else {
      setSort(value);
      setDescending(false);
    }
  };
  const disabledCommands: Partial<Record<Command, boolean>> = {
    preview: !selectedEntries.length,
    copy: !selectedEntries.length,
    cut: !selectedEntries.length,
    paste: !clipboard || loading || !!error,
    rename: selectedEntries.length !== 1 || loading || !!error,
    mkdir: loading || !!error,
    trash: !selectedEntries.length || loading || !!error,
  };
  const connectionLabel = `${connection?.name ?? "연결 없음"} · ${connection?.kind === "ssh" ? "SSH" : "LOCAL"} · ${connection?.status === "connected" ? "연결됨" : "연결 끊김"}`;
  return (
    <section
      className={`pane ${active ? "pane-active" : ""}`}
      onMouseDown={props.onActivate}
      onFocusCapture={props.onActivate}
      aria-label={`${connection?.name ?? "위치"} 파일 탐색기`}
    >
      <div className="pathbar">
        <div className="pane-navigation" role="group" aria-label="폴더 탐색">
          <Tool
            label="이전 폴더"
            disabled={state.cursor === 0}
            onClick={() => history(-1)}
          >
            <ArrowLeft size={16} />
          </Tool>
          <Tool
            label="다음 폴더"
            disabled={state.cursor === state.history.length - 1}
            onClick={() => history(1)}
          >
            <ArrowRight size={16} />
          </Tool>
          <Tool
            label="상위 폴더"
            disabled={state.location.path === root}
            onClick={() => {
              void perform("up");
            }}
          >
            <ArrowUp size={16} />
          </Tool>
        </div>
        {editing ? (
          <form
            className="path-form"
            onSubmit={(event) => {
              event.preventDefault();
              navigate({ ...state.location, path: pathInput });
              setEditing(false);
              listRef.current?.focus();
            }}
          >
            <input
              ref={pathRef}
              aria-label="폴더 경로"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditing(false);
                  listRef.current?.focus();
                }
              }}
              onBlur={() => setEditing(false)}
            />
          </form>
        ) : (
          <div
            className="breadcrumbs"
            onDoubleClick={() => {
              setPathInput(state.location.path);
              setEditing(true);
            }}
          >
            <button
              aria-label="루트 폴더"
              title={root}
              onClick={() => navigate({ ...state.location, path: root })}
            >
              <House size={15} />
            </button>
            {pieces.length > 3 && (
              <button
                aria-label="전체 경로 입력"
                title={state.location.path}
                onClick={() => {
                  setPathInput(state.location.path);
                  setEditing(true);
                }}
              >
                …
              </button>
            )}
            {pieces.map((piece, i) =>
              i < pieces.length - 3 ? null : (
                <span key={i}>
                  <CaretRight size={11} />
                  <button
                    onClick={() =>
                      navigate({
                        ...state.location,
                        path:
                          root +
                          pieces
                            .slice(0, i + 1)
                            .join(root.includes("\\") ? "\\" : "/"),
                      })
                    }
                  >
                    {piece}
                  </button>
                </span>
              ),
            )}
            <button
              className="path-edit"
              aria-label="경로 입력"
              title={`경로 입력 (${shortcut(props.platform, "⌘L")})`}
              onClick={() => {
                setPathInput(state.location.path);
                setEditing(true);
              }}
            >
              <PencilSimple size={13} />
            </button>
          </div>
        )}
        <Tool
          label={pinned ? "즐겨찾기에 추가됨" : "이 폴더 즐겨찾기"}
          active={pinned}
          onClick={() =>
            props.onBookmark({
              id: crypto.randomUUID(),
              name: basename(state.location.path),
              location: state.location,
            })
          }
        >
          <Star size={16} weight={pinned ? "fill" : "regular"} />
        </Tool>
        <Tool
          label="새로 고침"
          onClick={() => {
            void load();
          }}
        >
          <ArrowClockwise size={16} className={loading ? "spinning" : ""} />
        </Tool>
      </div>
      <div className="pane-controls">
        <span
          className="pane-connection"
          title={connectionLabel}
          aria-label={connectionLabel}
        >
          <span
            className={`status-dot ${connection?.status === "connected" ? "online" : ""}`}
          />
          <span className="pane-connection-name">
            {connection?.name ?? "연결 없음"}
          </span>
          <span className="connection-type">
            {connection?.kind === "ssh" ? "SSH" : "LOCAL"}
          </span>
        </span>
        <div className="folder-search">
          <MagnifyingGlass size={16} />
          <input
            ref={filterRef}
            aria-label="이 폴더에서 검색"
            placeholder="이름으로 필터"
            title={`이 폴더의 파일 이름으로 필터 (${shortcut(props.platform, "⌘F")})`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
                listRef.current?.focus();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                listRef.current?.focus();
                if (visible[0])
                  setSelection((previous) =>
                    selectItem(previous, visiblePaths, visible[0].path),
                  );
              }
            }}
          />
          {query && (
            <button
              aria-label="검색 지우기"
              onClick={() => {
                setQuery("");
                filterRef.current?.focus();
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
        <div className="segmented">
          <Tool
            label="목록 보기"
            active={view === "list"}
            aria-pressed={view === "list"}
            onClick={() => {
              setView("list");
              localStorage.setItem("sinder-view", "list");
            }}
          >
            <List size={18} />
          </Tool>
          <Tool
            label="아이콘 보기"
            active={view === "grid"}
            aria-pressed={view === "grid"}
            onClick={() => {
              setView("grid");
              localStorage.setItem("sinder-view", "grid");
            }}
          >
            <SquaresFour size={18} />
          </Tool>
        </div>
      </div>
      <div className="list-heading">
        {sortColumns.map(({ key, label }) => {
          const button = (
            <button
              key={key}
              className={`sort-${key}-button`}
              title={`${label} 정렬${sort === key ? (descending ? " · 내림차순" : " · 오름차순") : ""}`}
              onClick={() => changeSort(key)}
            >
              {label}
              {sort === key && (
                <CaretDown className={descending ? "" : "rotated"} size={11} />
              )}
            </button>
          );
          return (
            <div className={`sort-${key}`} key={key}>
              {button}
              {key === "name" && (
                <select
                  className="sort-picker"
                  aria-label="정렬"
                  value={`${sort}:${descending ? "desc" : "asc"}`}
                  onChange={(event) => {
                    const [column, direction] = event.target.value.split(":");
                    setSort(column as typeof sort);
                    setDescending(direction === "desc");
                  }}
                >
                  {sortColumns.flatMap((column) => [
                    <option
                      key={`${column.key}:asc`}
                      value={`${column.key}:asc`}
                    >
                      {column.label} · 오름차순
                    </option>,
                    <option
                      key={`${column.key}:desc`}
                      value={`${column.key}:desc`}
                    >
                      {column.label} · 내림차순
                    </option>,
                  ])}
                </select>
              )}
            </div>
          );
        })}
      </div>
      {error && entries.length > 0 && (
        <div className="pane-error" role="alert">
          <span>{error}</span>
          <button
            onClick={
              connection?.status === "disconnected"
                ? props.onReconnect
                : () => {
                    void load();
                  }
            }
          >
            {connection?.status === "disconnected" ? "다시 연결" : "다시 시도"}
          </button>
        </div>
      )}
      <div
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-label="파일 목록"
        aria-multiselectable="true"
        aria-activedescendant={
          cursorIndex >= 0 ? itemId(cursorIndex) : undefined
        }
        aria-busy={loading}
        className={`file-area ${view} ${dragOver ? "drop-target" : ""}`}
        onDragOver={(event) => {
          if (
            event.dataTransfer.types.includes("application/x-sinder") ||
            event.dataTransfer.types.includes("Files")
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = event.shiftKey ? "move" : "copy";
            setDragOver(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            setDragOver(false);
        }}
        onDrop={(event) => drop(event)}
        onClick={(event) => {
          if (event.target === event.currentTarget)
            setSelection(emptySelection());
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setContext({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={listKeyDown}
      >
        {loading && entries.length === 0 ? (
          <div className="empty-state">
            <div className="loader" />
            <p>파일을 불러오는 중…</p>
          </div>
        ) : error && entries.length === 0 ? (
          <div className="empty-state">
            <FolderOpen size={42} weight="duotone" />
            <h3>폴더를 열지 못했습니다</h3>
            <p>{error}</p>
            <button
              onClick={
                connection?.status === "disconnected"
                  ? props.onReconnect
                  : () => {
                      void load();
                    }
              }
            >
              {connection?.status === "disconnected"
                ? "다시 연결"
                : "다시 시도"}
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state">
            <Folder size={48} weight="duotone" />
            <h3>{query ? "일치하는 항목이 없습니다" : "비어 있는 폴더"}</h3>
            <p>
              {query
                ? "다른 이름으로 검색해 보세요."
                : "파일을 이곳으로 옮기거나 새 폴더를 만드세요."}
            </p>
            {!query && (
              <button
                onClick={() => {
                  void perform("mkdir");
                }}
              >
                <FolderPlus size={16} />새 폴더
              </button>
            )}
          </div>
        ) : (
          visible.map((entry, index) => (
            <div
              key={entry.path}
              id={itemId(index)}
              data-index={index}
              role="option"
              aria-selected={selected.includes(entry.path)}
              aria-label={entry.name}
              draggable
              className={`file-item ${selected.includes(entry.path) ? "selected" : ""} ${selection.cursor === entry.path ? "is-cursor" : ""} ${entry.hidden ? "hidden-file" : ""} ${clipboard?.move && clipboard.source.some((l) => l.connectionId === state.location.connectionId && l.path === entry.path) ? "cut-file" : ""}`}
              onClick={(event) => select(entry, event)}
              onDoubleClick={() => {
                void open(entry);
              }}
              onContextMenu={() => {
                setSelection((previous) =>
                  selected.includes(entry.path)
                    ? { ...previous, cursor: entry.path }
                    : selectItem(previous, visiblePaths, entry.path),
                );
              }}
              onDragStart={(event) => {
                const source = selected.includes(entry.path)
                  ? locations()
                  : [{ ...state.location, path: entry.path }];
                if (!selected.includes(entry.path))
                  setSelection((previous) =>
                    selectItem(previous, visiblePaths, entry.path),
                  );
                event.dataTransfer.setData(
                  "application/x-sinder",
                  JSON.stringify(source),
                );
                event.dataTransfer.effectAllowed = "copyMove";
              }}
              onDragOver={(event) => {
                if (
                  entry.kind === "directory" &&
                  (event.dataTransfer.types.includes("application/x-sinder") ||
                    event.dataTransfer.types.includes("Files"))
                ) {
                  event.preventDefault();
                  event.currentTarget.classList.add("folder-drop");
                }
              }}
              onDragLeave={(event) =>
                event.currentTarget.classList.remove("folder-drop")
              }
              onDrop={(event) => {
                event.currentTarget.classList.remove("folder-drop");
                if (entry.kind === "directory")
                  drop(event, { ...state.location, path: entry.path });
              }}
            >
              <span className="name-cell">
                <FileIcon entry={entry} large={view === "grid"} />
                <span title={entry.name}>{entry.name}</span>
              </span>
              <span className="date-cell">{date(entry.modified)}</span>
              <span className="kind-cell">{kindLabel(entry)}</span>
              <span className="size-cell">
                {entry.kind === "directory" ? "—" : size(entry.size)}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="pane-footer">
        <span>
          {selected.length
            ? `${selected.length}개 선택`
            : `${visible.length.toLocaleString()}개 항목`}
          {query && ` / ${entries.length}`}
        </span>
        <span>
          {selected.length
            ? size(
                selectedEntries
                  .filter((e) => e.kind === "file")
                  .reduce((n, e) => n + e.size, 0),
              )
            : hidden
              ? "숨김 파일 표시 중"
              : ""}
        </span>
        <span className="footer-path" title={state.location.path}>
          {state.location.path}
        </span>
      </div>
      {context &&
        createPortal(
          <div
            ref={menuRef}
            className="context-menu"
            role="menu"
            tabIndex={-1}
            aria-label="파일 작업"
            style={{ left: context.x, top: context.y }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                closeContext();
              } else if (
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                );
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              } else if (event.key === "Tab") {
                event.preventDefault();
                closeContext();
              }
            }}
          >
            {menuCommands.map(({ command, label, icon: Icon, keys }) => (
              <div key={command} role="none">
                {(command === "rename" || command === "trash") && <hr />}
                <button
                  role="menuitem"
                  disabled={disabledCommands[command]}
                  className={command === "trash" ? "danger-text" : undefined}
                  onClick={() => {
                    void perform(command);
                  }}
                >
                  <Icon size={16} />
                  {label}
                  <span>
                    {command === "trash" && props.platform !== "darwin"
                      ? "Delete"
                      : shortcut(props.platform, keys)}
                  </span>
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </section>
  );
});
