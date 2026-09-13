import fs from "node:fs/promises";
import { durableJson } from "./durable-json.js";
import type { Bookmark, Profile } from "../shared/types.js";

export type Settings = {
  profiles: Profile[];
  bookmarks: Bookmark[];
  hosts: Record<string, string>;
  editorPath?: string;
};
export class Store {
  data: Settings = { profiles: [], bookmarks: [], hosts: {} };
  private pending = Promise.resolve();
  constructor(private filename: string) {}
  async load() {
    try {
      this.data = {
        ...this.data,
        ...JSON.parse(await fs.readFile(this.filename, "utf8")),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "설정 파일을 읽지 못했습니다. 원본을 보존하고 앱을 종료합니다.",
          { cause: error },
        );
    }
  }
  save() {
    const snapshot = structuredClone(this.data);
    this.pending = this.pending
      .catch(() => {})
      .then(() => durableJson(this.filename, snapshot));
    return this.pending;
  }
}
