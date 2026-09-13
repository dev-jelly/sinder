import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  FileText,
  FolderOpen,
  Pause,
  PencilSimple,
  WarningCircle,
  X,
} from "./icons";
import type {
  Connection,
  EditSession,
  Location,
  SinderAPI,
} from "../shared/types";
import { Tool } from "./components";

export const editStatus: Record<EditSession["status"], string> = {
  clean: "저장됨",
  pending: "저장 대기",
  uploading: "서버에 저장 중",
  offline: "재연결 대기",
  conflict: "버전 충돌",
  error: "저장 실패",
  paused: "일시 중지",
};
export function RemoteEditsPanel({
  sessions,
  connections,
  onClose,
  onAction,
  onNavigate,
  onReconnect,
  onChooseEditor,
}: {
  sessions: EditSession[];
  connections: Connection[];
  onClose: () => void;
  onAction: (
    id: string,
    action: Parameters<SinderAPI["editAction"]>[1],
  ) => void;
  onNavigate: (location: Location) => void;
  onReconnect: (id: string) => void;
  onChooseEditor: () => void;
}) {
  return (
    <section className="edits-panel" aria-label="원격 편집 작업">
      <div className="transfers-heading">
        <PencilSimple size={18} />
        <strong>원격 편집</strong>
        <span>편집기에서 저장하면 서버에 반영됩니다.</span>
        <button className="editor-choice" onClick={onChooseEditor}>
          편집기 선택
        </button>
        <Tool label="원격 편집 패널 닫기" onClick={onClose}>
          <X size={16} />
        </Tool>
      </div>
      {sessions.length === 0 ? (
        <div className="transfers-empty">
          원격 텍스트 파일을 미리 본 뒤 ‘원격 편집’을 선택하세요. 기본 편집기는
          macOS TextEdit, Windows 메모장입니다.
        </div>
      ) : (
        <div className="edit-list">
          {sessions.map((session) => (
            <article
              key={session.id}
              className={`edit-row edit-${session.status}`}
              aria-label={`${session.name} 편집 작업`}
            >
              <div className="edit-document">
                {session.status === "clean" ? (
                  <CheckCircle size={22} />
                ) : ["conflict", "error"].includes(session.status) ? (
                  <WarningCircle size={22} />
                ) : (
                  <FileText size={22} />
                )}
              </div>
              <div className="edit-summary">
                <div>
                  <strong>{session.name}</strong>
                  <span className="edit-status" role="status">
                    {editStatus[session.status]}
                  </span>
                </div>
                <small>
                  {connections.find(
                    (c) => c.id === session.location.connectionId,
                  )?.name ?? "저장된 서버"}{" "}
                  · {session.location.path}
                </small>
                {session.error && <p className="edit-error">{session.error}</p>}
                {session.status === "conflict" && (
                  <p className="edit-guidance">
                    서버본과 내 수정본을 비교한 뒤 편집기에서 합쳐 저장하세요.
                    ‘수정본 적용’을 누르면 현재 서버본도 백업합니다.
                  </p>
                )}
                <div className="edit-actions">
                  <button onClick={() => onAction(session.id, "open")}>
                    <ArrowSquareOut size={13} />내 수정본 열기
                  </button>
                  <button onClick={() => onAction(session.id, "reveal")}>
                    <FolderOpen size={13} />
                    로컬 보관 위치
                  </button>
                  {session.backupCount > 0 && (
                    <details className="edit-backups">
                      <summary>이전 서버본 {session.backupCount}개</summary>
                      <div>
                        {[...session.backupLocations]
                          .reverse()
                          .map((location, i) => (
                            <button
                              key={location.path}
                              onClick={() => onNavigate(location)}
                            >
                              저장 전 버전 {session.backupCount - i}
                              {i === 0 ? " · 최근" : ""}
                              <FolderOpen size={12} />
                            </button>
                          ))}
                      </div>
                    </details>
                  )}
                  {session.status === "offline" && (
                    <button
                      className="edit-primary-action"
                      onClick={() => onReconnect(session.location.connectionId)}
                    >
                      다시 연결
                    </button>
                  )}
                  {session.status === "conflict" && (
                    <>
                      <button
                        onClick={() => onAction(session.id, "server-copy")}
                      >
                        서버본 별도로 열기
                      </button>
                      <button
                        className="edit-primary-action"
                        onClick={() => onAction(session.id, "apply-local")}
                      >
                        수정본 적용
                      </button>
                    </>
                  )}
                  {["error", "paused", "pending"].includes(session.status) && (
                    <button onClick={() => onAction(session.id, "retry")}>
                      <ArrowClockwise size={13} />
                      {session.status === "paused"
                        ? "동기화 재개"
                        : "다시 시도"}
                    </button>
                  )}
                  {!["uploading", "paused"].includes(session.status) && (
                    <button onClick={() => onAction(session.id, "pause")}>
                      <Pause size={13} />
                      일시 중지
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
