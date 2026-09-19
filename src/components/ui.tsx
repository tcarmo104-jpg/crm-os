'use client';

import { useFormStatus } from 'react-dom';
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
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
