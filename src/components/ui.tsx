'use client';

import { useFormStatus } from 'react-dom';
import { createContext, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon } from './Icon';

export function SubmitButton({
  children, pendingLabel, className = 'btn btn-primary', ...rest
}: { children: ReactNode; pendingLabel?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || rest.disabled} aria-busy={pending} {...rest}>
      {pending ? (pendingLabel ?? 'Guardando…') : children}
    </button>
  );
}

export function Notice({ kind, children }: { kind: 'error' | 'ok'; children: ReactNode }) {
  return (
    <p className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export function ConfirmButton({
  message, children, className = 'btn btn-danger btn-sm', ...rest
}: { message: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <label className="label" htmlFor="copy-input">{label}</label>
      <div className="copy-row">
        <input id="copy-input" className="input" readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              /* el campo es seleccionable: se puede copiar a mano */
            }
          }}
        >
          <Icon name="copy" size={16} />
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

const ModalCloseContext = createContext<(() => void) | null>(null);

/**
 * Modal compacto y accesible (nativo `<dialog>`: Esc y clic afuera cierran solos, y bloquea el fondo).
 * `trigger` es lo que abre el modal (un botón, normalmente); los hijos son el contenido.
 */
export function Modal({ trigger, title, children, wide = false }: { trigger: ReactNode; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = () => ref.current?.close();
  return (
    <>
      <span onClick={() => ref.current?.showModal()}>{trigger}</span>
      <dialog ref={ref} className={`modal${wide ? ' modal--wide' : ''}`} aria-labelledby="modal-title" onClick={(e) => { if (e.target === ref.current) close(); }}>
        <div className="modal-head">
          <h2 id="modal-title">{title}</h2>
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={close}><Icon name="x" size={16} /></button>
        </div>
        {/* El contexto, no el foco del navegador, es lo que le dice al formulario de adentro cómo cerrar este modal (el foco no es confiable mientras se envía). */}
        <div className="modal-body"><ModalCloseContext.Provider value={close}>{children}</ModalCloseContext.Provider></div>
      </dialog>
    </>
  );
}

function useCloseOnSuccessInternal(ok: boolean | undefined) {
  const close = useContext(ModalCloseContext);
  const seen = useRef(false);
  useEffect(() => {
    if (ok && !seen.current) { seen.current = true; close?.(); }
    if (!ok) seen.current = false;
  }, [ok, close]);
}

/**
 * Cierra el <Modal> que lo contiene cuando la acción del formulario terminó bien. IMPORTANTE: colócalo DENTRO del
 * formulario (como cualquier otro elemento hijo), nunca en el componente que arma el <Modal> — el contexto del
 * modal solo llega a lo que se renderiza como su hijo, no al componente que lo construye.
 */
export function CloseOnSuccess({ ok }: { ok: boolean | undefined }) {
  useCloseOnSuccessInternal(ok);
  return null;
}
