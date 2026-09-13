import { spawn } from "node:child_process";
import { Duplex } from "node:stream";

/** Start only an argv vector read from the user's local config, never renderer text. */
export function openSshProxy(
  command: string[],
  home: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const child = spawn(command[0], command.slice(1), {
    cwd: home,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  let stopped = false;
  let details = "";
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener("abort", abort);
    if (!child.pid) return;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform === "win32") child.kill(sig);
        else process.kill(-child.pid!, sig);
      } catch {
        /* Process already exited. */
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 500);
    timer.unref();
  };
  const abort = () => {
    stream.destroy(signal.reason);
    stop();
  };
  stream.on("error", () => {});
  stream.once("close", stop);
  child.stderr.on("data", (data) => {
    details = (details + data).slice(-2048);
  });
  child.once("error", (error) =>
    stream.destroy(
      new Error(`SSH 프록시를 시작하지 못했습니다: ${error.message}`),
    ),
  );
  child.once("close", (code) => {
    if (!stopped && code !== 0)
      stream.destroy(
        new Error(`SSH 프록시가 종료되었습니다 (${code}). ${details.trim()}`),
      );
    stop();
  });
  signal.addEventListener("abort", abort, { once: true });
  return stream;
}
