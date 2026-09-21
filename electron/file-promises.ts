import { createRequire } from "node:module";
import type { BrowserWindow } from "electron";

type Complete = (
  error: string | null,
  localPath?: string,
) => Promise<void> | void;
const deliveries = new Set<Promise<void>>();
export const activeFilePromises = () => deliveries.size;
export const waitForFilePromises = () => Promise.allSettled([...deliveries]);
type NativePromises = {
  startDrag(
    handle: Buffer,
    entries: { name: string; directory: boolean }[],
    payload: string,
    request: (index: number, complete: Complete) => void,
  ): void;
};
const native: NativePromises | null =
  process.platform === "darwin"
    ? createRequire(import.meta.url)(
        "../../native/build/Release/sinder_file_promises.node",
      )
    : null;

export function startFilePromises(
  window: BrowserWindow,
  entries: { name: string; directory: boolean }[],
  payload: string,
  download: (index: number) => Promise<string>,
  onError: (message: string) => void,
) {
  if (!native)
    throw new Error("이 운영체제에서는 외부로 꺼내기를 사용해 주세요.");
  native.startDrag(
    window.getNativeWindowHandle(),
    entries,
    payload,
    (index, complete) => {
      const delivery = (async () => {
        try {
          await complete(null, await download(index));
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await complete(message);
          onError(message);
        }
      })();
      deliveries.add(delivery);
      void delivery.finally(() => deliveries.delete(delivery));
    },
  );
}
