import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export async function startSshd() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sinder-sshd-"));
  const run = promisify(execFile);
  await run("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    path.join(root, "host"),
  ]);
  await run("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    path.join(root, "identity"),
  ]);
  await fs.copyFile(
    path.join(root, "identity.pub"),
    path.join(root, "authorized_keys"),
  );
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const config = `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPubkeyAuthentication yes\nSubsystem sftp internal-sftp -d ${root}\nLogLevel ERROR\n`;
  await fs.writeFile(path.join(root, "sshd_config"), config);
  const process = spawn("/usr/sbin/sshd", [
    "-D",
    "-e",
    "-f",
    path.join(root, "sshd_config"),
  ]);
  let logs = "";
  process.stderr.on("data", (data) => {
    logs += data;
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (process.exitCode !== null) throw new Error(`Test sshd exited: ${logs}`);
    const connected = await new Promise<boolean>((resolve) => {
      const client = net.connect(port, "127.0.0.1");
      client.once("connect", () => {
        client.destroy();
        resolve(true);
      });
      client.once("error", () => resolve(false));
    });
    if (connected)
      return {
        root,
        port,
        key: path.join(root, "identity"),
        username: os.userInfo().username,
        logs: () => logs,
        close: async () => {
          process.kill();
          await fs.rm(root, { recursive: true, force: true });
        },
      };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.kill();
  throw new Error(`Test sshd did not start: ${logs}`);
}
