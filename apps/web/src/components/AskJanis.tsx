import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import {
  reconcilePoll,
  timelineItems,
  type Attachment,
  type ChatMsg,
  type OutEntry,
} from '../lib/chatTimeline';
import { Loader2, Maximize2, Mic, MicOff, Minimize2, Paperclip, Smile, X } from 'lucide-react';
import { EmojiPicker } from './EmojiPicker';
import { ArgsRows } from './bits';
import { splitEmphasis } from '../lib/richText';

interface ChatConfig {
  agent_name: string;
  title: string;
  greeting: string | null;
  quick_replies: string[];
  logo_url: string | null;
}

interface PendingFile {
  name: string;
  uploading: boolean;
  url?: string;
  type?: string;
  size?: number;
}



function visitorId(): string {
  const k = 'janis_console_visitor';
  let v = localStorage.getItem(k);
  if (!v) {
    v = (crypto.randomUUID?.() ?? `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`).replace(/-/g, '');
    localStorage.setItem(k, v);
  }
  return v;
}

/** Render [label](url) markdown links and bare https:// URLs as anchors —
 * same rules as the public widget, DOM-only so text can't inject markup.
 * Links on this origin (or app.janis.ai in dev) go through the SPA router so
 * the rail stays open; everything else opens in a new tab. */
/** Sentence punctuation glued to a URL — "see https://x.com/a." should link
 * the URL, not the period. Closers are only stripped when unbalanced, so
 * https://x.com/f_(b) keeps its parens while "(see https://x.com)" doesn't
 * eat the bracket. Returns [cleanUrl, trailingText]. */
function splitTrail(u: string): [string, string] {
  let trail = '';
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  while (u.length) {
    const c = u[u.length - 1];
    if ('.,;:!?\'"'.includes(c)) {
      trail = c + trail;
      u = u.slice(0, -1);
      continue;
    }
    const open = pairs[c];
    if (open && u.split(c).length - 1 > u.split(open).length - 1) {
      trail = c + trail;
      u = u.slice(0, -1);
      continue;
    }
    break;
  }
  return [u, trail];
}

function linkify(text: string, onNav: (to: string) => void) {
  const parts: (string | { label: string; href: string })[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"']+)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [href, trail] = splitTrail(m[2] ?? m[3]!);
    if (!href) {
      parts.push(m[0]); // nothing left after trimming — emit the raw match
    } else {
      parts.push({ label: m[1] ?? href, href });
      if (trail) parts.push(trail);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((p, i) => {
    if (typeof p === 'string') return p;
    let internal: string | null = null;
    try {
      const u = new URL(p.href);
      if (u.origin === location.origin || u.hostname === 'app.janis.ai') {
        internal = u.pathname + u.search + u.hash;
      }
    } catch {
      /* not a parseable url — treat as external */
    }
    return internal ? (
      <a
        key={i}
        href={internal}
        onClick={(e) => {
          e.preventDefault();
          onNav(internal!);
        }}
      >
        {p.label}
      </a>
    ) : (
      <a key={i} href={p.href} target="_blank" rel="noreferrer">
        {p.label}
      </a>
    );
  });
}

/** Markdown-ish emphasis on top of linkify — agent text uses **bold**,
 *  *italic*, ~~strike~~ and `code` (canonical format; push channels get it
 *  translated at send time). */
function richText(text: string, onNav: (to: string) => void) {
  return splitEmphasis(text).flatMap((seg, i) => {
    const inner = linkify(seg.text, onNav);
    if (seg.kind === 'text') return inner;
    const Tag =
      seg.kind === 'bold' ? 'b' : seg.kind === 'italic' ? 'em' : seg.kind === 'strike' ? 's' : 'code';
    return [
      <Tag key={i} className={seg.kind === 'code' ? 'md-code' : undefined}>
        {inner}
      </Tag>,
    ];
  });
}

/** mp4/aac → 16kHz mono PCM WAV — Gemini's audio input drops Safari's mp4
 *  recordings silently, so they're transcoded before upload. */
async function toWav(blob: Blob): Promise<Blob> {
  const actx = new AudioContext();
  try {
    const decoded = await actx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const hdr = new DataView(new ArrayBuffer(44));
    const ws = (o: number, s: string) => {
      for (let j = 0; j < s.length; j++) hdr.setUint8(o + j, s.charCodeAt(j));
    };
    ws(0, 'RIFF'); hdr.setUint32(4, 36 + out.length * 2, true); ws(8, 'WAVE');
    ws(12, 'fmt '); hdr.setUint32(16, 16, true); hdr.setUint16(20, 1, true);
    hdr.setUint16(22, 1, true); hdr.setUint32(24, rate, true);
    hdr.setUint32(28, rate * 2, true); hdr.setUint16(32, 2, true); hdr.setUint16(34, 16, true);
    ws(36, 'data'); hdr.setUint32(40, out.length * 2, true);
    return new Blob([hdr.buffer, out.buffer], { type: 'audio/wav' });
  } finally {
    void actx.close();
  }
}

/** Peak RMS while recording — distinguishes "transcribed silence" (dead mic
 *  input) from "heard but couldn't parse", which otherwise look identical. */
function meterStream(stream: MediaStream): { peak: () => number; stop: () => void } {
  try {
    const actx = new AudioContext();
    const src = actx.createMediaStreamSource(stream);
    const an = actx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let peak = 0;
    let raf = 0;
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) {
        const d = (buf[i]! - 128) / 128;
        s += d * d;
      }
      const rms = Math.sqrt(s / buf.length);
      if (rms > peak) peak = rms;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return {
      peak: () => peak,
      stop: () => {
        cancelAnimationFrame(raf);
        src.disconnect();
        void actx.close();
      },
    };
  } catch {
    return { peak: () => 1, stop: () => {} };
  }
}

function AttachmentNodes({ atts }: { atts: Attachment[] }) {
  return (
    <>
      {atts.map((a, i) =>
        a.type?.startsWith('image/') ? (
          <a key={i} href={a.url} target="_blank" rel="noreferrer">
            <img className="ask-att-img" src={a.url} alt={a.name} />
          </a>
        ) : (
          <a key={i} className="ask-att" href={a.url} target="_blank" rel="noreferrer">
            <Paperclip size={12} style={{ verticalAlign: '-1px', marginRight: 3 }} />{a.name}
          </a>
        ),
      )}
    </>
  );
}

/** "Ask Janis" — the concierge agent's webchat, docked as a right rail.
 * Feature-parity with the public widget: multiline input, emoji, uploads,
 * optimistic send with Delivered/retry, typing dots, per-message quick replies. */
export function AskJanis({
  channelId,
  badge,
  onClose,
  onToggleExpand,
  expanded,
  seedMessage,
}: {
  channelId: string;
  badge?: string;
  onClose?: () => void; // omitted when the rail's own tab strip handles close
  /** Concierge-only: expand to /ask / dock back to the rail. */
  onToggleExpand?: () => void;
  expanded?: boolean;
  // Auto-sent once on load — discovery cards / ?rail=ask&q= deeplinks.
  seedMessage?: string;
}) {
  const navigate = useNavigate();
  const visitor = useRef(visitorId()).current;
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [outbox, setOutbox] = useState<OutEntry[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [convState, setConvState] = useState('agent');
  const [convId, setConvId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  // an operator composing a reply in the console — visitor-side dots
  const [opTyping, setOpTyping] = useState<string | null>(null); // '' = anonymous
  // server-side "message dispatched to the agent, no reply yet" — unlike the
  // post-send `typing` guess this also covers slow runs and silent failures
  const [agentTyping, setAgentTyping] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [chips, setChips] = useState<(string | { type: 'email' | 'phone' })[] | null>(null);
  const [loaded, setLoaded] = useState(false); // composer disabled until first poll lands
  const [hasMore, setHasMore] = useState(false); // older pages exist — scroll up to back-fill
  const [fetchingOlder, setFetchingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Dictation — MediaRecorder → server-side transcription (POST
  // /chat/:id/transcribe). Deliberately not Web Speech: Chrome's path
  // silently produces nothing where its speech service is unreachable, and
  // Firefox lacks the API entirely. Mic hides only where capture is
  // unavailable.
  const recRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dictating, setDictating] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Transient dictation-failure note — shown in place of the placeholder.
  const [dictNote, setDictNote] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const lastTs = useRef<string | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollBusy = useRef(false);
  const loadStart = useRef(0);
  const oldestTs = useRef<string | null>(null); // before-cursor for history back-fill
  const loadingOlder = useRef(false);
  // stay glued to the bottom while the user is near it — a poll landing while
  // they're scrolled up reading history must not yank them back down
  const stick = useRef(true);
  const pendingAdjust = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const participantRef = useRef<string | null>(null);
  const lastTypingPing = useRef(0);
  // Mirror of outbox — state updaters run at render time, so poll() needs a
  // synchronous view of pending entries to reconcile server echoes.
  const outboxRef = useRef<OutEntry[]>([]);
  const setOb = (fn: (o: OutEntry[]) => OutEntry[]) => {
    outboxRef.current = fn(outboxRef.current);
    setOutbox(outboxRef.current);
  };

  const { data: cfg } = useQuery({
    queryKey: ['ask-janis-config', channelId],
    queryFn: () => api<ChatConfig>(`/chat/${channelId}`),
    staleTime: 300_000,
  });

  const hideTyping = () => {
    setTyping(false);
    setAgentTyping(false);
    setOpTyping(null);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
  };
  const showTyping = () => {
    if (convState === 'human') return;
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(hideTyping, 45_000);
  };

  // Incremental poll — same reconciliation as the widget: a server echo of an
  // 'in' message promotes the matching outbox entry to Delivered; any non-'in'
  // message clears the typing dots; per-message quick_replies replace the chips.
  const poll = async () => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    if (!loadStart.current) loadStart.current = Date.now();
    try {
      let url = `/chat/${channelId}/messages?visitor_id=${visitor}`;
      if (lastTs.current) url += `&after=${encodeURIComponent(lastTs.current)}`;
      const d = await api<{
        messages: ChatMsg[];
        state: string;
        participant?: string;
        conversation_id?: string;
        has_more?: boolean;
        operator_typing?: { name: string | null } | null;
        agent_typing?: boolean;
      }>(url);
      // The first fetch usually lands in <100ms — without a floor the loading
      // row never paints and history reads as popping in with no indicator.
      const delay = Math.max(0, 500 - (Date.now() - loadStart.current));
      if (delay) await new Promise((r) => setTimeout(r, delay));
      // The server tells us which participant this transcript belongs to — a
      // switch (session expired, identity change) invalidates the cursor,
      // dedupe set and outbox; reset and re-poll the new thread from scratch.
      if (d.participant && participantRef.current && participantRef.current !== d.participant) {
        seen.current = new Set();
        setMsgs([]);
        setOb(() => []);
        hideTyping();
        // This response's messages are valid for the new thread (just sliced
        // by the old cursor) — process them below, and leave lastTs null so
        // the next poll back-fills the latest page without a gap.
        lastTs.current = null;
        oldestTs.current = null;
        setHasMore(false);
      }
      if (d.participant) participantRef.current = d.participant;
      setConvState(d.state);
      if (d.conversation_id) setConvId(d.conversation_id);
      if (d.has_more !== undefined) setHasMore(d.has_more);
      const { outbox: next, fresh, maxTs, minTs } = reconcilePoll(
        outboxRef.current,
        d.messages,
        seen.current,
      );
      if (maxTs && (!lastTs.current || maxTs > lastTs.current)) lastTs.current = maxTs;
      if (minTs && (!oldestTs.current || minTs < oldestTs.current)) oldestTs.current = minTs;
      setOb(() => next);
      // A reply landing this round ends the dots — and the typing flags in
      // this same response may be stale relative to it, so don't re-assert
      // them; a still-typing operator or newly dispatched agent re-marks on
      // the next poll anyway.
      const gotReply = fresh.some((m) => m.direction !== 'in');
      if (fresh.length) {
        setMsgs((cur) => [...cur, ...fresh]);
        if (gotReply) hideTyping();
      }
      // Chips belong to the newest message only — a visitor send (including
      // an echo swallowed by the outbox match above) or any newer message
      // without its own quick replies retires the offer.
      const sawInbound = d.messages.some((m) => m.direction === 'in');
      if (fresh.length || sawInbound) {
        const last = fresh[fresh.length - 1];
        setChips(last && last.direction !== 'in' && last.quick_replies?.length ? last.quick_replies : null);
      }
      setOpTyping(gotReply ? null : d.operator_typing ? (d.operator_typing.name ?? '') : null);
      setAgentTyping(gotReply ? false : !!d.agent_typing);
    } catch {
      /* keep polling */
    } finally {
      pollBusy.current = false;
      setLoaded(true); // unlock the composer after the first poll attempt resolves
    }
  };

  useEffect(() => {
    void poll();
    const t = setInterval(() => void poll(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, visitor]);

  // Older history back-fill — the initial poll returns the latest page; at
  // the scroll top we fetch the page before the oldest rendered message and
  // prepend it, holding the scroll position steady.
  const loadOlder = async () => {
    if (!hasMore || loadingOlder.current || !oldestTs.current) return;
    loadingOlder.current = true;
    setFetchingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const d = await api<{ messages: ChatMsg[]; has_more?: boolean }>(
        `/chat/${channelId}/messages?visitor_id=${visitor}&before=${encodeURIComponent(oldestTs.current)}`,
      );
      const fresh = d.messages.filter((m) => {
        if (m.id && seen.current.has(m.id)) return false;
        if (m.id) seen.current.add(m.id);
        return true;
      });
      if (fresh.length) {
        pendingAdjust.current = { prevHeight, prevTop };
        setMsgs((cur) => [...fresh, ...cur]);
        oldestTs.current = fresh[0].created_at;
      }
      if (d.has_more !== undefined) setHasMore(d.has_more);
    } catch {
      /* keep polling */
    } finally {
      loadingOlder.current = false;
      setFetchingOlder(false);
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 60 && loaded) void loadOlder();
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pendingAdjust.current) {
      // history prepended above — keep the viewport on the same message
      el.scrollTop = pendingAdjust.current.prevTop + (el.scrollHeight - pendingAdjust.current.prevHeight);
      pendingAdjust.current = null;
    } else if (stick.current) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [msgs.length, outbox.length, typing]);

  const autoresize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
    // no scrollbar until content actually overflows the cap
    el.style.overflowY = el.scrollHeight > 110 ? 'auto' : 'hidden';
  };

  // Gemini accepts webm/ogg/wav/mp3/aiff/flac — NOT mp4/m4a/aac, which is
  // Gemini accepts webm/ogg/wav/mp3/aiff/flac — NOT mp4/m4a/aac, which is
  // Safari's only MediaRecorder output; those are transcoded to WAV
  // client-side (toWav) before upload.
  const dictMime =
    typeof MediaRecorder !== 'undefined'
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'].find(
          (t) => {
            try {
              return MediaRecorder.isTypeSupported(t);
            } catch {
              return false;
            }
          },
        )
      : undefined;
  const recMime =
    dictMime ??
    (() => {
      try {
        return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : undefined;
      } catch {
        return undefined;
      }
    })();
  const canDictate =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    !!recMime;

  const flashDictNote = (note: string) => {
    setDictNote(note);
    setTimeout(() => setDictNote(null), 4000);
  };

  const toggleDictate = () => {
    if (transcribing) return;
    if (recRef.current) {
      if (recRef.current.state !== 'inactive') recRef.current.stop();
      return;
    }
    if (!canDictate) return;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        micStreamRef.current = stream;
        const chunks: Blob[] = [];
        const meter = meterStream(stream);
        let rec: MediaRecorder;
        try {
          rec = new MediaRecorder(stream, recMime ? { mimeType: recMime } : undefined);
        } catch {
          meter.stop();
          stream.getTracks().forEach((t) => t.stop());
          micStreamRef.current = null;
          return;
        }
        recRef.current = rec;
        rec.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data);
        };
        rec.onstop = () => {
          recRef.current = null;
          setDictating(false);
          if (micTimerRef.current) {
            clearTimeout(micTimerRef.current);
            micTimerRef.current = null;
          }
          micStreamRef.current?.getTracks().forEach((t) => t.stop());
          micStreamRef.current = null;
          const level = meter.peak();
          meter.stop();
          if (!chunks.length) return;
          const blob = new Blob(chunks, { type: chunks[0].type || rec.mimeType || 'audio/webm' });
          console.debug('[janis] dictation blob', blob.type, `${blob.size}B`, 'peak', level.toFixed(3));
          if (level < 0.005) {
            flashDictNote('No sound captured — check your mic input');
            return;
          }
          const up = /mp4|m4a|aac/.test(blob.type)
            ? toWav(blob).then(
                (w) => ({ blob: w, ext: 'wav' }),
                () => ({ blob, ext: 'm4a' }),
              )
            : Promise.resolve({ blob, ext: /ogg/.test(blob.type) ? 'ogg' : 'webm' });
          setTranscribing(true);
          setDictNote('Transcribing…');
          up.then((u) => {
            const fd = new FormData();
            fd.append('audio', u.blob, `dictation.${u.ext}`);
            return fetch(`/chat/${channelId}/transcribe`, { method: 'POST', body: fd });
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
            .then((d: { text?: string }) => {
              const said = (d.text ?? '').trim();
              if (said) {
                setText((t) => (t ? t.replace(/\s+$/, '') + ' ' : '') + said);
                requestAnimationFrame(autoresize);
              } else {
                flashDictNote('Did not catch that — try again');
              }
            })
            .catch(() => flashDictNote('Transcription failed — try again'))
            .finally(() => {
              setTranscribing(false);
              setDictNote((n) => (n === 'Transcribing…' ? null : n));
            });
        };
        rec.start();
        setDictating(true);
        // hard cap — keeps a forgotten mic from recording for hours
        micTimerRef.current = setTimeout(() => {
          if (rec.state !== 'inactive') rec.stop();
        }, 90_000);
        inputRef.current?.focus();
      })
      .catch((err: { name?: string }) => {
        flashDictNote(err?.name === 'NotAllowedError' ? 'Microphone access denied' : 'No microphone found');
      });
  };

  // Rail closing mid-dictation shouldn't keep the mic live.
  useEffect(
    () => () => {
      if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const insertEmoji = (em: string) => {
    const el = inputRef.current;
    if (!el) return setText((t) => t + em);
    const s = el.selectionStart ?? text.length;
    const e = el.selectionEnd ?? s;
    setText(text.slice(0, s) + em + text.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = s + em.length;
      autoresize();
    });
  };

  const pickFiles = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const slot: PendingFile = { name: f.name, uploading: true };
      setPending((cur) => (cur.length >= 5 ? cur : [...cur, slot]));
      const fd = new FormData();
      fd.append('visitor_id', visitor);
      fd.append('file', f);
      fetch(`/chat/${channelId}/uploads`, { method: 'POST', body: fd })
        .then((r) => (r.ok ? r.json() : null))
        .then((a) => {
          setPending((p) =>
            a
              ? p.map((x) =>
                  x === slot ? { ...x, name: a.name, url: a.url, type: a.type, size: a.size, uploading: false } : x,
                )
              : p.filter((x) => x !== slot),
          );
        })
        .catch(() => setPending((p) => p.filter((x) => x !== slot)));
    }
  };

  const send = async (body: string, atts: Attachment[], retryOf?: OutEntry) => {
    const t = body.trim();
    if ((!t && !atts.length) || sending || !loaded) return;
    setSending(true);
    setText('');
    requestAnimationFrame(autoresize);
    setChips(null);
    const entry: OutEntry =
      retryOf ?? {
        localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: t,
        attachments: atts,
        status: 'pending' as const,
        ts: new Date().toISOString(),
      };
    if (retryOf) {
      setOb((ob) =>
        ob.map((o) => (o.localId === retryOf.localId ? { ...o, status: 'pending' as const } : o)),
      );
    } else {
      setOb((ob) => [
        ...ob.map((o) => (o.status === 'delivered' ? { ...o, status: 'sent' as const } : o)),
        entry,
      ]);
    }
    try {
      await api(`/chat/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          visitor_id: visitor,
          text: t,
          attachments: atts,
          // idempotency key — a retried POST (after a timeout or lost
          // response) dedupes server-side instead of double-storing
          client_id: entry.localId,
          // which console page the sender was on — the concierge sees this as
          // the `page` trait ("the user was on /reports when they asked")
          page: location.pathname + location.search,
        }),
      });
      showTyping();
      await poll();
      // The awaited poll can race the store — verify once more, then mark failed
      // if the echo never arrived (e.g. plan cap dropped the message).
      setTimeout(async () => {
        await poll();
        setOb((ob) =>
          ob.map((o) => (o.localId === entry.localId && o.status === 'pending' ? { ...o, status: 'failed' as const } : o)),
        );
      }, 1500);
    } catch {
      // The write may have landed even though the response was lost — poll
      // once so a stored echo reconciles the entry to delivered before we
      // call it failed.
      await poll();
      setOb((ob) => ob.map((o) => (o.localId === entry.localId && o.status === 'pending' ? { ...o, status: 'failed' as const } : o)));
      hideTyping();
    } finally {
      setSending(false);
    }
  };

  // Seeded questions fire once each — tracked by value so a second card click
  // (or a fresh ?q= link) sends its own question.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!seedMessage || !loaded || seedMessage === seededFor.current) return;
    seededFor.current = seedMessage;
    void send(seedMessage, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedMessage, loaded]);

  const submit = () => {
    const ready = pending.filter((p) => !p.uploading);
    setPending((p) => p.filter((x) => x.uploading));
    void send(text, ready.map((p) => ({ name: p.name, url: p.url!, type: p.type!, size: p.size! })));
  };

  const [deciding, setDeciding] = useState<string | null>(null);
  const [actError, setActError] = useState('');
  const decide = async (msgId: string, actionId: string, decision: 'approved' | 'denied') => {
    if (deciding) return;
    setDeciding(actionId);
    setActError('');
    try {
      await api(`/api/actions/${actionId}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      // Optimistically resolve the card; the next poll lands the real row.
      setMsgs((ms) =>
        ms.map((m) =>
          m.id === msgId && m.action ? { ...m, action: { ...m.action, status: decision } } : m,
        ),
      );
      showTyping();
      void poll();
    } catch (e) {
      setActError(e instanceof Error ? e.message : 'decision failed');
    } finally {
      setDeciding(null);
    }
  };

  const deliveredEntry = [...outbox].reverse().find((o) => o.status === 'delivered');

  return (
    <div className="ask-pane">
      <div className="ask-head">
        <strong className="grow">{cfg?.agent_name ?? 'Ask Janis'}</strong>
        {badge && <span className="badge">{badge}</span>}
        {onToggleExpand && (
          <button
            className="btn"
            onClick={onToggleExpand}
            title={expanded ? 'Dock panel' : 'Expand'}
            aria-label={expanded ? 'Dock panel' : 'Expand panel'}
          >
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        )}
        {onClose && (
          <button className="btn" onClick={onClose} title="Close" aria-label="Close panel"><X size={14} /></button>
        )}
      </div>
      <div className="ask-scroll" ref={scrollRef} onScroll={onScroll}>
        {!loaded && <div className="ask-loading muted">Loading conversation…</div>}
        {fetchingOlder && <div className="ask-loading muted">Loading earlier messages…</div>}
        {/* Placeholder greeting — only until the transcript lands. On an
            internal test channel the stored greeting row arrives with the
            first poll after sending (same text: bootstrap resolves it
            synchronously to warm the cache), so this swaps seamlessly rather
            than vanishing when the outbox fills. */}
        {loaded && cfg?.greeting && !msgs.length && (
          <div className="ask-msg them">
            {cfg.agent_name && (
              <div className="ask-author">
                {cfg.logo_url && <img className="ask-author-img" src={cfg.logo_url} alt="" />}
                {cfg.agent_name}
              </div>
            )}
            {richText(cfg.greeting, navigate)}
          </div>
        )}
        {timelineItems(msgs, outbox)
          .map((item, idx, arr) => {
            // Sender label only opens a run — consecutive bubbles from the
            // same sender don't each need the name/avatar. Human replies get
            // the operator's identity; agent replies get the agent's.
            const prev = arr[idx - 1];
            const sameRun =
              item.kind === 'msg' &&
              prev?.kind === 'msg' &&
              prev.m.direction === item.m.direction &&
              (item.m.direction !== 'human' ||
                (prev.m.author?.name ?? '') === (item.m.author?.name ?? ''));
            const author =
              item.kind === 'msg'
                ? item.m.direction === 'human'
                  ? item.m.author
                  : item.m.direction === 'out' && cfg?.agent_name
                    ? { name: cfg.agent_name, avatar: cfg.logo_url }
                    : undefined
                : undefined;
            const firstOfRun = !!author && !sameRun;
            return item.kind === 'msg' ? (
              <div
                key={item.key}
                className={`ask-msg ${item.m.direction === 'in' ? 'me' : item.m.direction === 'human' ? 'human' : 'them'}`}
              >
                {firstOfRun && (
                  <div className="ask-author">
                    {author!.avatar && <img className="ask-author-img" src={author!.avatar} alt="" />}
                    {author!.name}
                  </div>
                )}
                {/* A card row's text IS its label ("Teach Acme Returns") —
                    rendering both doubles the title. */}
                {!(item.m.action && item.m.text === item.m.action.label) &&
                  richText(item.m.text, navigate)}
                {item.m.action && (
                  <div className="action-card">
                    <div className="mono" style={{ fontSize: 12 }}>
                      {item.m.action.label ?? item.m.action.tool}
                    </div>
                    <ArgsRows args={item.m.action.display ?? item.m.action.args} />
                    {actError && item.m.action.status === 'pending' && (
                      <div className="muted" style={{ color: '#c0392b', fontSize: 12, marginTop: 4 }}>
                        {actError}
                      </div>
                    )}
                    {item.m.action.status === 'pending' ? (
                      <div className="row" style={{ marginTop: 6 }}>
                        <button
                          className="btn primary sm"
                          disabled={deciding === item.m.action.id}
                          onClick={() => void decide(item.m.id, item.m.action!.id, 'approved')}
                        >
                          Approve &amp; run
                        </button>
                        <button
                          className="btn sm"
                          disabled={deciding === item.m.action.id}
                          onClick={() => void decide(item.m.id, item.m.action!.id, 'denied')}
                        >
                          Deny
                        </button>
                      </div>
                    ) : (
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        {item.m.action.status === 'approved' ? '✅ approved' : '⛔ denied'}
                        {item.m.action.decided_by ? ` by ${item.m.action.decided_by}` : ''}
                        {item.m.action.result ? ` — ${item.m.action.result}` : ''}
                      </div>
                    )}
                  </div>
                )}
                <AttachmentNodes atts={item.m.attachments ?? []} />
              </div>
            ) : (
              <Fragment key={item.key}>
                <div
                  className={`ask-msg me ${item.o.status === 'pending' ? 'pending' : ''} ${item.o.status === 'failed' ? 'failed' : ''}`}
                  onClick={item.o.status === 'failed' ? () => void send(item.o.text, item.o.attachments, item.o) : undefined}
                >
                  {richText(item.o.text, navigate)}
                  <AttachmentNodes atts={item.o.attachments} />
                </div>
                {item.o.status === 'delivered' && deliveredEntry === item.o && <div className="ask-status">Delivered</div>}
                {item.o.status === 'failed' && (
                  <div className="ask-status ask-status-fail" onClick={() => void send(item.o.text, item.o.attachments, item.o)}>
                    Not delivered — tap to retry
                  </div>
                )}
              </Fragment>
            );
          })}
        {(typing || agentTyping || opTyping !== null) && (
          <div className="ask-msg them ask-typing">
            {/* the dots must sit in a flex container — plain inline spans
                ignore width/height and render at 0×0 (invisible) */}
            <span className="ask-dots">
              <span className="ask-dot" /><span className="ask-dot" /><span className="ask-dot" />
            </span>
          </div>
        )}
        {convState !== 'human' && (chips ?? (!loaded || msgs.length ? null : cfg?.quick_replies ?? null))?.length ? (
          <div className="ask-qrs">
            {(chips ?? cfg?.quick_replies ?? []).map((q, i) =>
              typeof q === 'string' ? (
                <button key={q} className="btn" onClick={() => void send(q, [])}>{q}</button>
              ) : (
                <AskField
                  key={i}
                  type={q.type}
                  onSend={(v) => void send(v, [])}
                />
              ),
            )}
          </div>
        ) : null}
        {convState === 'human' && (
          <div className="muted" style={{ padding: '4px 12px', fontSize: 12 }}>
            a human has taken over this conversation — the agent is paused
            {convId && (
              <>
                {' — '}
                <Link to={`/conversations/${convId}`}>open in console</Link>
              </>
            )}
          </div>
        )}
        {convState === 'needs_human' && (
          <div className="muted" style={{ padding: '4px 12px', fontSize: 12 }}>
            flagged for a human
            {convId && (
              <>
                {' — '}
                <Link to={`/conversations/${convId}`}>open in console</Link>
              </>
            )}
          </div>
        )}
      </div>
      {pending.length > 0 && (
        <div className="ask-attach">
          {pending.map((p, i) => (
            <span key={i} className="ask-chip">
              {p.uploading
                ? <Loader2 size={12} className="spin" style={{ verticalAlign: '-1px', marginRight: 3 }} />
                : <Paperclip size={12} style={{ verticalAlign: '-1px', marginRight: 3 }} />}
              {p.name}
              <button aria-label="Remove" onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      {emojiOpen && <EmojiPicker variant="inline" onPick={insertEmoji} />}
      <div className="ask-input">
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          disabled={!loaded}
          placeholder={dictNote ?? `Message ${cfg?.agent_name ?? 'Janis'}…`}
          onChange={(e) => {
            setText(e.target.value);
            autoresize();
            // throttled ping — the console shows "visitor is typing" dots
            if (Date.now() - lastTypingPing.current > 2500 && visitor) {
              lastTypingPing.current = Date.now();
              void api(`/chat/${channelId}/typing`, {
                method: 'POST',
                body: JSON.stringify({ visitor_id: visitor }),
              }).catch(() => {});
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="ask-input-row">
          <button className="btn" title="Emoji" disabled={!loaded} onClick={() => setEmojiOpen((o) => !o)}><Smile size={15} /></button>
          <button className="btn" title="Attach" disabled={!loaded} onClick={() => fileRef.current?.click()}><Paperclip size={15} /></button>
          <input
            ref={fileRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              pickFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <span className="grow" />
          {canDictate && (
            <button
              className="btn"
              title={dictating ? 'Stop dictating' : 'Dictate'}
              disabled={!loaded || transcribing}
              style={dictating ? { color: 'var(--danger)' } : undefined}
              onClick={toggleDictate}
            >
              {dictating ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
          )}
          <button
            className="btn primary"
            disabled={!loaded || sending || (!text.trim() && !pending.some((p) => !p.uploading))}
            onClick={submit}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

/** Inline contact-field ask ({type:'email'|'phone'} quick reply) — the
 * console preview counterpart of the widget's inline field. */
function AskField({ type, onSend }: { type: 'email' | 'phone'; onSend: (v: string) => void }) {
  const [v, setV] = useState('');
  const submit = () => {
    const t = v.trim();
    if (!t) return;
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return;
    onSend(t);
  };
  return (
    <span className="row" style={{ gap: 6, flex: '1 1 100%' }}>
      <input
        type={type === 'email' ? 'email' : 'tel'}
        placeholder={type === 'email' ? 'you@example.com' : 'Your phone number'}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        style={{ flex: 1, minWidth: 0 }}
      />
      <button className="btn" onClick={submit} disabled={!v.trim()}>
        Share
      </button>
    </span>
  );
}
