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
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Move keyboard focus into the panel when it opens so it's immediately usable
  // and the tab order is logical.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = sanitizeChat(draft);
    if (!text) return;
    onSend(text);
    setDraft('');
  };

  return (
    <section className="chat-panel" role="region" aria-label="Chat">
      <div className="chat-header">
        <h2 className="panel-title">Chat</h2>
        {onClose && (
          <button type="button" className="chat-close" onClick={onClose} aria-label="Close chat">
            ×
          </button>
        )}
      </div>
      <div className="chat-messages" ref={listRef} role="log" aria-live="polite" aria-label="Chat messages">
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
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message the host…"
          aria-label="Chat message"
          maxLength={2000}
        />
        <button type="submit" disabled={sanitizeChat(draft).length === 0} aria-label="Send chat message">
          Send
        </button>
      </form>
    </section>
  );
}
