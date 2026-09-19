import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { getCustomer, listCustomers } from '@/repositories/customers';
import { listPipelines } from '@/repositories/pipelines';
import { uuidSchema } from '@/services/schemas';
import { NewOpportunityForm } from '@/components/sales-forms';

export const metadata: Metadata = { title: 'Nueva oportunidad' };

export default async function NewOpportunityPage({ searchParams }: { searchParams: Promise<{ customer?: string; q?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const db = await createClient();

  if (!can(session, 'opportunities:create')) {
    return <section className="panel"><h1>Nueva oportunidad</h1><p className="muted">Tu rol no puede crear oportunidades.</p></section>;
  }

  const customer = uuidSchema.safeParse(sp.customer).success ? await getCustomer(db, sp.customer!) : null;
  const pipelines = customer ? await listPipelines(db, org.orgId) : [];
  const q = (sp.q ?? '').slice(0, 80);
  const results = !customer && q ? (await listCustomers(db, { orgId: org.orgId, userId: session.user.id, q, limit: 10 })).items : [];

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/opportunities">← Oportunidades</Link></p>
        <h1>Nueva oportunidad</h1>
        <p className="muted">Toda oportunidad pertenece a un cliente. Nace en la primera etapa abierta del pipeline.</p>
      </header>

      {customer ? (
        <section className="panel">
          {customer.doNotContact ? <p className="muted">Este cliente pidió no ser contactado.</p> : null}
          <NewOpportunityForm customerId={customer.id} customerName={customer.fullName}
            pipelines={pipelines.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault }))} />
        </section>
      ) : (
        <section className="panel" aria-labelledby="pick">
          <div className="panel-head"><h2 id="pick">1. Elige el cliente</h2></div>
          <form method="get" className="inline-form" role="search">
            <label className="sr-only" htmlFor="q">Buscar cliente</label>
            <input id="q" name="q" className="input" defaultValue={q} placeholder="Nombre, teléfono o correo" maxLength={80} autoFocus />
            <button className="btn btn-secondary" type="submit">Buscar</button>
          </form>
          {q && results.length === 0 ? (
            <p className="muted">No encontramos clientes. <Link href="/customers/new">Crear un cliente</Link>.</p>
          ) : (
            <ul className="id-list">
              {results.map((c) => (
                <li key={c.id}><span>{c.fullName}{c.city ? <span className="muted"> · {c.city}</span> : null}</span>
                  <Link className="btn btn-secondary btn-sm" href={`/opportunities/new?customer=${c.id}`}>Elegir</Link></li>
              ))}
            </ul>
          )}
          <p className="hint">También puedes crear una oportunidad desde la ficha de un cliente o convirtiendo un lead.</p>
        </section>
      )}
    </>
  );
}
