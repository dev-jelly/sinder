import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Profile, SshConfigSnapshot } from "../shared/types.js";

type Directive = { key: string; args: string[]; children?: Directive[] };
export type SshRoute = { command: string[]; agent?: string | null };
type Resolved = { profile: Profile; route: SshRoute; issue?: string };

// Tokenize configuration text only. Importing never invokes ssh, a shell, or Match exec.
export function sshWords(text: string): string[] {
  const words: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!quote && c === "#") break;
    if (c === "\\" && /[\s"'\\#]/.test(text[i + 1] ?? "")) {
      word += text[++i];
      started = true;
    } else if (quote && c === quote) quote = "";
    else if (!quote && (c === '"' || c === "'")) {
      quote = c;
      started = true;
    } else if (!quote && /\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error("SSH 설정의 따옴표가 닫히지 않았습니다.");
  if (started) words.push(word);
  return words;
}

function matches(patterns: string[], host: string) {
  let positive = false;
  for (const pattern of patterns) {
    const negate = pattern.startsWith("!");
    const glob = (negate ? pattern.slice(1) : pattern)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    if (new RegExp(`^${glob}$`, "i").test(host)) {
      if (negate) return false;
      positive = true;
    }
  }
  return positive;
}

export class SshConfig {
  readonly filename: string;
  constructor(readonly home = os.homedir()) {
    this.filename = path.join(home, ".ssh", "config");
  }
  private expand(value: string, tokens: Record<string, string> = {}) {
    return value
      .replace(/\$\{([^}]+)\}/g, (_all, name: string) => {
        const v = process.env[name];
        if (v === undefined)
          throw new Error(`SSH 설정의 환경 변수 ${name}이 없습니다.`);
        return v;
      })
      .replace(/%([%a-zA-Z])/g, (_all, token: string) => {
        if (token === "%") return "%";
        if (!(token in tokens))
          throw new Error(`SSH 설정의 %${token} 치환은 지원하지 않습니다.`);
        return tokens[token];
      })
      .replace(/^~(?=$|[/\\])/, this.home);
  }
  private async read(): Promise<Directive[] | null> {
    let total = 0;
    const load = async (
      filename: string,
      chain: string[],
    ): Promise<Directive[]> => {
      const canonical = await fs.realpath(filename);
      if (chain.includes(canonical) || chain.length >= 16)
        throw new Error("SSH Include가 순환하거나 너무 깊습니다.");
      const stat = await fs.stat(canonical);
      total += stat.size;
      if (!stat.isFile() || total > 2 * 1024 * 1024)
        throw new Error("SSH 설정은 총 2 MB 이하의 일반 파일이어야 합니다.");
      const result: Directive[] = [];
      for (const line of (await fs.readFile(canonical, "utf8")).split(
        /\r?\n/,
      )) {
        const match = line.match(/^\s*([a-z][a-z0-9]*)\s*(?:=\s*|\s+)(.*)$/i);
        if (!match) {
          if (line.trim() && !line.trim().startsWith("#"))
            throw new Error("SSH 설정에 올바르지 않은 지시문이 있습니다.");
          continue;
        }
        const key = match[1].toLowerCase(),
          args = sshWords(match[2]);
        if (!args.length) throw new Error(`SSH ${key} 설정의 값이 없습니다.`);
        const directive: Directive = { key, args };
        if (key === "include") {
          directive.children = [];
          for (const include of args) {
            const expanded = this.expand(include, {
              d: this.home,
              u: os.userInfo().username,
            });
            const pattern = path.isAbsolute(expanded)
              ? expanded
              : path.join(this.home, ".ssh", expanded);
            const files: string[] = [];
            for await (const file of fs.glob(pattern.replaceAll("\\", "/")))
              files.push(file);
            for (const file of files.sort())
              directive.children.push({
                key: "include",
                args: [],
                children: await load(file, [...chain, canonical]),
              });
          }
        }
        result.push(directive);
      }
      return result;
    };
    try {
      return await load(this.filename, []);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        !(await fs.stat(this.filename).catch(() => null))
      )
        return null;
      throw error;
    }
  }
  private aliases(nodes: Directive[]): string[][] {
    return nodes
      .flatMap((node) =>
        node.key === "host"
          ? [
              node.args.filter(
                (alias) => !/[*!?\s\0]/.test(alias) && alias.length <= 100,
              ),
            ]
          : node.children
            ? this.aliases(node.children)
            : [],
      )
      .filter((group) => group.length);
  }
  private async resolve(
    nodes: Directive[],
    alias: string,
    target?: Profile,
  ): Promise<Resolved> {
    const values = new Map<string, string[]>();
    let active = true;
    let declared = false;
    let issue: string | undefined;
    const visit = (directives: Directive[]) => {
      for (const { key, args, children } of directives) {
        if (key === "host") {
          active = matches(args, alias);
          if (args.includes(alias)) declared = true;
        } else if (key === "match") {
          // A conditional Match can affect values absent from a previous Host.
          // Do not silently flatten or execute conditions we cannot evaluate.
          active = args.length === 1 && args[0].toLowerCase() === "all";
          if (!active) issue = "Match 조건이 있는 설정은 직접 입력해 주세요.";
        } else if (key === "include") {
          if (active) {
            visit(children ?? []);
            // Included files inherit, then restore, their caller's condition.
            active = true;
          }
        } else if (active) {
          if (key === "identityfile")
            values.set(key, [...(values.get(key) ?? []), ...args]);
          else if (
            !values.has(key) &&
            !(key === "proxycommand" && values.has("proxyjump")) &&
            !(key === "proxyjump" && values.has("proxycommand"))
          )
            values.set(key, args);
        }
      }
    };
    visit(nodes);
    if (!declared) issue = "조건부 Include 안의 호스트는 직접 입력해 주세요.";
    const get = (key: string, fallback = "") =>
      values.get(key)?.[0] ?? fallback;
    const username = target?.username ?? get("user", os.userInfo().username);
    const host =
      target?.host ?? this.expand(get("hostname", alias), { h: alias });
    const port = target?.port ?? Number(get("port", "22"));
    if (
      !host ||
      /[\s\0]/.test(host) ||
      host.length > 255 ||
      !username ||
      username.length > 100 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      issue = "호스트·사용자·포트 설정을 확인해 주세요.";
    const tokens = {
      d: this.home,
      h: host,
      n: alias,
      p: String(port),
      r: username,
      u: os.userInfo().username,
    };
    const identities = values.get("identityfile") ?? [
      "~/.ssh/id_ed25519",
      "~/.ssh/id_ecdsa",
      "~/.ssh/id_rsa",
    ];
    const keys = identities
      .filter((key) => key.toLowerCase() !== "none")
      .map((key) => path.resolve(this.home, this.expand(key, tokens)));
    let keyPath: string | undefined;
    for (const key of keys)
      if ((await fs.stat(key).catch(() => null))?.isFile()) {
        keyPath = key;
        break;
      }
    // Keep an explicit missing key visible so users can correct it in the form.
    keyPath ??= values.has("identityfile") ? keys[0] : undefined;
    const agentValue = get("identityagent");
    const agent =
      agentValue === "none"
        ? null
        : agentValue === "SSH_AUTH_SOCK"
          ? process.env.SSH_AUTH_SOCK
          : agentValue
            ? this.expand(agentValue, tokens)
            : undefined;
    const auth = keyPath
      ? "key"
      : agentValue === "none" || get("identitiesonly") === "yes"
        ? "password"
        : "agent";
    let command: string[] = [];
    const proxy = values.get("proxycommand");
    const jump = get("proxyjump");
    if (proxy && proxy[0]?.toLowerCase() !== "none") {
      const words = proxy;
      if (words.some((word) => /[|&;<>`\n\r]|\$\(|\$\{?\w/.test(word)))
        issue =
          "셸 연산자를 쓰는 ProxyCommand는 실행 파일 스크립트로 분리해 주세요.";
      command = words.map((word) => this.expand(word, tokens));
    } else if (jump && jump.toLowerCase() !== "none") {
      const hops = jump.split(",");
      const target = hops.pop()!;
      if (
        hops.some((hop) => !hop || hop.startsWith("-")) ||
        !target ||
        target.startsWith("-")
      )
        issue = "ProxyJump 경유지 형식을 확인해 주세요.";
      command = [
        "ssh",
        "-F",
        this.filename,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        ...(hops.length ? ["-J", hops.join(",")] : []),
        "-W",
        `[${host}]:${port}`,
        "--",
        target,
      ];
    }
    if (
      get("canonicalizehostname", "no") !== "no" ||
      values.has("certificatefile")
    )
      issue =
        "호스트 이름 정규화 또는 인증서 인증 설정은 아직 지원하지 않습니다.";
    return {
      profile: {
        id: randomUUID(),
        name: alias,
        host,
        port,
        username,
        auth,
        keyPath,
        initialPath: "~",
        sshConfigHost: alias,
      },
      route: { command, agent },
      issue,
    };
  }
  async scan(): Promise<SshConfigSnapshot> {
    const nodes = await this.read();
    const snapshot: SshConfigSnapshot = {
      path: this.filename,
      exists: nodes !== null,
      entries: [],
    };
    const seen = new Set<string>();
    for (const aliases of this.aliases(nodes ?? [])) {
      const alias = aliases[0];
      if (seen.has(alias)) continue;
      seen.add(alias);
      try {
        const { profile, route, issue } = await this.resolve(nodes!, alias);
        snapshot.entries.push({
          alias,
          aliases,
          profile,
          route: route.command.length
            ? route.command[0] === "ssh" && route.command.includes("-W")
              ? "jump"
              : "proxy"
            : "direct",
          issue,
        });
      } catch (error) {
        snapshot.entries.push({
          alias,
          aliases,
          profile: {
            id: randomUUID(),
            name: alias,
            host: alias,
            port: 22,
            username: "",
            auth: "agent",
            initialPath: "~",
            sshConfigHost: alias,
          },
          route: "direct",
          issue: (error as Error).message,
        });
      }
    }
    return snapshot;
  }
  async route(alias: string, target?: Profile): Promise<SshRoute> {
    const nodes = await this.read();
    if (
      !nodes ||
      !this.aliases(nodes).some((aliases) => aliases.includes(alias))
    )
      throw new Error(
        "로컬 SSH 설정에서 이 호스트를 찾지 못했습니다. 설정을 다시 가져와 주세요.",
      );
    const resolved = await this.resolve(nodes, alias, target);
    if (resolved.issue) throw new Error(resolved.issue);
    return resolved.route;
  }
}
