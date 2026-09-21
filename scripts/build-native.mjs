import { spawnSync } from "node:child_process";
if (process.platform === "darwin") {
  // Node-API has a stable ABI, so this module also loads in Electron. Use the
  // installed Node headers; there are no V8 or Electron-private dependencies.
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/node-gyp/bin/node-gyp.js",
      "rebuild",
      "--directory",
      "native",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
