import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { can, getSession } from '@/lib/session';
import { readFlash } from '@/lib/flash';
import { formatMoney } from '@/lib/money';
import { listProducts } from '@/repositories/products';
import { Notice } from '@/components/ui';
import { ProductForm } from '@/components/commerce-forms';
import { toggleProductAction, updateProductAction } from './actions';

export const metadata: Metadata = { title: 'Productos y servicios' };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ kind?: string; q?: string }> }) {
  const sp = await searchParams;
  const session = (await getSession())!;
  const org = session.active!;
  const kind = sp.kind === 'product' || sp.kind === 'service' ? sp.kind : undefined;
  const q = (sp.q ?? '').slice(0, 60);
  const [items, flash] = await Promise.all([
    can(session, 'products:read') ? listProducts(await createClient(), { orgId: org.orgId, kind, q }) : Promise.resolve([]),
    readFlash(),
  ]);
  const canManage = can(session, 'products:create');
  const money = (n: number) => formatMoney(n, 'COP', org.orgLocale);
  const tab = (k?: string) => `/products${k ? `?kind=${k}` : ''}`;

  return (
    <>
      <header className="page-head">
        <h1>Productos y servicios</h1>
        <p className="muted">Lo que vendes. Al cotizar se guarda una <strong>copia</strong> del nombre, el precio y el IVA: cambiar el catálogo después no altera cotizaciones ya hechas.</p>
      </header>
      {flash ? <Notice kind={flash.kind}>{flash.message}</Notice> : null}

      {canManage ? (
        <section className="panel" aria-labelledby="new-product">
          <details><summary><h2 id="new-product" style={{ display: 'inline', fontSize: '1rem' }}>Agregar al catálogo</h2></summary><ProductForm /></details>
        </section>
      ) : null}

      <section className="panel" aria-labelledby="list-title">
        <div className="panel-head" style={{ flexWrap: 'wrap', gap: 10 }}>
          <h2 id="list-title">Catálogo ({items.length})</h2>
          <nav className="tabs" aria-label="Filtro">
            <Link href={tab()} aria-current={!kind ? 'page' : undefined}>Todo</Link>
            <Link href={tab('product')} aria-current={kind === 'product' ? 'page' : undefined}>Productos</Link>
            <Link href={tab('service')} aria-current={kind === 'service' ? 'page' : undefined}>Servicios</Link>
          </nav>
        </div>
        <form method="get" className="inline-form" role="search">
          {kind ? <input type="hidden" name="kind" value={kind} /> : null}
          <label className="sr-only" htmlFor="q">Buscar</label>
          <input id="q" name="q" className="input" defaultValue={q} placeholder="Nombre o código" maxLength={60} />
          <button className="btn btn-secondary" type="submit">Buscar</button>
        </form>

        {items.length === 0 ? (
          <div className="empty"><p><strong>{q ? 'No encontramos productos con esa búsqueda.' : 'Aún no hay productos ni servicios.'}</strong></p></div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Nombre</th><th scope="col">Tipo</th><th scope="col" className="num">Precio</th><th scope="col" className="num">IVA</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong> {p.active ? null : <span className="badge">Inactivo</span>}
                      <div className="small muted">{p.sku ? `${p.sku} · ` : ''}{p.unit}{p.description ? ` · ${p.description}` : ''}</div>
                      {canManage ? (
                        <details>
                          <summary className="small">Editar</summary>
                          <form action={updateProductAction} className="stack">
                            <input type="hidden" name="productId" value={p.id} />
                            <label className="sr-only" htmlFor={`n-${p.id}`}>Nombre</label>
                            <input id={`n-${p.id}`} name="name" className="input" defaultValue={p.name} maxLength={160} required />
                            <div className="grid-3">
                              <div><label className="sr-only" htmlFor={`s-${p.id}`}>Código</label><input id={`s-${p.id}`} name="sku" className="input" defaultValue={p.sku ?? ''} placeholder="Código" maxLength={60} /></div>
                              <div><label className="sr-only" htmlFor={`p-${p.id}`}>Precio</label><input id={`p-${p.id}`} name="unitPrice" className="input" defaultValue={String(p.unitPrice)} inputMode="decimal" required /></div>
                              <div><label className="sr-only" htmlFor={`t-${p.id}`}>IVA</label><input id={`t-${p.id}`} name="taxRate" className="input" defaultValue={String(p.taxRate)} inputMode="decimal" /></div>
                            </div>
                            <label className="sr-only" htmlFor={`u-${p.id}`}>Unidad</label>
                            <input id={`u-${p.id}`} name="unit" className="input" defaultValue={p.unit} maxLength={30} />
                            <label className="sr-only" htmlFor={`d-${p.id}`}>Descripción</label>
                            <input id={`d-${p.id}`} name="description" className="input" defaultValue={p.description ?? ''} placeholder="Descripción" maxLength={1000} />
                            <button className="btn btn-secondary btn-sm" type="submit">Guardar cambios</button>
                          </form>
                        </details>
                      ) : null}
                    </td>
                    <td>{p.kind === 'service' ? 'Servicio' : 'Producto'}</td>
                    <td className="num">{money(p.unitPrice)}</td>
                    <td className="num">{p.taxRate}%</td>
                    <td className="cell-actions">
                      {canManage ? (
                        <form action={toggleProductAction}>
                          <input type="hidden" name="productId" value={p.id} /><input type="hidden" name="active" value={p.active ? 'false' : 'true'} />
                          <button className="btn btn-ghost btn-sm" type="submit">{p.active ? 'Desactivar' : 'Activar'}</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
