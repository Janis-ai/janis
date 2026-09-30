import { useEffect, useRef, useState } from 'react';

/** Curated emoji set with search keywords — enough coverage for support
 *  replies without shipping a full emoji database. */
const EMOJI_LIST: [string, string][] = [
  ['😀', 'grinning smile happy'],
  ['😄', 'smile happy grin'],
  ['😁', 'beaming grin happy'],
  ['🙂', 'slight smile'],
  ['😉', 'wink'],
  ['😊', 'smiling blush pleased'],
  ['😍', 'heart eyes love'],
  ['🤩', 'star struck wow'],
  ['😘', 'kiss'],
  ['😜', 'wink tongue playful'],
  ['🤪', 'zany silly'],
  ['😎', 'cool sunglasses'],
  ['🤔', 'thinking hmm'],
  ['🤨', 'raised eyebrow skeptical'],
  ['😅', 'relieved sweat smile'],
  ['😂', 'joy laughing tears'],
  ['🤣', 'rofl laughing'],
  ['🥲', 'tear smile grateful'],
  ['😢', 'cry sad tear'],
  ['😭', 'sob crying'],
  ['😮', 'surprised wow open mouth'],
  ['😴', 'sleep tired'],
  ['🤗', 'hug'],
  ['🤝', 'handshake deal agreement'],
  ['👍', 'thumbs up yes approve'],
  ['👎', 'thumbs down no'],
  ['🙏', 'pray please thanks'],
  ['👏', 'clap applause'],
  ['🙌', 'raised hands celebrate'],
  ['💪', 'muscle strong'],
  ['🫶', 'heart hands'],
  ['✌️', 'peace victory'],
  ['🤞', 'fingers crossed luck'],
  ['👋', 'wave hello bye'],
  ['👀', 'eyes look watching'],
  ['💬', 'speech bubble chat message'],
  ['🗣️', 'speak talk'],
  ['❤️', 'red heart love'],
  ['🧡', 'orange heart'],
  ['💛', 'yellow heart'],
  ['💚', 'green heart'],
  ['💙', 'blue heart'],
  ['💜', 'purple heart'],
  ['🖤', 'black heart'],
  ['🤍', 'white heart'],
  ['💔', 'broken heart'],
  ['💯', 'hundred perfect'],
  ['✨', 'sparkles new magic'],
  ['🔥', 'fire hot lit'],
  ['🎉', 'party celebrate confetti'],
  ['🎊', 'celebration confetti'],
  ['🎁', 'gift present'],
  ['⭐', 'star favorite'],
  ['⚡', 'lightning fast zap'],
  ['💡', 'idea lightbulb tip'],
  ['🔔', 'bell notification'],
  ['📌', 'pin pushpin'],
  ['📎', 'paperclip attachment'],
  ['📄', 'document page file'],
  ['🖼️', 'picture image frame'],
  ['📊', 'chart bar graph'],
  ['📈', 'chart up growth'],
  ['📉', 'chart down decline'],
  ['💳', 'credit card payment'],
  ['💰', 'money bag dollar'],
  ['📦', 'package box shipping order'],
  ['🚚', 'truck delivery shipping'],
  ['🚀', 'rocket launch ship'],
  ['✅', 'check done complete'],
  ['❌', 'x cross wrong cancel'],
  ['⚠️', 'warning caution'],
  ['❓', 'question help'],
  ['❗', 'exclamation important'],
  ['🕐', 'clock time one'],
  ['⏰', 'alarm reminder'],
  ['📅', 'calendar date schedule'],
  ['🗓️', 'calendar schedule'],
  ['🔒', 'lock secure private'],
  ['🔓', 'unlock open'],
  ['🔑', 'key access'],
  ['🛠️', 'tools fix repair'],
  ['🔧', 'wrench fix settings'],
  ['⚙️', 'gear settings config'],
  ['🐛', 'bug'],
  ['💻', 'laptop computer'],
  ['📱', 'phone mobile'],
  ['📞', 'phone call telephone'],
  ['📧', 'email mail'],
  ['✉️', 'envelope mail'],
  ['🔍', 'search magnify find'],
  ['🔎', 'search magnify'],
  ['📝', 'memo write note'],
  ['📋', 'clipboard list'],
  ['📁', 'folder files'],
  ['🔗', 'link chain'],
  ['🌐', 'globe web internet'],
  ['🏠', 'home house'],
  ['🏢', 'office building'],
  ['🛒', 'cart shopping'],
  ['🏷️', 'tag label price'],
  ['💵', 'dollar cash money'],
  ['🎫', 'ticket'],
  ['🆕', 'new'],
  ['🆓', 'free'],
  ['ℹ️', 'info information'],
  ['👤', 'person user profile'],
  ['👥', 'people users team'],
  ['🤖', 'robot bot ai'],
  ['👩‍💼', 'woman office worker'],
  ['👨‍💼', 'man office worker'],
  ['🙋', 'raised hand question'],
  ['🤷', 'shrug unknown'],
  ['😤', 'frustrated steam'],
  ['🙄', 'eye roll'],
  ['😌', 'relieved calm'],
  ['😇', 'angel innocent'],
  ['🥳', 'party face celebrate'],
  ['😬', 'grimace awkward'],
  ['🤯', 'mind blown'],
  ['👌', 'ok perfect'],
  ['✋', 'stop hand'],
  ['🫡', 'salute'],
  ['💪', 'flex muscle'],
  ['🎯', 'target goal bullseye'],
  ['🏆', 'trophy win'],
  ['🥇', 'gold medal first'],
  ['☕', 'coffee break'],
  ['🍕', 'pizza food'],
  ['🌍', 'earth globe world'],
  ['🇺🇸', 'us flag'],
];

/** Searchable emoji grid. `pop` (default) floats above the composer;
 *  `inline` renders in flow — the rail layout stacks it above the input. */
export function EmojiPicker({
  onPick,
  variant = 'pop',
}: {
  onPick: (emoji: string) => void;
  variant?: 'pop' | 'inline';
}) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const needle = q.trim().toLowerCase();
  const list = needle
    ? EMOJI_LIST.filter(([, k]) => k.includes(needle))
    : EMOJI_LIST;
  return (
    <div
      className={variant === 'inline' ? 'emoji-pop emoji-inline' : 'emoji-pop'}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        className="emoji-search"
        placeholder="Search emoji…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="emoji-grid">
        {list.map(([e, k]) => (
          <button key={e + k} type="button" title={k.split(' ')[0]} onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
        {!list.length && <div className="muted" style={{ fontSize: 12, padding: 8 }}>No match</div>}
      </div>
    </div>
  );
}
