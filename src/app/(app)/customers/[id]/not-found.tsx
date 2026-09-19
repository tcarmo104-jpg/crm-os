import Link from 'next/link';

export default function CustomerNotFound() {
  return (
    <section className="panel">
      <h1>No encontramos este cliente</h1>
      <p className="muted">
        Puede que el enlace esté incompleto, que el cliente haya sido fusionado con otro, o que no esté asignado a ti.
      </p>
      <p><Link className="btn btn-secondary" href="/customers">Volver a Clientes</Link></p>
    </section>
  );
}
