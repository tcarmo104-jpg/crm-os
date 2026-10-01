/** Catálogo del módulo Comentarios: estados, textos. Lógica pura, sin red ni base de datos. */
export const COMMENT_STATUSES = ['visible', 'hidden', 'deleted'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];
export const STATUS_LABEL: Record<CommentStatus, string> = { visible: 'Visible', hidden: 'Oculto', deleted: 'Eliminado' };

/** ¿Todavía se puede responder en privado? Meta lo permite hasta 7 días después del comentario. */
export function canReplyPrivately(occurredAt: string, now = new Date()): boolean {
  return now.getTime() - new Date(occurredAt).getTime() <= 7 * 24 * 60 * 60 * 1000;
}
