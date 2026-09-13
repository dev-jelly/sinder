export type Selection = {
  paths: string[];
  anchor: string | null;
  cursor: string | null;
};

export const emptySelection = (): Selection => ({
  paths: [],
  anchor: null,
  cursor: null,
});

export function pruneSelection(
  selection: Selection,
  visible: string[],
): Selection {
  const available = new Set(visible);
  const paths = selection.paths.filter((path) => available.has(path));
  const cursor =
    selection.cursor && available.has(selection.cursor)
      ? selection.cursor
      : (paths.at(-1) ?? null);
  const anchor =
    selection.anchor && available.has(selection.anchor)
      ? selection.anchor
      : cursor;
  return paths.length === selection.paths.length &&
    cursor === selection.cursor &&
    anchor === selection.anchor
    ? selection
    : { paths, cursor, anchor };
}

export function selectItem(
  selection: Selection,
  visible: string[],
  path: string,
  mode: "replace" | "extend" | "toggle" = "replace",
): Selection {
  if (!visible.includes(path)) return pruneSelection(selection, visible);
  const current = pruneSelection(selection, visible);
  if (mode === "extend") {
    const anchor = current.anchor ?? current.cursor ?? path;
    const start = visible.indexOf(anchor);
    const end = visible.indexOf(path);
    return {
      paths: visible.slice(Math.min(start, end), Math.max(start, end) + 1),
      anchor,
      cursor: path,
    };
  }
  return {
    paths:
      mode === "toggle"
        ? current.paths.includes(path)
          ? current.paths.filter((item) => item !== path)
          : [...current.paths, path]
        : [path],
    anchor: path,
    cursor: path,
  };
}
