import Link from 'next/link';

export default function OpportunityNotFound() {
  return (
    <section className="panel">
      <h1>No encontramos esta oportunidad</h1>
      <p className="muted">Puede que el enlace esté incompleto o que no esté asignada a ti.</p>
      <p><Link className="btn btn-secondary" href="/opportunities">Volver a Oportunidades</Link></p>
    </section>
  );
}
