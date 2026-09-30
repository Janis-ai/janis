import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface Req {
  message: string;
  resolve: (v: string | null) => void;
}

/** Styled replacement for window.prompt — returns [element, ask]. Render the
 *  element anywhere in the component tree; ask() resolves with the input
 *  value on confirm, null on cancel/Esc/backdrop-click. */
export function usePrompt(): [ReactNode, (message: string, defaultValue?: string) => Promise<string | null>] {
  const [req, setReq] = useState<Req | null>(null);
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const ask = useCallback(
    (message: string, defaultValue = '') =>
      new Promise<string | null>((resolve) => {
        setVal(defaultValue);
        setReq({ message, resolve });
      }),
    [],
  );

  useEffect(() => {
    if (req) inputRef.current?.select();
  }, [req]);

  const close = (v: string | null) => {
    req?.resolve(v);
    setReq(null);
  };

  const el = req ? (
    <div className="modal-backdrop" onClick={() => close(null)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-msg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close(null);
        }}
      >
        <div className="modal-msg" id="prompt-msg">{req.message}</div>
        <input
          ref={inputRef}
          className="input"
          style={{ width: '100%', marginTop: 10 }}
          value={val}
          autoFocus
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') close(val);
          }}
        />
        <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={() => close(null)}>Cancel</button>
          <button className="btn primary" onClick={() => close(val)}>OK</button>
        </div>
      </div>
    </div>
  ) : null;

  return [el, ask];
}
