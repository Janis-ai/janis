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

export interface ConfirmChoice {
  key: string;
  label: string;
  /** red button — destructive actions */
  danger?: boolean;
  /** filled accent button — the recommended/safe action */
  primary?: boolean;
}

interface ConfirmReq {
  message: string;
  choices: ConfirmChoice[];
  resolve: (v: string | null) => void;
}

/** Styled replacement for window.confirm — returns [element, confirm].
 *  confirm() resolves the chosen choice key, or null on Cancel/Esc/backdrop.
 *  Default choices are Cancel + a single Confirm (key 'ok'); pass `choices`
 *  for multi-action dialogs (e.g. GDPR purge vs delete-only vs cancel). */
export function useConfirm(): [
  ReactNode,
  (message: string, choices?: ConfirmChoice[], danger?: boolean) => Promise<string | null>,
] {
  const [req, setReq] = useState<ConfirmReq | null>(null);

  const confirm = useCallback(
    (message: string, choices?: ConfirmChoice[], danger = false) =>
      new Promise<string | null>((resolve) => {
        setReq({
          message,
          choices: choices ?? [{ key: 'ok', label: 'Confirm', ...(danger ? { danger } : { primary: true }) }],
          resolve,
        });
      }),
    [],
  );

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
        aria-labelledby="confirm-msg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close(null);
        }}
      >
        <div className="modal-msg" id="confirm-msg">{req.message}</div>
        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" autoFocus onClick={() => close(null)}>Cancel</button>
          {req.choices.map((ch) => (
            <button
              key={ch.key}
              className={`btn ${ch.danger ? 'danger' : ''} ${ch.primary ? 'primary' : ''}`}
              onClick={() => close(ch.key)}
            >
              {ch.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  return [el, confirm];
}
