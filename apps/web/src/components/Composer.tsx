import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@janis/shared';
import { useSavedReplies } from '../api/hooks';

const EMOJIS = [
  '😀','😄','😊','🙂','😉','😍','🤔','😅','😂','🥲','😢','😮','😴','🤗','🤝','👍',
  '👎','🙏','👏','💪','🫶','✌️','🤞','👋','❤️','🧡','💛','💚','💙','💜','🖤','🤍',
  '💯','✨','🔥','🎉','🎊','🎁','⭐','⚡','💡','🔔','📌','📎','📄','🖼️','📊','💳',
  '📦','🚀','✅','❌','⚠️','❓','❗','🕐','📅','🔒','🔑','🛠️','🐛','💬','📞','📧',
];

export default function Composer({
  value,
  onChange,
  onSend,
  onResume,
  sendAs,
  setSendAs,
  showModeSelect,
  canTeach,
  sending,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: (attachments: Attachment[]) => void;
  onResume?: () => void;
  sendAs: 'human' | 'agent' | 'note' | 'teach';
  setSendAs: (m: 'human' | 'agent' | 'note' | 'teach') => void;
  showModeSelect: boolean;
  canTeach?: boolean;
  sending: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const { data: savedReplies } = useSavedReplies();

  // autosize: grow with content up to ~8 lines
  useEffect(() => {
    const t = taRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 180) + 'px';
  }, [value]);

  const insertEmoji = (emoji: string) => {
    const t = taRef.current;
    if (!t) return onChange(value + emoji);
    const start = t.selectionStart ?? value.length;
    const end = t.selectionEnd ?? value.length;
    const next = value.slice(0, start) + emoji + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      t.focus();
      t.selectionStart = t.selectionEnd = start + emoji.length;
    });
    setEmojiOpen(false);
  };

  const insertText = (text: string) => {
    const t = taRef.current;
    const start = t?.selectionStart ?? value.length;
    const end = t?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      if (t) {
        t.focus();
        t.selectionStart = t.selectionEnd = start + text.length;
      }
    });
    setRepliesOpen(false);
  };

  const uploadFiles = async (files: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'include' });
        if (res.ok) {
          const att = (await res.json()) as Attachment;
          setAttachments((a) => [...a, att]);
        }
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const send = () => {
    if (!value.trim() && attachments.length === 0) return;
    onSend(attachments);
    setAttachments([]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer-box">
      {attachments.length > 0 && (
        <div className="attach-list">
          {attachments.map((a, i) => (
            <span key={i} className="attach-chip">
              {a.type.startsWith('image/') ? '🖼' : '📎'} {a.name}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setAttachments((prev) => prev.filter((_, j) => j !== i));
                }}
              >
                {' '}✕
              </a>
            </span>
          ))}
        </div>
      )}

      <div className="composer-inner">
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = e.clipboardData?.files;
            if (files?.length) void uploadFiles(files);
          }}
          placeholder={
            sendAs === 'agent'
              ? 'Message the agent will deliver…'
              : sendAs === 'note'
                ? 'Internal note — teammates only…'
                : sendAs === 'teach'
                  ? 'Teach the agent a fact it should always know…'
                  : 'Reply as a human… (Enter sends, Shift+Enter for newline)'
          }
        />

        <div className="composer-bar">
          <button type="button" className="btn icon" title="Emoji" onClick={() => setEmojiOpen((o) => !o)}>😊</button>
          <button type="button" className="btn icon" title="Attach file" onClick={() => fileRef.current?.click()}>📎</button>
          {(savedReplies?.saved_replies.length ?? 0) > 0 && (
            <button type="button" className="btn icon" title="Saved replies" onClick={() => setRepliesOpen((o) => !o)}>📑</button>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
          />
          {showModeSelect && (
            <select value={sendAs} onChange={(e) => setSendAs(e.target.value as 'human' | 'agent' | 'note' | 'teach')}>
              <option value="human">as human</option>
              <option value="agent">via agent</option>
              <option value="note">🔒 internal note</option>
              {canTeach && <option value="teach">🧠 teach agent</option>}
            </select>
          )}
          <span className="grow" />
          {onResume && (
            <button className="btn" type="button" onClick={onResume}>Resume agent</button>
          )}
          <button
            className="btn primary"
            onClick={send}
            disabled={sending || uploading || (!value.trim() && attachments.length === 0)}
          >
            {uploading ? 'Uploading…' : 'Send'}
          </button>
        </div>
      </div>

      {emojiOpen && (
        <div className="emoji-pop">
          {EMOJIS.map((e) => (
            <button key={e} type="button" onClick={() => insertEmoji(e)}>{e}</button>
          ))}
        </div>
      )}
      {repliesOpen && (
        <div className="emoji-pop reply-pop">
          {savedReplies?.saved_replies.map((r) => (
            <button key={r.id} type="button" className="reply-item" onClick={() => insertText(r.body)}>
              <strong>{r.title}</strong>
              <span className="muted">{r.body.slice(0, 80)}{r.body.length > 80 ? '…' : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
