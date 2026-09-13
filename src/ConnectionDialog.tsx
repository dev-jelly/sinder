import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { FolderOpen, LockKey } from "./icons";
import type {
  CancelConnectionResult,
  Connection,
  Profile,
  SshConfigSnapshot,
} from "../shared/types";
import { Modal } from "./components";
import { errorText } from "./utils";

export function ConnectionDialog({
  profile,
  onClose,
  onConnected,
  onImported,
}: {
  profile?: Profile;
  onClose: () => void;
  onConnected: (connection: Connection) => void;
  onImported: (added: number) => void;
}) {
  const [form, setForm] = useState<Profile>(
    profile ?? {
      id: crypto.randomUUID(),
      name: "",
      host: "",
      port: 22,
      username: "",
      auth: "agent",
      initialPath: "~",
    },
  );
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<SshConfigSnapshot>();
  const [configError, setConfigError] = useState("");
  const [importing, setImporting] = useState(false);
  const [reading, setReading] = useState(!profile);
  useEffect(() => {
    if (profile) return;
    let live = true;
    window.sinder
      .readSshConfig()
      .then((value) => {
        if (live) setConfig(value);
      })
      .catch((error) => {
        if (live) setConfigError(errorText(error));
      })
      .finally(() => {
        if (live) setReading(false);
      });
    return () => {
      live = false;
    };
  }, [profile]);
  const closing = useRef(false);
  const pending = useRef<{
    cancellation?: Promise<CancelConnectionResult>;
  } | null>(null);
  const update = (change: Partial<Profile>) =>
    setForm((current) => ({ ...current, ...change }));

  async function close() {
    if (importing) return;
    if (closing.current) return;
    closing.current = true;
    setCanceling(true);
    try {
      const attempt = pending.current;
      if (attempt) {
        attempt.cancellation = window.sinder.cancelConnection(form.id);
        if ((await attempt.cancellation) === "committed") {
          setCommitting(true);
          return;
        }
      }
      onClose();
    } catch (error) {
      closing.current = false;
      setCanceling(false);
      setError(errorText(error));
    }
  }
  async function importConfig() {
    setImporting(true);
    setError("");
    try {
      const result = await window.sinder.importSshConfig();
      onImported(result.added);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setImporting(false);
    }
  }
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const attempt: { cancellation?: Promise<CancelConnectionResult> } = {};
    pending.current = attempt;
    let connection: Connection | undefined;
    let failure: unknown;
    try {
      connection = await window.sinder.connect(
        {
          ...form,
          host: form.host.trim(),
          username: form.username.trim(),
          name: form.name.trim() || form.host.trim(),
        },
        { password, passphrase },
      );
    } catch (error) {
      failure = error;
    }
    // Let the cancellation decision settle before deciding who completes the
    // dialog. A committed connection still owns its successful callback.
    const cancelled =
      (await attempt.cancellation?.catch(() => "committed")) === "cancelled";
    pending.current = null;
    if (cancelled) return;
    closing.current = false;
    setBusy(false);
    setCanceling(false);
    setCommitting(false);
    if (connection) {
      setPassword("");
      setPassphrase("");
      onConnected(connection);
    } else setError(errorText(failure));
  }

  return (
    <Modal
      title={profile ? "SSH 다시 연결" : "SSH 연결 추가"}
      onClose={() => void close()}
    >
      <form className="connection-form" onSubmit={connect} aria-busy={busy}>
        <fieldset disabled={busy || importing}>
          {!profile && (
            <div className="ssh-config-import">
              <label>
                로컬 SSH 설정
                <div className="ssh-config-controls">
                  <select
                    aria-label="로컬 SSH 호스트"
                    value={form.sshConfigHost ?? ""}
                    disabled={reading || !config?.entries.length}
                    onChange={(event) => {
                      const entry = config?.entries.find(
                        (item) => item.alias === event.target.value,
                      );
                      setPassword("");
                      setPassphrase("");
                      if (entry) setForm(entry.profile);
                      else
                        update({
                          sshConfigHost: undefined,
                          id: crypto.randomUUID(),
                        });
                    }}
                  >
                    <option value="">
                      {reading ? "설정을 읽는 중…" : "직접 입력"}
                    </option>
                    {config?.entries.map((entry) => (
                      <option
                        key={entry.alias}
                        value={entry.alias}
                        disabled={!!entry.issue}
                      >
                        {entry.alias}
                        {entry.route !== "direct" ? " · 프록시" : ""}
                        {entry.issue ? " · 확인 필요" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!config?.entries.some((entry) => !entry.issue)}
                    onClick={() => void importConfig()}
                  >
                    {importing ? "추가 중…" : "모두 추가"}
                  </button>
                </div>
              </label>
              <p className="field-help">
                {configError ||
                  (reading
                    ? "~/.ssh/config를 확인합니다."
                    : !config?.exists
                      ? "~/.ssh/config가 없습니다. 아래에서 직접 입력할 수 있습니다."
                      : !config.entries.length
                        ? "추가할 Host 별칭이 없습니다."
                        : "호스트를 선택하면 자동 입력됩니다. 모두 추가하면 접속 없이 연결 목록에 저장합니다.")}
              </p>
              {config?.entries.some((entry) => entry.issue) && (
                <details className="ssh-config-issues">
                  <summary>
                    가져올 수 없는 설정{" "}
                    {config.entries.filter((entry) => entry.issue).length}개
                  </summary>
                  {config.entries
                    .filter((entry) => entry.issue)
                    .map((entry) => (
                      <p key={entry.alias}>
                        {entry.alias}: {entry.issue}
                      </p>
                    ))}
                </details>
              )}
            </div>
          )}
          {form.sshConfigHost && (
            <p className="field-help">
              {form.sshConfigHost}의 로컬 SSH 프록시·agent 설정을 사용합니다.
              서버 키는 Sinder에서 확인합니다.
            </p>
          )}
          <div className="form-columns">
            <Field
              label="호스트"
              autoFocus
              required
              value={form.host}
              onChange={(e) => update({ host: e.target.value })}
              placeholder="server.example.com"
            />
            <Field
              label="포트"
              className="port"
              required
              type="number"
              min="1"
              max="65535"
              value={form.port}
              onChange={(e) => update({ port: Number(e.target.value) })}
            />
          </div>
          <div className="form-columns">
            <Field
              label="사용자 이름"
              required
              value={form.username}
              onChange={(e) => update({ username: e.target.value })}
              placeholder="username"
            />
            <label>
              인증 방식
              <select
                value={form.auth}
                onChange={(e) =>
                  update({ auth: e.target.value as Profile["auth"] })
                }
              >
                <option value="agent">SSH agent</option>
                <option value="key">비공개 키 파일</option>
                <option value="password">비밀번호</option>
              </select>
            </label>
          </div>
          {form.auth === "agent" && (
            <p className="field-help">SSH agent에 등록된 키로 연결합니다.</p>
          )}
          {form.auth === "key" && (
            <>
              <label>
                키 파일
                <div className="input-action">
                  <input
                    aria-label="키 파일"
                    required
                    value={form.keyPath ?? ""}
                    spellCheck={false}
                    onChange={(e) => update({ keyPath: e.target.value })}
                    placeholder="~/.ssh/id_ed25519"
                  />
                  <button
                    type="button"
                    aria-label="키 파일 선택"
                    onClick={() => {
                      void window.sinder
                        .pickKey()
                        .then((p) => {
                          if (p) update({ keyPath: p });
                        })
                        .catch((e) => setError(errorText(e)));
                    }}
                  >
                    <FolderOpen size={18} />
                  </button>
                </div>
              </label>
              <Field
                label="키 암호"
                optional
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
              />
            </>
          )}
          {form.auth === "password" && (
            <Field
              label="비밀번호"
              required
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          )}
          <div className="form-columns connection-options">
            <Field
              label="연결 이름"
              optional
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder={form.host || "작업 서버"}
            />
            <Field
              label="시작 폴더"
              required
              value={form.initialPath}
              onChange={(e) => update({ initialPath: e.target.value })}
            />
          </div>
        </fieldset>
        <p className="privacy-note">
          <LockKey size={14} />
          비밀번호와 키 암호는 저장하지 않습니다.
        </p>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        {busy && (
          <p className="connection-progress" role="status">
            {committing
              ? "서버에 연결되었습니다. 연결 정보를 저장하는 중…"
              : "서버 응답을 기다리는 중… 언제든 취소할 수 있습니다."}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            disabled={canceling || importing}
            onClick={() => void close()}
          >
            {committing
              ? "연결 완료 중…"
              : canceling
                ? "취소 중…"
                : busy
                  ? "연결 취소"
                  : "취소"}
          </button>
          <button
            className="primary"
            disabled={busy || importing}
            type="submit"
          >
            {busy ? "연결 중…" : "연결"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  optional,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  optional?: boolean;
}) {
  return (
    <label className={className}>
      {label}
      {optional && <span className="optional">선택</span>}
      <input
        aria-label={label}
        data-autofocus={props.autoFocus || undefined}
        autoCapitalize="off"
        spellCheck={false}
        {...props}
      />
    </label>
  );
}
