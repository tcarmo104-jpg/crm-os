import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { listSequences } from '@/repositories/sequences';
import { Notice } from '@/components/ui';
import { NewSequenceModal } from '@/components/sequences/SequenceModals';

export const metadata: Metadata = { title: 'Secuencias' };

export default async function SequencesPage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();
  if (!can(session, 'sequences:read')) return <><header className="page-head"><h1>Secuencias</h1></header><Notice kind="error">No tienes acceso a este módulo.</Notice></>;

  const showArchived = sp.estado === 'archivadas';
  const [all, flash] = await Promise.all([listSequences(db, org.orgId), readFlash()]);
  const items = all.filter((s) => s.isActive !== showArchived);
  const canManage = can(session, 'sequences:manage');

  return (
    <>
      <header className="page-head">
        <h1>Secuencias</h1>
        <p className="muted">Una secuencia es una plantilla de seguimiento: al inscribir a un cliente, se crea la tarea del primer paso; los siguientes se crean solos, a medida que completas cada uno.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      <div className="flt-bar">
        <div className="view-toggle" role="tablist" aria-label="Estado">
          <Link href="/sequences" aria-current={!showArchived ? 'page' : undefined}>Activas</Link>
          <Link href="/sequences?estado=archivadas" aria-current={showArchived ? 'page' : undefined}>Archivadas</Link>
        </div>
        {canManage ? <NewSequenceModal trigger={<button type="button" className="btn btn-primary" style={{ marginLeft: 'auto' }}>+ Nueva secuencia</button>} /> : null}
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          <strong>{showArchived ? 'No hay secuencias archivadas.' : 'Aún no hay secuencias.'}</strong>
          <p>{showArchived ? '' : canManage ? 'Crea la primera con «+ Nueva secuencia».' : 'Quien administra las secuencias todavía no ha creado ninguna.'}</p>
        </div>
      ) : (
        <div className="stack">
          {items.map((s) => (
            <Link key={s.id} href={`/sequences/${s.id}`} className="sequence-card" style={{ textDecoration: 'none', color: 'inherit' }}>
              <strong>{s.name}</strong>
              {s.description ? <p className="muted small">{s.description}</p> : null}
              <span className="hint">{s.steps.length} {s.steps.length === 1 ? 'paso' : 'pasos'}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
