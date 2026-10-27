import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { ACCEPT, DocumentError, downloadOptions, readDocument, saveBlob, type LoadedDocument } from "../engine/documents";
import { Button, cx } from "./ui";

/** A button that opens a file picker and reads the chosen document in the browser. */
export function UploadButton({
  label,
  onLoaded,
  onError,
  variant = "ghost",
}: {
  label: string;
  onLoaded: (doc: LoadedDocument) => void;
  onError: (message: string) => void;
  variant?: "ghost" | "secondary";
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label={label}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          try {
            onLoaded(await readDocument(file));
          } catch (err) {
            onError(messageOf(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button size="sm" variant={variant} busy={busy} onClick={() => input.current?.click()}>
        {busy ? null : <UploadIcon />}
        {busy ? "Reading…" : label}
      </Button>
    </>
  );
}

export function messageOf(err: unknown) {
  if (err instanceof DocumentError) return err.message;
  return "That file couldn’t be read.";
}

/** Makes its children a drop target for one document. */
export function DropTarget({
  children,
  onLoaded,
  onError,
  className,
}: {
  children: ReactNode;
  onLoaded: (doc: LoadedDocument) => void;
  onError: (message: string) => void;
  className?: string;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return (
    <div
      className={cx("relative", className)}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      }}
      onDrop={async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (!file) return;
        try {
          onLoaded(await readDocument(file));
        } catch (err) {
          onError(messageOf(err));
        }
      }}
    >
      {children}
      {over ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-veil-wash/90 ring-2 ring-veil ring-inset">
          <p className="text-[15px] font-medium text-veil-deep">Drop to read it in your browser</p>
        </div>
      ) : null}
    </div>
  );
}

/** The loaded document's name and size, with a way to remove it. */
export function DocumentChip({ doc, chars, onRemove }: { doc: LoadedDocument; chars: number; onRemove: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-xl bg-veil-wash px-3 py-2 text-[13px] ring-1 ring-veil-line ring-inset" data-testid="document-chip">
      <FileIcon />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink">{doc.name}</p>
        <p className="text-[12px] text-ink-soft">
          {doc.parts ? `${doc.parts.count} ${doc.parts.label} · ` : ""}
          {chars.toLocaleString()} characters
          {doc.truncated ? " · only the first 500,000 characters were read" : ""}
        </p>
      </div>
      <button type="button" onClick={onRemove} className="shrink-0 rounded-full px-2 py-1 text-[12px] font-medium text-veil-deep hover:bg-panel">
        Remove
      </button>
    </div>
  );
}

/** One button per format the text can be saved as. */
export function DownloadButtons({ text, doc, suffix }: { text: string; doc: LoadedDocument | null; suffix: string }) {
  const options = downloadOptions(doc, suffix);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {options.map((o, i) => (
        <Button key={o.label} size="sm" variant={i === 0 ? "secondary" : "ghost"} onClick={async () => saveBlob(await o.make(text), o.filename)} aria-label={`Download as ${o.label}`}>
          <DownloadIcon />
          {i === 0 ? `Download ${o.label}` : o.label}
        </Button>
      ))}
    </div>
  );
}

function UploadIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 10.5V2.5M4.75 5.75 8 2.5l3.25 3.25M2.5 10.5v1.75c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25V10.5" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v8M4.75 7.25 8 10.5l3.25-3.25M2.5 10.5v1.75c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25V10.5" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="size-5 shrink-0 text-veil-deep" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M5 2.75h6.5L15 6.25v11H5z" />
      <path d="M11.5 2.75v3.5H15" />
      <path d="M7.5 10h5M7.5 12.75h5" strokeLinecap="round" />
    </svg>
  );
}
