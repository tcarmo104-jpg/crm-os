'use client';

/** Lista desplegable que guarda al elegir (sin botón). `fields` = datos ocultos que viajan con el formulario. */
export function AutoSelect({
  action, name, label, value, options, fields, className = 'kb-select',
}: {
  action: (fd: FormData) => Promise<void>; name: string; label: string; value: string; options: { value: string; label: string }[];
  fields: Record<string, string>; className?: string;
}) {
  return (
    <form action={action}>
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <label className="sr-only" htmlFor={`as-${name}-${fields.id}`}>{label}</label>
      <select id={`as-${name}-${fields.id}`} name={name} className={className} defaultValue={value} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </form>
  );
}
