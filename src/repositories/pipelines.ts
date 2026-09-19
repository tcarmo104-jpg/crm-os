import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { PipelineRow, StageKind, StageRow } from '@/lib/types';

interface RawStage { id: string; pipeline_id: string; name: string; kind: StageKind; position: number; probability: number; archived_at: string | null }
const mapStage = (r: RawStage): StageRow => ({
  id: r.id, pipelineId: r.pipeline_id, name: r.name, kind: r.kind, position: r.position, probability: r.probability, archivedAt: r.archived_at,
});

export async function listPipelines(db: ServerSupabase, orgId: string, includeArchived = false): Promise<PipelineRow[]> {
  let pq = db.from('pipelines').select('id, name, is_default, archived_at').eq('org_id', orgId);
  if (!includeArchived) pq = pq.is('archived_at', null);
  const pipes = unwrap(await pq.order('is_default', { ascending: false }).order('name')) as
    { id: string; name: string; is_default: boolean; archived_at: string | null }[];
  if (pipes.length === 0) return [];
  const stages = unwrap(
    await db.from('pipeline_stages').select('id, pipeline_id, name, kind, position, probability, archived_at')
      .in('pipeline_id', pipes.map((p) => p.id)),
  ) as unknown as RawStage[];
  return pipes.map((p) => ({
    id: p.id, name: p.name, isDefault: p.is_default, archivedAt: p.archived_at,
    stages: stages.filter((s) => s.pipeline_id === p.id).map(mapStage),
  }));
}

export async function createPipeline(db: ServerSupabase, orgId: string, name: string): Promise<string> {
  return unwrap(await db.rpc('create_pipeline', { p_org: orgId, p_name: name })) as string;
}
export async function setDefaultPipeline(db: ServerSupabase, id: string) {
  unwrap(await db.rpc('set_default_pipeline', { p_id: id }));
}
export async function archivePipeline(db: ServerSupabase, id: string) {
  unwrap(await db.from('pipelines').update({ archived_at: new Date().toISOString() }).eq('id', id).select('id').single());
}
export async function addStage(
  db: ServerSupabase, orgId: string, pipelineId: string, s: { name: string; kind: StageKind; probability: number },
) {
  unwrap(await db.from('pipeline_stages').insert({ org_id: orgId, pipeline_id: pipelineId, ...s }).select('id').single());
}
export async function updateStage(db: ServerSupabase, id: string, fields: { name?: string; probability?: number; position?: number }) {
  unwrap(await db.from('pipeline_stages').update(fields).eq('id', id).select('id').single());
}
export async function archiveStage(db: ServerSupabase, id: string) {
  unwrap(await db.from('pipeline_stages').update({ archived_at: new Date().toISOString() }).eq('id', id).select('id').single());
}
