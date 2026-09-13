export type Location = { connectionId: string; path: string };
export type Entry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
  size: number;
  modified: number;
  mode: number;
  hidden: boolean;
};
export type Profile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: "agent" | "key" | "password";
  keyPath?: string;
  initialPath: string;
  sshConfigHost?: string;
};
export type SshConfigEntry = {
  alias: string;
  aliases: string[];
  profile: Profile;
  route: "direct" | "proxy" | "jump";
  issue?: string;
};
export type SshConfigSnapshot = {
  path: string;
  exists: boolean;
  entries: SshConfigEntry[];
};
export type Credentials = { password?: string; passphrase?: string };
export type CancelConnectionResult = "cancelled" | "committed";
export type Connection = {
  id: string;
  name: string;
  kind: "local" | "ssh";
  status: "connected" | "disconnected";
  home: string;
  host?: string;
};
export type Bookmark = { id: string; name: string; location: Location };
export type Transfer = {
  id: string;
  label: string;
  source: Location[];
  destination: Location;
  move: boolean;
  status: "queued" | "running" | "done" | "cancelled" | "error";
  bytes: number;
  total: number;
  files: number;
  error?: string;
  started: number;
};
export type TransferRequest = {
  source: Location[];
  destination: Location;
  move: boolean;
  conflict: "skip" | "keep-both" | "error";
};
export type Preview = {
  kind: "text" | "image" | "unsupported";
  content: string;
  truncated?: boolean;
};
export const editActions = [
  "open",
  "server-copy",
  "retry",
  "apply-local",
  "pause",
  "reveal",
] as const;
export type EditAction = (typeof editActions)[number];
export type EditSession = {
  id: string;
  name: string;
  location: Location;
  localPath: string;
  status:
    | "clean"
    | "pending"
    | "uploading"
    | "offline"
    | "conflict"
    | "error"
    | "paused";
  error?: string;
  updated: number;
  backupLocation?: Location;
  backupCount: number;
  backupLocations: Location[];
};
export type Bootstrap = {
  connections: Connection[];
  profiles: Profile[];
  bookmarks: Bookmark[];
  home: string;
  platform: string;
  transfers: Transfer[];
  edits: EditSession[];
};
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface SinderAPI {
  bootstrap(): Promise<Bootstrap>;
  list(location: Location): Promise<{ path: string; entries: Entry[] }>;
  mkdir(location: Location, name: string): Promise<void>;
  rename(location: Location, name: string): Promise<void>;
  trash(locations: Location[]): Promise<void>;
  preview(location: Location): Promise<Preview>;
  open(location: Location): Promise<void>;
  reveal(location: Location): Promise<void>;
  connect(profile: Profile, credentials: Credentials): Promise<Connection>;
  cancelConnection(id: string): Promise<CancelConnectionResult>;
  disconnect(id: string): Promise<void>;
  removeProfile(id: string): Promise<void>;
  readSshConfig(): Promise<SshConfigSnapshot>;
  importSshConfig(): Promise<{ added: number; skipped: number }>;
  pickKey(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  pathForFile(file: File): string;
  bookmarks(bookmarks: Bookmark[]): Promise<void>;
  transfer(request: TransferRequest): Promise<string>;
  cancelTransfer(id: string): Promise<void>;
  editRemote(location: Location): Promise<EditSession>;
  editAction(id: string, action: EditAction): Promise<void>;
  chooseEditor(): Promise<string | null>;
  onEdits(callback: (sessions: EditSession[]) => void): () => void;
  onEditError(callback: (message: string) => void): () => void;
  onTransfers(callback: (transfers: Transfer[]) => void): () => void;
  onConnections(callback: (connections: Connection[]) => void): () => void;
}
