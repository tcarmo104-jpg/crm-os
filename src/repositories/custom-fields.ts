import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { FieldDefinition, FieldEntity, FieldType } from '@/lib/types';

interface Raw { id: string; entity: FieldEntity; key: string; label: string; type: FieldType; options: string[]; position: number; archived_at: string | null }
const map = (r: Raw): FieldDefinition => ({
  id: r.id, entity: r.entity, key: r.key, label: r.label, type: r.type, options: r.options ?? [], position: r.position, archivedAt: r.archived_at,
});

export async function listFieldDefinitions(db: ServerSupabase, orgId: string, entity?: FieldEntity): Promise<FieldDefinition[]> {
  let q = db.from('custom_field_definitions').select('id, entity, key, label, type, options, position, archived_at').eq('org_id', orgId);
  if (entity) q = q.eq('entity', entity);
  return (unwrap(await q.order('entity').order('position').order('created_at')) as unknown as Raw[]).map(map);
}

export async function createFieldDefinition(
  db: ServerSupabase,
  orgId: string, d: { entity: FieldEntity; key: string; label: string; type: FieldType; options: string[] },
) {
  unwrap(await db.from('custom_field_definitions').insert({ org_id: orgId, ...d }).select('id').single());
}

export async function setFieldArchived(db: ServerSupabase, id: string, archived: boolean) {
  unwrap(
    await db.from('custom_field_definitions').update({ archived_at: archived ? new Date().toISOString() : null }).eq('id', id).select('id').single(),
  );
}
