import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@janis/shared';
import { useSavedReplies } from '../api/hooks';
import { Bot, Brain, Check, FileText, Headset, Image, Lock, Paperclip, Smile, Sparkles, X } from 'lucide-react';
import { EmojiPicker } from './EmojiPicker';

export default function Composer({
  agentId,
  value,
  onChange,
  onSend,
  onResume,
  onTakeover,
  onSuggest,
  suggestActive,
  sendAs,
  setSendAs,
  showModeSelect,
  canTeach,
  sending,
  uploadFile,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Conversation's agent — merges its saved replies with workspace ones. */
  agentId?: string;
  onSend: (attachments: Attachment[]) => void;
  onResume?: () => void;
  /** Hand the thread to the human — pauses the agent; the button next to
   *  Send toggles Take over ⇄ Resume agent off `state === 'human'`. */
  onTakeover?: () => void;
  /** AI draft suggestion — lives in the bar as a sparkles icon. */
  onSuggest?: () => void;
  /** Pressed-in look while the suggestion card is open or generating. */
  suggestActive?: boolean;
  sendAs: 'human' | 'agent' | 'note' | 'teach';
  setSendAs: (m: 'human' | 'agent' | 'note' | 'teach') => void;
  showModeSelect: boolean;
  canTeach?: boolean;
  sending: boolean;
  /** Upload override — the embedded Shopify app can't reach the cookie-authed
   *  /api/uploads; it supplies a session-token POST instead. */
  uploadFile?: (file: File) => Promise<Attachment | null>;
  /** Placeholder override — the sendAs-derived default fits inbox replies;
   *  other surfaces (merchant Ask) need their own. */
  placeholder?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [sendasOpen, setSendasOpen] = useState(false);
  // Phone width gets terse placeholders + an icon-face mode picker —
  // the verbose "(Enter sends…)" hint means nothing on a touch keyboard
  // anyway.
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const on = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const { data: savedReplies } = useSavedReplies(agentId);

  // Dismiss the emoji/replies popovers on Escape or a click outside the
  // composer — re-clicking the trigger button is not the obvious close path.
  useEffect(() => {
    if (!emojiOpen && !repliesOpen && !sendasOpen) return;
    const close = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setEmojiOpen(false);
        setRepliesOpen(false);
        setSendasOpen(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEmojiOpen(false);
        setRepliesOpen(false);
        setSendasOpen(false);
      }
    };
    // Capture phase: the emoji picker's keydown handler stops propagation
    // (to shield the composer's Enter-to-send) — capture still sees Escape.
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc, true);
    };
  }, [emojiOpen, repliesOpen, sendasOpen]);

  // autosize: grow with content up to ~8 lines; no scrollbar until it overflows
  useEffect(() => {
    const t = taRef.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 180) + 'px';
    t.style.overflowY = t.scrollHeight > 180 ? 'auto' : 'hidden';
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

  const uploadOne = async (file: File): Promise<Attachment | null> => {
    if (uploadFile) return uploadFile(file);
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'include' });
    return res.ok ? ((await res.json()) as Attachment) : null;
  };

  const uploadFiles = async (files: FileList | File[]) => {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const att = await uploadOne(file);
        if (att) setAttachments((a) => [...a, att]);
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

  // Icon face for the mode picker on narrow screens — shows the CURRENT
  // mode, so a note/teach selection can't hide behind a generic glyph.
  const ModeIcon = sendAs === 'agent' ? Bot : sendAs === 'note' ? Lock : sendAs === 'teach' ? Brain : Headset;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer-box" ref={boxRef}>
      {attachments.length > 0 && (
        <div className="attach-list">
          {attachments.map((a, i) => (
            <span key={i} className="attach-chip">
              {a.type.startsWith('image/')
                ? <Image size={12} style={{ verticalAlign: '-1px', marginRight: 3 }} />
                : <Paperclip size={12} style={{ verticalAlign: '-1px', marginRight: 3 }} />}
              {a.name}
              <a
                href="#"
                aria-label={`Remove ${a.name}`}
                onClick={(e) => {
                  e.preventDefault();
                  setAttachments((prev) => prev.filter((_, j) => j !== i));
                }}
              >
                {' '}<X size={11} style={{ verticalAlign: '-1px' }} />
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
            placeholder ??
            (sendAs === 'agent'
              ? narrow ? 'Reply as the agent…' : 'Reply as the agent — the agent keeps control…'
              : sendAs === 'note'
                ? narrow ? 'Note for teammates…' : 'Leave an internal note — only your team sees it…'
                : sendAs === 'teach'
                  ? narrow ? 'Teach the agent…' : 'Teach the agent — saved and used in future replies…'
                  : narrow ? 'Reply as yourself…' : 'Reply as yourself — takes over, pausing the agent…')
          }
        />

        <div className="composer-bar">
          <button type="button" className="btn icon" title="Emoji" aria-label="Emoji picker" onClick={() => setEmojiOpen((o) => !o)}><Smile size={16} /></button>
          <button type="button" className="btn icon" title="Attach file" aria-label="Attach file" onClick={() => fileRef.current?.click()}><Paperclip size={16} /></button>
          {(savedReplies?.saved_replies.length ?? 0) > 0 && (
            <button type="button" className="btn icon" title="Saved replies" aria-label="Saved replies" onClick={() => setRepliesOpen((o) => !o)}><FileText size={16} /></button>
          )}
          {onSuggest && (
            <button
              type="button"
              className={`btn icon${suggestActive && sendAs !== 'note' && sendAs !== 'teach' ? ' suggest-on' : ''}`}
              title={
                sendAs === 'note' || sendAs === 'teach'
                  ? 'Suggestions apply to visitor replies'
                  : 'Suggest a reply'
              }
              aria-label="Suggest a reply"
              aria-pressed={suggestActive && sendAs !== 'note' && sendAs !== 'teach'}
              disabled={sendAs === 'note' || sendAs === 'teach'}
              onClick={onSuggest}
            >
              <Sparkles size={16} />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
          />
          {showModeSelect && (
            <button
              type="button"
              className={`btn icon${sendAs !== 'human' ? ' sendas-on' : ''}`}
              title="Reply as"
              aria-label="Reply as"
              aria-expanded={sendasOpen}
              onClick={() => setSendasOpen((o) => !o)}
            >
              <ModeIcon size={16} />
            </button>
          )}
          <span className="grow" />
          {(onResume || onTakeover) && (
            <button
              className="btn takeover-toggle"
              type="button"
              onClick={onResume ?? onTakeover}
              title={onResume ? 'Resume — hand the thread back to the agent' : 'Pause — take over and reply yourself'}
              aria-label={onResume ? 'Resume the agent' : 'Pause the agent and take over'}
            >
              {onResume ? <Bot size={14} /> : <Headset size={14} />}
              <span className="btn-label always">{onResume ? 'Resume' : 'Pause'}</span>
            </button>
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

      {emojiOpen && <EmojiPicker onPick={insertEmoji} />}
      {sendasOpen && (
        <div className="emoji-pop sendas-pop">
          {(
            [
              ['human', Headset, 'Reply as yourself'],
              ['agent', Bot, 'Reply as the agent'],
              ['note', Lock, 'Leave an internal note'],
              ...(canTeach ? [['teach', Brain, 'Teach the agent'] as const] : []),
            ] as const
          ).map(([mode, Icon, label]) => (
            <button
              key={mode}
              type="button"
              className="sendas-opt"
              onClick={() => {
                setSendAs(mode);
                setSendasOpen(false);
              }}
            >
              <Icon size={14} />
              <span>{label}</span>
              {sendAs === mode && <Check size={14} className="ck" />}
            </button>
          ))}
        </div>
      )}
      {repliesOpen && (
        <div className="emoji-pop reply-pop">
          <div className="row" style={{ padding: '4px 8px 0', alignItems: 'center' }}>
            <span className="muted grow" style={{ fontSize: 11.5 }}>Saved replies</span>
            <button
              type="button"
              className="btn icon sm"
              aria-label="Close saved replies"
              onClick={() => setRepliesOpen(false)}
            >
              <X size={13} />
            </button>
          </div>
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
