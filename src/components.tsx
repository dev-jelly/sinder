import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  File,
  FileCode,
  FileImage,
  FilePdf,
  FileText,
  FileZip,
  Folder,
  Link,
  X,
} from "./icons";
import type { Entry } from "../shared/types";
export function FileIcon({
  entry,
  large = false,
}: {
  entry: Entry;
  large?: boolean;
}) {
  const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const Icon =
    entry.kind === "directory"
      ? Folder
      : entry.kind === "symlink"
        ? Link
        : ["png", "jpg", "jpeg", "webp", "gif", "heic"].includes(extension)
          ? FileImage
          : [
                "ts",
                "tsx",
                "js",
                "jsx",
                "json",
                "py",
                "rs",
                "css",
                "html",
                "sh",
                "yml",
                "yaml",
              ].includes(extension)
            ? FileCode
            : extension === "pdf"
              ? FilePdf
              : ["zip", "gz", "tar", "7z"].includes(extension)
                ? FileZip
                : ["txt", "md", "csv", "log"].includes(extension)
                  ? FileText
                  : File;
  return (
    <Icon
      size={large ? 60 : 22}
      weight={entry.kind === "directory" ? "duotone" : "regular"}
      className={`file-icon ${entry.kind === "directory" ? "folder-icon" : ""} ext-${extension}`}
    />
  );
}
export function Tool({
  label,
  children,
  active,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`tool ${active ? "active" : ""} ${className}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    (
      dialog.querySelector<HTMLElement>("[data-autofocus]") ??
      dialog.querySelector<HTMLElement>(
        'input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled)',
      )
    )?.focus();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const r = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-title">
        <h2 id={titleId}>{title}</h2>
        <Tool label="닫기" onClick={onClose}>
          <X size={18} />
        </Tool>
      </div>
      {children}
    </dialog>
  );
}
