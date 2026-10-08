import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** Backdrop + dialog shell — closes on Escape, backdrop click, or the X.
 *  Shared so every editor modal behaves identically. */
export function Modal({
  title,
  onClose,
  width = 560,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Focus the shell so Escape works — unless an inner field already took
  // focus (autoFocus on a textarea beats us, and we'd steal it back).
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, []);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className="modal"
        role="dialog"
        aria-modal="true"
        style={{ width, maxHeight: '78vh', overflowY: 'auto', outline: 'none' }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <strong>{title}</strong>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
