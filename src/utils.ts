import type { Entry, Location } from "../shared/types";
export function size(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** i).toLocaleString("ko-KR", { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}
export const basename = (p: string) =>
  p.split(/[/\\]/).filter(Boolean).pop() ?? p;
export function pathParts(p: string) {
  const root =
    p.match(
      /^[/\\]{2}[^/\\]+[/\\][^/\\]+(?:[/\\]|$)|^[A-Za-z]:[/\\]|^\//,
    )?.[0] ?? "";
  return { root, pieces: p.slice(root.length).split(/[/\\]/).filter(Boolean) };
}
export function parent(p: string) {
  const drive = p.match(/^[A-Za-z]:[/\\]/)?.[0];
  const unc = p.match(/^[/\\]{2}[^/\\]+[/\\][^/\\]+(?:[/\\]|$)/)?.[0];
  const root = drive ?? unc ?? (p.startsWith("/") ? "/" : "");
  const trimmed = p.replace(/[/\\]+$/, "");
  if (root && trimmed.length <= root.replace(/[/\\]+$/, "").length) return root;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return p;
  return index < root.length ? root : trimmed.slice(0, index);
}
export const join = (p: string, name: string) =>
  p.replace(/[/\\]$/, "") + (p.includes("\\") ? "\\" : "/") + name;
export const locationKey = (l: Location) => `${l.connectionId}:${l.path}`;
export function shortcut(platform: string, keys: string) {
  return platform === "darwin"
    ? keys
    : keys
        .replace(/⌘\s*/g, "Ctrl+")
        .replace(/⇧\s*/g, "Shift+")
        .replaceAll("⌫", "Backspace");
}
export const kindLabel = (entry: Entry) =>
  entry.kind === "directory"
    ? "폴더"
    : entry.kind === "symlink"
      ? "심볼릭 링크"
      : entry.name.includes(".")
        ? entry.name.split(".").pop()!.toUpperCase() + " 파일"
        : "파일";
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export const date = (timestamp: number) =>
  new Date(timestamp).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
