/** Error de base de datos con el código SQLSTATE de Postgres. */
export class DbError extends Error {
  readonly code?: string;
  constructor(e: { message: string; code?: string }) {
    super(e.message);
    this.name = 'DbError';
    this.code = e.code;
  }
}

export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

interface Res<T> { data: T | null; error: { message: string; code?: string } | null }

export function unwrap<T>(res: Res<T>): T {
  if (res.error) throw new DbError(res.error);
  return res.data as T;
}

const DEFAULT_MESSAGE = 'No pudimos completar la acción. Inténtalo de nuevo en unos segundos.';

/**
 * Traduce errores técnicos a mensajes claros para la persona usuaria.
 * Nunca expone detalles internos (SQL, nombres de tablas, stack).
 */
export function toUserMessage(err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  if (!(err instanceof DbError)) return DEFAULT_MESSAGE;

  const msg = err.message.toLowerCase();

  // Invitaciones
  if (msg.includes('invitation_not_found')) return 'Esta invitación no existe. Revisa que el enlace esté completo.';
  if (msg.includes('invitation_accepted')) return 'Esta invitación ya fue utilizada.';
  if (msg.includes('invitation_revoked')) return 'Esta invitación fue cancelada. Pide una nueva a tu administrador.';
  if (msg.includes('invitation_expired')) return 'Esta invitación venció. Pide una nueva a tu administrador.';
  if (msg.includes('email_not_verified')) return 'Verifica tu correo desde el mensaje que te enviamos y vuelve a abrir este enlace.';
  if (msg.includes('email_mismatch')) return 'Esta invitación es para otro correo. Inicia sesión con el correo al que fue enviada.';
  if (msg.includes('membership_exists')) return 'Tu acceso a esta organización está suspendido. Contacta a un administrador.';
  if (msg.includes('cannot invite as super_admin')) return 'No se puede invitar a alguien como super administrador. Invítalo como administrador y luego promuévelo.';
  if (msg.includes('already a member')) return 'Esa persona ya es miembro de la organización.';

  // Propiedad de la organización
  if (msg.includes('at least one active super_admin')) return 'La organización debe conservar al menos un super administrador.';
  if (msg.includes('only a super_admin can')) return 'Solo un super administrador puede cambiar ese rol.';

  // Clientes, identidad y captura
  if (msg.includes('contact_required')) return 'Falta un dato de contacto: teléfono, correo o usuario de red social.';
  if (msg.includes('name_required')) return 'Escribe el nombre.';
  if (msg.includes('custom_field')) return 'Uno de los campos personalizados tiene un valor no válido.';
  if (msg.includes('only managers can reassign')) return 'Solo un manager o administrador puede reasignar clientes.';
  if (msg.includes('only managers can clear do-not-contact')) return 'Solo un manager o administrador puede quitar la marca «no contactar».';
  if (msg.includes('only managers can merge')) return 'Solo un manager o administrador puede fusionar clientes.';
  if (msg.includes('owner must be an active member')) return 'La persona asignada debe ser miembro activo de la organización.';
  if (msg.includes('company_id must')) return 'La empresa seleccionada no es válida.';
  if (msg.includes('cannot merge a person with a company')) return 'No se puede fusionar una persona con una empresa.';
  if (msg.includes('customer not found')) return 'Ese cliente ya no existe o ya fue fusionado.';
  if (msg.includes('api key limit')) return 'Alcanzaste el límite de 20 llaves activas. Revoca alguna para crear otra.';
  if (msg.includes('too many rows')) return 'El lote tiene demasiadas filas. Divide el archivo.';

  // Pipelines, oportunidades, tareas y leads
  if (msg.includes('reason_required')) return 'Escribe un motivo (al menos 3 letras).';
  if (msg.includes('invalid_transition')) return 'Ese cambio de estado no está permitido desde el estado actual.';
  if (msg.includes('convert_requires_opportunity') || msg.includes('use convert_lead')) return 'Para convertir un lead usa «Convertir en oportunidad».';
  if (msg.includes('lead_not_convertible')) return 'Este lead ya fue convertido o está descartado.';
  if (msg.includes('only managers can change a closed opportunity')) return 'Una oportunidad cerrada solo la puede modificar o reabrir un manager o administrador.';
  if (msg.includes('invalid_stage')) return 'Esa etapa no existe, está archivada o es de otro pipeline.';
  if (msg.includes('a new opportunity must start')) return 'Una oportunidad nueva debe empezar en una etapa abierta.';
  if (msg.includes('stage_in_use')) return 'Hay oportunidades abiertas en esa etapa: muévelas antes de archivarla.';
  if (msg.includes('pipeline_in_use')) return 'Hay oportunidades abiertas en ese pipeline: ciérralas o muévelas antes de archivarlo.';
  if (msg.includes('default_pipeline')) return 'Elige otro pipeline como predeterminado antes de archivar este.';
  if (msg.includes('last_stage_of_kind')) return 'Cada pipeline necesita al menos una etapa abierta, una ganada y una perdida.';
  if (msg.includes('pipeline limit')) return 'Alcanzaste el máximo de 10 pipelines activos.';
  if (msg.includes('stage limit')) return 'Alcanzaste el máximo de 25 etapas por pipeline.';
  if (msg.includes('task_closed')) return 'Esa tarea ya está cerrada. Reábrela para editarla.';
  if (msg.includes('task_not_open')) return 'Esa tarea ya no está abierta.';
  if (msg.includes('task_not_closed')) return 'Esa tarea ya está abierta.';
  if (msg.includes('only managers can reassign tasks') || msg.includes('only managers can assign tasks')) return 'No puedes asignar tareas a esa persona.';
  if (msg.includes('assignee must be an active member')) return 'La persona asignada debe ser miembro activo de la organización.';
  if (msg.includes('due date out of range') || msg.includes('date out of range')) return 'La fecha está fuera del rango permitido.';
  if (msg.includes('opportunity belongs to another customer')) return 'Esa oportunidad pertenece a otro cliente.';

  switch (err.code) {
    case '42501':
      return 'No tienes permiso para hacer esto.';
    case '23505':
      if (msg.includes('slug')) return 'Ese identificador ya está en uso. Prueba con otro.';
      if (msg.includes('teams')) return 'Ya existe un equipo con ese nombre.';
      return 'Ya existe un registro con esos datos.';
    case '23514':
      if (msg.includes('reserved')) return 'Ese identificador está reservado. Elige otro.';
      return 'Revisa el formato de los datos ingresados.';
    case '23503':
      return 'El equipo seleccionado no pertenece a esta organización.';
    case '22023':
      return 'El rol seleccionado no existe.';
    case '53400':
      return 'Alcanzaste el límite de organizaciones para tu cuenta.';
    case '28000':
      return 'Tu sesión venció. Inicia sesión de nuevo.';
    default:
      return DEFAULT_MESSAGE;
  }
}
