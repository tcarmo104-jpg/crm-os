import Link from 'next/link';

export default function ConversationNotFound() {
  return (
    <section className="panel">
      <h1>No encontramos esta conversación</h1>
      <p className="muted">Puede que el enlace esté incompleto o que pertenezca a un cliente que no tienes asignado.</p>
      <p><Link className="btn btn-secondary" href="/inbox">Volver al Inbox</Link></p>
    </section>
  );
}
