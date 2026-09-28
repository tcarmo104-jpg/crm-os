'use client';

import { useActionState, useState } from 'react';
import { initialActionState, type ActionState } from '@/lib/action-state';
import { ACTION_LABEL, CRUD_ACTIONS, CRUD_MODULES, isValidRoleKey, MODULE_LABEL, PERMISSION_SCOPES, SCOPE_LABEL, slugifyRoleKey, SPECIAL_PERMISSIONS, SPECIAL_PERMISSION_LABEL, type PermissionScope, type RolePermission } from '@/lib/roles';
import { Feedback, Field } from './forms';
import { SubmitButton } from './ui';

/** Una fila de la cuadrícula: un permiso, un desplegable con su alcance, y la clave técnica oculta al lado
 * (así `fd.getAll('permKey')` y `fd.getAll('permScope')` quedan pareados en el mismo orden). Sin estado de
 * React: es un `<select>` normal, funciona igual con o sin JavaScript. */
function PermissionCell({ permKey, defaultScope }: { permKey: string; defaultScope: PermissionScope | 'none' }) {
  return (
    <span className="perm-cell">
      <input type="hidden" name="permKey" value={permKey} />
      <select aria-label={`Alcance de ${permKey}`} name="permScope" className="select select-sm" defaultValue={defaultScope}>
        <option value="none">Sin acceso</option>
        {PERMISSION_SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
      </select>
    </span>
  );
}

/** Formulario de rol: nombre (+ clave técnica al crear) y una cuadrícula de permisos. Se usa tanto para
 * crear como para editar un rol propio; los roles de sistema nunca pasan por aquí. */
export function RoleForm({
  mode, roleId, initial, action,
}: {
  mode: 'create' | 'edit'; roleId?: string;
  initial?: { key: string; name: string; description: string | null; permissions: RolePermission[] };
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [name, setName] = useState(initial?.name ?? '');
  const [key, setKey] = useState(initial?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(mode === 'edit');
  const scopeOf = (permKey: string): PermissionScope | 'none' => initial?.permissions.find((p) => p.key === permKey)?.scope ?? 'none';

  return (
    <form action={formAction} className="stack" noValidate>
      <Feedback state={state} />
      {roleId ? <input type="hidden" name="roleId" value={roleId} /> : null}
      <div className="grid-2">
        <Field
          label="Nombre del rol" name="name" maxLength={80} value={name}
          onChange={(v) => { setName(v); if (!keyTouched) setKey(slugifyRoleKey(v)); }}
          placeholder="Vendedor junior"
        />
        {mode === 'create' ? (
          <Field
            label="Clave técnica" name="key" maxLength={40} value={key}
            onChange={(v) => { setKey(v); setKeyTouched(true); }}
            hint="Solo minúsculas y guion bajo. No se puede cambiar después." placeholder="vendedor_junior"
          />
        ) : null}
      </div>
      {mode === 'create' && key && !isValidRoleKey(key) ? <p className="notice notice-error">La clave debe tener solo minúsculas y guion bajo, sin espacios ni tildes.</p> : null}
      <div className="field">
        <label className="label" htmlFor="rf-desc">Descripción (opcional)</label>
        <textarea id="rf-desc" name="description" className="input" rows={2} maxLength={300} defaultValue={initial?.description ?? ''} placeholder="Para qué sirve este rol" />
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <span className="label">Permisos por módulo</span>
        <div className="table-wrap">
          <table className="table perm-table">
            <thead><tr><th scope="col">Módulo</th>{CRUD_ACTIONS.map((a) => <th key={a} scope="col">{ACTION_LABEL[a]}</th>)}</tr></thead>
            <tbody>
              {CRUD_MODULES.map((m) => (
                <tr key={m}>
                  <td>{MODULE_LABEL[m]}</td>
                  {CRUD_ACTIONS.map((a) => { const permKey = `${m}:${a}`; return <td key={a}><PermissionCell permKey={permKey} defaultScope={scopeOf(permKey)} /></td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <span className="label">Permisos de configuración</span>
        <ul className="perm-special-list">
          {SPECIAL_PERMISSIONS.map((p) => (
            <li key={p} className="perm-special-row">
              <span>{SPECIAL_PERMISSION_LABEL[p]}</span>
              <PermissionCell permKey={p} defaultScope={scopeOf(p)} />
            </li>
          ))}
        </ul>
      </div>

      <SubmitButton pendingLabel="Guardando…">{mode === 'create' ? 'Crear rol' : 'Guardar cambios'}</SubmitButton>
    </form>
  );
}
