import Link from 'next/link';

export default function SaleNotFound() {
  return (
    <section className="panel">
      <h1>No encontramos esta venta</h1>
      <p className="muted">Puede que el enlace esté incompleto o que no esté asignada a ti.</p>
      <p><Link className="btn btn-secondary" href="/sales">Volver a Ventas</Link></p>
    </section>
  );
}
