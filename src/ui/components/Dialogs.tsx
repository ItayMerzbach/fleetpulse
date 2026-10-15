import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

// ---------- Modal ----------

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus], button, input, select, textarea')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

// ---------- Confirm (promise based) ----------

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );

  const close = useCallback(
    (result: boolean) => {
      pending?.resolve(result);
      setPending(null);
    },
    [pending],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <Modal title={pending.title} onClose={() => close(false)}>
          <div className="modal-body">{pending.body}</div>
          <div className="modal-actions">
            <button className="btn" onClick={() => close(false)}>
              Cancel
            </button>
            <button className={`btn ${pending.danger ? 'btn-danger' : 'btn-primary'}`} data-autofocus onClick={() => close(true)}>
              {pending.confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return fn;
}

// ---------- Toasts ----------

interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}
type ToastFn = (kind: Toast['kind'], text: string) => void;
const ToastContext = createContext<ToastFn | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback<ToastFn>((kind, text) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const fn = useContext(ToastContext);
  if (!fn) throw new Error('useToast must be used inside <ToastProvider>');
  return fn;
}
