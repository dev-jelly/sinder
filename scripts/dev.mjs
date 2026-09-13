import { spawn } from "node:child_process";
const build = spawn("npm", ["run", "build"], { stdio: "inherit" });
build.on("exit", (code) => {
  if (code) process.exit(code);
  const app = spawn("node_modules/.bin/electron", ["."], {
    stdio: "inherit",
    env: { ...process.env, SINDER_DEV: "1" },
  });
  app.on("exit", (status) => process.exit(status ?? 0));
});
