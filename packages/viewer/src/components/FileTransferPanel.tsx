import React, { useCallback, useRef, useState } from 'react';
import type { FileTransferEntry } from '../viewer-session.js';

/** Props for {@link FileTransferPanel}. */
export interface FileTransferPanelProps {
  /** Active + finished transfers, newest first. */
  transfers: FileTransferEntry[];
  /** Send a chosen browser File to the host. */
  onSendFile: (file: File) => void;
  /** Collapse/close the panel. */
  onClose?: () => void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function percent(t: FileTransferEntry): number {
  if (t.status === 'complete') return 100;
  if (t.size <= 0) return 0;
  return Math.min(100, Math.round((t.progress / t.size) * 100));
}

/**
 * Drag-and-drop (and file-picker) outbound file sending, plus a live list of
 * inbound/outbound transfers with progress. Sending streams over the reliable
 * binary `file` channel with backpressure (handled in the session). Inbound
 * completions trigger a browser download (wired in App).
 */
export function FileTransferPanel({
  transfers,
  onSendFile,
  onClose,
}: FileTransferPanelProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const sendFiles = useCallback(
    (files: FileList | File[] | null) => {
      if (!files) return;
      for (const f of Array.from(files)) onSendFile(f);
    },
    [onSendFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      sendFiles(e.dataTransfer?.files ?? null);
    },
    [sendFiles],
  );

  return (
    <div className="file-panel" aria-label="File transfer">
      <div className="file-header">
        <span>Files</span>
        {onClose && (
          <button type="button" className="file-close" onClick={onClose} aria-label="Close files">
            ×
          </button>
        )}
      </div>

      <div
        className={dragging ? 'file-drop dragging' : 'file-drop'}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        aria-label="Drop files here or click to choose"
      >
        Drop files here or click to choose
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          aria-label="Choose files to send"
          onChange={(e) => {
            sendFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <div className="file-list">
        {transfers.length === 0 && <div className="file-empty">No transfers.</div>}
        {transfers.map((t) => (
          <div key={t.id} className={`file-item ${t.status}`}>
            <div className="file-item-head">
              <span className="file-dir">{t.direction === 'out' ? '↑' : '↓'}</span>
              <span className="file-name">{t.name || t.id}</span>
              <span className="file-size">{t.size > 0 ? formatBytes(t.size) : ''}</span>
            </div>
            <div className="file-progress-bar">
              <div className="file-progress-fill" style={{ width: `${percent(t)}%` }} />
            </div>
            <span className="file-status">
              {t.status}
              {t.error ? ` — ${t.error}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
