import React, { useEffect, useRef, useState } from 'react';
import type { ChatEntry } from '../viewer-session.js';
import { sanitizeChat } from '../chat.js';

/** Props for {@link ChatPanel}. */
export interface ChatPanelProps {
  /** Conversation history (oldest first). */
  messages: ChatEntry[];
  /** Send a new outbound chat line. */
  onSend: (text: string) => void;
  /** Collapse/close the panel. */
  onClose?: () => void;
}

/**
 * Text chat over the control channel. Incoming and outgoing messages render as
 * plain text — every line is passed through {@link sanitizeChat}, and React's
 * text-node escaping is the second layer, so no message can inject markup.
 */
export function ChatPanel({ messages, onSend, onClose }: ChatPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = sanitizeChat(draft);
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  return (
    <div className="chat-panel" aria-label="Chat">
      <div className="chat-header">
        <span>Chat</span>
        {onClose && (
          <button type="button" className="chat-close" onClick={onClose} aria-label="Close chat">
            ×
          </button>
        )}
      </div>
      <div className="chat-messages" ref={listRef} role="log" aria-live="polite">
        {messages.length === 0 && <div className="chat-empty">No messages yet.</div>}
        {messages.map((m, i) => (
          <div key={`${m.ts}-${i}`} className={m.from === 'me' ? 'chat-msg me' : 'chat-msg host'}>
            <span className="chat-author">{m.from === 'me' ? 'You' : 'Host'}</span>
            <span className="chat-text">{sanitizeChat(m.text)}</span>
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={submit}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message the host…"
          aria-label="Chat message"
          maxLength={2000}
        />
        <button type="submit" disabled={sanitizeChat(draft).length === 0}>
          Send
        </button>
      </form>
    </div>
  );
}
