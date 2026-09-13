import { useEffect, useRef, useState } from "react";
import { CaretRight, Folder } from "./icons";
import type { Entry, Location } from "../shared/types";
import { basename, errorText, locationKey } from "./utils";

export function FolderTree({
  root,
  current,
  hidden,
  refreshKey,
  onNavigate,
}: {
  root: Location;
  current: Location;
  hidden: boolean;
  refreshKey: number;
  onNavigate: (location: Location) => void;
}) {
  const treeRef = useRef<HTMLDivElement>(null);
  const focusedItem = useRef<HTMLElement | null>(null);
  const rootKey = locationKey(root);
  const [focused, setFocused] = useState(rootKey);
  useEffect(() => {
    const tree = treeRef.current!;
    const repairFocus = () => {
      const items = Array.from(
        tree.querySelectorAll<HTMLElement>('[role="treeitem"]'),
      );
      setFocused((key) =>
        items.some((item) => item.dataset.treeKey === key) ? key : rootKey,
      );
      if (
        focusedItem.current &&
        !focusedItem.current.isConnected &&
        document.activeElement === document.body
      )
        items[0]?.focus();
    };
    repairFocus();
    const observer = new MutationObserver(repairFocus);
    observer.observe(tree, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rootKey]);
  return (
    <div
      ref={treeRef}
      className="folder-tree"
      role="tree"
      aria-label="폴더 트리"
      onFocus={(event) => {
        const item = (event.target as HTMLElement).closest<HTMLElement>(
          '[role="treeitem"]',
        );
        focusedItem.current = item;
        const key = item?.dataset.treeKey;
        if (key) setFocused(key);
      }}
    >
      <TreeNode
        key={locationKey(root)}
        location={root}
        name={basename(root.path)}
        current={current}
        hidden={hidden}
        refreshKey={refreshKey}
        onNavigate={onNavigate}
        depth={0}
        focused={focused}
      />
    </div>
  );
}
function TreeNode({
  location,
  name,
  current,
  hidden,
  refreshKey,
  onNavigate,
  depth,
  focused,
}: {
  location: Location;
  name: string;
  current: Location;
  hidden: boolean;
  refreshKey: number;
  onNavigate: (location: Location) => void;
  depth: number;
  focused: string;
}) {
  const itemRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const visible = children.filter((entry) => hidden || !entry.hidden);
  const key = locationKey(location);
  useEffect(() => {
    if (!expanded) return;
    let live = true;
    setLoading(true);
    setError("");
    void window.sinder
      .list(location)
      .then((result) => {
        if (live)
          setChildren(
            result.entries
              .filter((e) => e.kind === "directory")
              .sort((a, b) =>
                a.name.localeCompare(b.name, "ko", { numeric: true }),
              ),
          );
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [expanded, location.connectionId, location.path, refreshKey]);
  function handleKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (
      ![
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "ArrowRight",
        "ArrowLeft",
        "Enter",
        " ",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const item = event.currentTarget;
    if (event.key === "Enter" || event.key === " ") {
      onNavigate(location);
    } else if (event.key === "ArrowRight") {
      if (!expanded) setExpanded(true);
      else
        item
          .querySelector<HTMLElement>(
            ':scope > [role="group"] > [role="treeitem"]',
          )
          ?.focus();
    } else if (event.key === "ArrowLeft") {
      if (expanded) setExpanded(false);
      else
        item.parentElement?.closest<HTMLElement>('[role="treeitem"]')?.focus();
    } else {
      const items = Array.from(
        item
          .closest('[role="tree"]')!
          .querySelectorAll<HTMLElement>('[role="treeitem"]'),
      );
      const index = items.indexOf(item);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : Math.max(
                0,
                Math.min(
                  items.length - 1,
                  index + (event.key === "ArrowDown" ? 1 : -1),
                ),
              );
      items[next]?.focus();
    }
  }
  return (
    <div
      ref={itemRef}
      role="treeitem"
      aria-label={name}
      aria-level={depth + 1}
      aria-expanded={expanded}
      aria-selected={key === locationKey(current)}
      aria-busy={expanded && loading}
      data-tree-key={key}
      tabIndex={focused === key ? 0 : -1}
      onKeyDown={handleKey}
    >
      <div
        className={`tree-row ${key === locationKey(current) ? "tree-current" : ""}`}
        style={{ paddingLeft: 4 + depth * 13 }}
      >
        <button
          tabIndex={-1}
          aria-label={`${name} ${expanded ? "접기" : "펼치기"}`}
          onClick={() => {
            itemRef.current?.focus();
            setExpanded(!expanded);
          }}
        >
          <CaretRight size={11} className={expanded ? "tree-expanded" : ""} />
        </button>
        <button
          tabIndex={-1}
          title={location.path}
          onClick={() => {
            itemRef.current?.focus();
            onNavigate(location);
          }}
        >
          <Folder size={15} weight="duotone" />
          <span>{name}</span>
        </button>
      </div>
      {expanded && (
        <div role="group">
          {loading && visible.length === 0 && (
            <p className="tree-note">불러오는 중…</p>
          )}
          {error && (
            <p className="tree-note" role="alert">
              {error}
            </p>
          )}
          {visible.map((child) => (
            <TreeNode
              key={child.path}
              location={{
                connectionId: location.connectionId,
                path: child.path,
              }}
              name={child.name}
              current={current}
              hidden={hidden}
              refreshKey={refreshKey}
              onNavigate={onNavigate}
              depth={depth + 1}
              focused={focused}
            />
          ))}
          {!loading && !error && visible.length === 0 && (
            <p className="tree-note">하위 폴더 없음</p>
          )}
        </div>
      )}
    </div>
  );
}
