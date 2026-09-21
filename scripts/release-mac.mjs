import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

if (process.platform !== "darwin")
  throw new Error("macOS release builds require a Mac.");
if (process.arch !== "arm64")
  throw new Error(
    "Build this Apple Silicon release with arm64 Node.js on an Apple Silicon Mac.",
  );
const identity = process.env.CSC_NAME;
const profile = process.env.APPLE_KEYCHAIN_PROFILE;
if (!identity?.startsWith("Developer ID Application:"))
  throw new Error(
    "Set CSC_NAME to the personal Developer ID Application identity in your keychain.",
  );
if (!profile)
  throw new Error(
    "Set APPLE_KEYCHAIN_PROFILE to a validated notarytool profile.",
  );
// Use keychain authentication only; do not accidentally select another team's
// environment-based Apple credentials in electron-builder's precedence order.
const env = { ...process.env };
for (const name of [
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
])
  delete env[name];
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}
await run("xcrun", ["notarytool", "history", "--keychain-profile", profile]);
await run("npm", ["run", "build"]);
await run(process.execPath, [
  "node_modules/electron-builder/cli.js",
  "--mac",
  "zip",
  "--arm64",
  "--publish",
  "never",
  "--config.forceCodeSigning=true",
  `--config.mac.identity=${identity.slice("Developer ID Application:".length).trim()}`,
  "--config.mac.hardenedRuntime=true",
  "--config.mac.notarize=true",
  "--config.mac.entitlements=build/entitlements.release.plist",
  "--config.mac.entitlementsInherit=build/entitlements.release.plist",
]);
const app = path.resolve("release/mac-arm64/Sinder.app");
await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
await run("xcrun", ["stapler", "validate", app]);
await run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
const { version } = JSON.parse(await fs.readFile("package.json", "utf8"));
const zip = `Sinder-${version}-arm64-mac.zip`;
const digest = createHash("sha256")
  .update(await fs.readFile(path.join("release", zip)))
  .digest("hex");
await fs.writeFile("release/SHA256SUMS.txt", `${digest}  ${zip}\n`);
console.log(`Verified release/${zip}. GitHub publication is a separate step.`);
