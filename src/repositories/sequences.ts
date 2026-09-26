import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { EnrollmentStatus } from '@/lib/sequences';

export interface SequenceStepRow { id: string; position: number; offsetDays: number; type: string; title: string; description: string | null; priority: string }
export interface SequenceRow { id: string; name: string; description: string | null; isActive: boolean; createdBy: string; createdAt: string; steps: SequenceStepRow[] }
export interface EnrollmentRow {
  id: string; sequenceId: string; customerId: string; opportunityId: string | null; status: EnrollmentStatus;
  currentStep: number; currentTaskId: string | null; assigneeId: string | null; enrolledBy: string; enrolledAt: string; finishedAt: string | null;
}

const mapStep = (r: Record<string, unknown>): SequenceStepRow => ({
  id: r.id as string, position: r.position as number, offsetDays: r.offset_days as number,
  type: r.type as string, title: r.title as string, description: (r.description as string | null) ?? null, priority: r.priority as string,
});
const mapSeq = (r: Record<string, unknown>): SequenceRow => ({
  id: r.id as string, name: r.name as string, description: (r.description as string | null) ?? null, isActive: r.is_active as boolean,
  createdBy: r.created_by as string, createdAt: r.created_at as string,
  steps: ((r.sequence_steps as Record<string, unknown>[]) ?? []).map(mapStep).sort((a, b) => a.position - b.position),
});
const mapEnrollment = (r: Record<string, unknown>): EnrollmentRow => ({
  id: r.id as string, sequenceId: r.sequence_id as string, customerId: r.customer_id as string, opportunityId: (r.opportunity_id as string | null) ?? null,
  status: r.status as EnrollmentStatus, currentStep: r.current_step as number, currentTaskId: (r.current_task_id as string | null) ?? null,
  assigneeId: (r.assignee_id as string | null) ?? null, enrolledBy: r.enrolled_by as string, enrolledAt: r.enrolled_at as string,
  finishedAt: (r.finished_at as string | null) ?? null,
});

/** Plantillas de la organización, con sus pasos ya en orden. */
export async function listSequences(db: ServerSupabase, orgId: string, opts: { activeOnly?: boolean } = {}): Promise<SequenceRow[]> {
  let q = db.from('sequences').select('id, name, description, is_active, created_by, created_at, sequence_steps(id, position, offset_days, type, title, description, priority)').eq('org_id', orgId);
  if (opts.activeOnly) q = q.eq('is_active', true);
  const rows = unwrap(await q.order('created_at', { ascending: false })) as unknown as Record<string, unknown>[];
  return rows.map(mapSeq);
}
export async function getSequence(db: ServerSupabase, id: string): Promise<SequenceRow | null> {
  const rows = unwrap(await db.from('sequences').select('id, name, description, is_active, created_by, created_at, sequence_steps(id, position, offset_days, type, title, description, priority)').eq('id', id).limit(1)) as unknown as Record<string, unknown>[];
  return rows[0] ? mapSeq(rows[0]) : null;
}
export const createSequence = async (db: ServerSupabase, orgId: string, name: string, description: string | undefined, steps: { title: string; type: string; offsetDays: number; priority: string; description?: string }[]) =>
  unwrap(await db.rpc('create_sequence', { p_org: orgId, p_name: name, p_description: description ?? null, p_steps: steps })) as unknown as string;
export const archiveSequence = async (db: ServerSupabase, id: string, active: boolean) => { unwrap(await db.rpc('archive_sequence', { p_id: id, p_active: active })); };

/** Inscripciones de un cliente (para mostrar en su ficha) o de toda la organización (para la lista de una plantilla). */
export async function listEnrollmentsByCustomer(db: ServerSupabase, customerId: string): Promise<EnrollmentRow[]> {
  const rows = unwrap(await db.from('sequence_enrollments').select('*').eq('customer_id', customerId).order('enrolled_at', { ascending: false })) as unknown as Record<string, unknown>[];
  return rows.map(mapEnrollment);
}
export async function listEnrollmentsBySequence(db: ServerSupabase, sequenceId: string, limit = 100): Promise<EnrollmentRow[]> {
  const rows = unwrap(await db.from('sequence_enrollments').select('*').eq('sequence_id', sequenceId).order('enrolled_at', { ascending: false }).limit(limit)) as unknown as Record<string, unknown>[];
  return rows.map(mapEnrollment);
}
export const enrollInSequence = async (db: ServerSupabase, sequenceId: string, customerId: string, opportunityId: string | null, assigneeId: string | null) =>
  unwrap(await db.rpc('enroll_in_sequence', { p_sequence: sequenceId, p_customer: customerId, p_opportunity: opportunityId, p_assignee: assigneeId })) as unknown as string;
export const pauseEnrollment = async (db: ServerSupabase, id: string) => { unwrap(await db.rpc('pause_enrollment', { p_id: id })); };
export const resumeEnrollment = async (db: ServerSupabase, id: string) => { unwrap(await db.rpc('resume_enrollment', { p_id: id })); };
export const cancelEnrollment = async (db: ServerSupabase, id: string) => { unwrap(await db.rpc('cancel_enrollment', { p_id: id })); };
