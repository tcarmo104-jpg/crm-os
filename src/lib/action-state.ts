/** Estado que devuelven las server actions a los formularios. */
export interface ActionState {
  ok: boolean;
  error?: string;
  message?: string;
  /** Datos de una sola vez (p. ej. el enlace de invitación). */
  data?: Record<string, string>;
}
export const initialActionState: ActionState = { ok: false };
