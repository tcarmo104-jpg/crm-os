'use client';

import { useEffect, useRef, useState } from 'react';

export type DialogState = { kind: 'reason' | 'won'; cardId: string; customer: string; title: string; stageName: string } | null;

/** Confirmación al soltar en «Perdida» (pide el motivo) o en «Ganada» (pide confirmar). */
export function MoveDialog({ state, onCancel, onConfirm }: { state: DialogState; onCancel: () => void; onConfirm: (reason?: string) => void }) {
  const [reason, setReason] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setReason(''); if (state?.kind === 'reason') setTimeout(() => area.current?.focus(), 30); }, [state]);
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state, onCancel]);
  if (!state) return null;
  const lost = state.kind === 'reason';
  const ok = !lost || reason.trim().length >= 3;

  return (
    <div className="kb-modal-wrap" role="presentation">
      <div className="kb-scrim" onClick={onCancel} aria-hidden="true" />
      <div className="kb-modal" role="dialog" aria-modal="true" aria-labelledby="kb-modal-title">
        <h2 id="kb-modal-title">{lost ? 'Marcar como perdida' : 'Marcar como ganada'}</h2>
        <p className="kb-muted"><strong>{state.customer}</strong> · {state.title}</p>
        {lost ? (
          <>
            <label htmlFor="kb-reason" className="kb-label">¿Por qué se perdió?</label>
            <textarea id="kb-reason" ref={area} className="kb-input" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: Compró con la competencia por precio" />
            <p className="kb-hint">Es obligatorio (mínimo 3 letras): sirve para entender por qué se pierden ventas.</p>
          </>
        ) : (
          <p>Se moverá a <strong>{state.stageName}</strong>. Si la venta viene de una cotización aceptada, lo habitual es registrarla desde la cotización para que quede el pedido; aquí solo se cierra la oportunidad.</p>
        )}
        <div className="kb-modal-actions">
          <button type="button" className="kb-btn kb-btn--ghost" onClick={onCancel}>Cancelar</button>
          <button type="button" className={`kb-btn ${lost ? 'kb-btn--danger' : 'kb-btn--primary'}`} disabled={!ok} onClick={() => onConfirm(lost ? reason.trim() : undefined)}>
            {lost ? 'Marcar como perdida' : 'Marcar como ganada'}
          </button>
        </div>
      </div>
    </div>
  );
}
