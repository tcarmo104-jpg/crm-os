import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { listFieldDefinitions } from '@/repositories/custom-fields';
import { ImportForm } from '@/components/import-form';

export const metadata: Metadata = { title: 'Importar leads' };

export default async function ImportPage() {
  const session = (await getSession())!;
  const fields = (await listFieldDefinitions(await createClient(), session.active!.orgId, 'lead')).filter((f) => !f.archivedAt);
  const allowed = can(session, 'leads:create');

  return (
    <>
      <header className="page-head">
        <p className="small"><Link href="/leads">← Leads</Link></p>
        <h1>Importar desde CSV</h1>
        <p className="muted">
          Cada fila se compara con tus clientes por teléfono, correo o usuario. Quien ya existe no se duplica; los posibles
          duplicados por nombre quedan en revisión y nunca se fusionan solos.
        </p>
      </header>

      <section className="panel">
        {allowed ? <ImportForm canAssign={session.permissions['customers:read'] === 'org'} /> : <p className="muted">Tu rol no puede importar leads.</p>}
      </section>

      <section className="panel" aria-labelledby="fmt-title">
        <div className="panel-head"><h2 id="fmt-title">Formato del archivo</h2></div>
        <p>
          La primera fila son los encabezados. Reconocemos estos nombres (con o sin acentos, en español o inglés):
        </p>
        <ul>
          <li><strong>Contacto</strong> (necesitas al menos uno): teléfono, whatsapp, correo, instagram, facebook.</li>
          <li><strong>Datos</strong>: nombre, apellido, ciudad, país, fuente, canal, campaña, producto, notas, id externo.</li>
          {fields.length > 0 ? <li><strong>Tus campos personalizados de leads</strong>: {fields.map((f) => f.label).join(', ')}.</li> : null}
        </ul>
        <pre className="code-block">{'nombre;apellido;telefono;correo;ciudad;campaña\nAna;Ruiz;300 111 2233;ana@correo.com;Cali;Verano'}</pre>
        <p className="hint">
          Máximo 5.000 filas y 2 MB por archivo. Los teléfonos se interpretan según el país de la organización si no traen indicativo.
          Funciona con comas, punto y coma o tabuladores.
        </p>
      </section>
    </>
  );
}
