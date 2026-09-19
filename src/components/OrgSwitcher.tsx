'use client';

import { useRef } from 'react';
import { switchOrg } from '@/app/(app)/actions';

export function OrgSwitcher({ orgs, activeId }: { orgs: { id: string; name: string }[]; activeId: string }) {
  const form = useRef<HTMLFormElement>(null);
  if (orgs.length <= 1) return <span className="org-name">{orgs[0]?.name}</span>;
  return (
    <form action={switchOrg} ref={form}>
      <label className="sr-only" htmlFor="org-select">Organización activa</label>
      <select id="org-select" name="orgId" className="select select-quiet" defaultValue={activeId} onChange={() => form.current?.requestSubmit()}>
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    </form>
  );
}
