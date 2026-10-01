import type { Provider } from "./providers.js";

export async function listLocation(provider: Provider, requestedPath: string) {
  const path = await provider.realpath(requestedPath);
  const entry = await provider.stat(path);
  if (entry.kind !== "directory") {
    return {
      path: provider.paths.dirname(path),
      entries: [entry],
      target: entry.path,
    };
  }
  return { path, entries: await provider.list(path) };
}
