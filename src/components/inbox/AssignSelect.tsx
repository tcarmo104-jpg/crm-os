'use client';

export function AssignSelect({
  action, customerId, conversationId, current, options,
}: {
  action: (fd: FormData) => Promise<void>; customerId: string; conversationId: string; current: string | null;
  options: { id: string; name: string }[];
}) {
  return (
    <form action={action} className="ib-assign">
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="conversationId" value={conversationId} />
      <label className="sr-only" htmlFor={`assign-${conversationId}`}>Asesor asignado</label>
      <select id={`assign-${conversationId}`} name="ownerId" className="ib-select" defaultValue={current ?? ''} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        <option value="">Sin asignar</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </form>
  );
}
