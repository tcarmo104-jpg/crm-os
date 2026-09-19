import type { Metadata } from 'next';
import Link from 'next/link';
import { getSession, can } from '@/lib/session';
import { NewCustomerForm } from '@/components/customer-forms';

export const metadata: Metadata = { title: 'Nuevo cliente' };

export default async function NewCustomerPage() {
  const session = (await getSession())!;
  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/customers">← Clientes</Link></p>
        <h1>Nuevo cliente</h1>
        <p className="muted">Si el contacto ya existe, no se crea uno duplicado.</p>
      </header>
      <section className="panel">
        {can(session, 'customers:create') ? <NewCustomerForm /> : <p className="muted">Tu rol no puede crear clientes.</p>}
      </section>
    </>
  );
}
