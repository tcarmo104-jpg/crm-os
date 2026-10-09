/** Catálogo de campos del widget (Entrega 1 del refactor): tipos, sugerencias estándar, y la plantilla de
 * mensaje con variables. Lógica pura — sin acceso a datos. */

/** Nombres de los tipos de campo del widget para la interfaz. Son su propio catálogo (no el de
 * Clientes/Leads/Oportunidades en `lib/custom-fields.ts`): un formulario de captación no necesita, por
 * ejemplo, "Sí/No" ni "Moneda", y si en el futuro sí los necesita, se agregan aquí sin tocar el otro. */
export const WIDGET_FIELD_TYPE_LABELS = {
  text: 'Texto corto', phone: 'Teléfono', email: 'Correo', number: 'Número', select: 'Lista (una opción)',
  textarea: 'Párrafo', date: 'Fecha',
} as const;
export type WidgetFieldType = keyof typeof WIDGET_FIELD_TYPE_LABELS;
export const WIDGET_FIELD_TYPES = Object.keys(WIDGET_FIELD_TYPE_LABELS) as WidgetFieldType[];

/** Los campos que menciona la plantilla del widget (punto 6 del pedido), listos para que el administrador
 * los agregue con un clic — no están codificados en el formulario en sí: solo prellenan el "Nuevo campo". */
export const STANDARD_FIELD_SUGGESTIONS: { label: string; type: WidgetFieldType }[] = [
  { label: 'Nombre', type: 'text' },
  { label: 'Apellido', type: 'text' },
  { label: 'Teléfono', type: 'phone' },
  { label: 'Email', type: 'email' },
  { label: 'Empresa', type: 'text' },
  { label: 'Ciudad', type: 'text' },
  { label: 'Región', type: 'text' },
  { label: 'Producto', type: 'text' },
  { label: 'Categoría', type: 'text' },
  { label: 'Cantidad', type: 'number' },
  { label: 'Presupuesto', type: 'text' },
  { label: 'Mensaje', type: 'textarea' },
  { label: 'Fecha preferida', type: 'date' },
  { label: 'Tipo de cliente', type: 'select' },
];

/** Variables disponibles en una plantilla de mensaje (punto 11 del pedido). */
export const MESSAGE_TEMPLATE_VARIABLES = ['nombre', 'telefono', 'empresa', 'ciudad', 'producto', 'cantidad', 'mensaje', 'origen'] as const;

/** Sustituye `{{variable}}` por su valor. Una variable sin valor se quita (no deja «{{vacío}}» ni "undefined"
 * en el mensaje que de verdad se manda a WhatsApp), y los espacios/líneas que quedan vacíos se recortan. */
export function renderMessageTemplate(template: string, values: Partial<Record<string, string>>): string {
  const filled = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, key: string) => (values[key.toLowerCase()] ?? '').trim());
  return filled.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Una pregunta del formulario del widget, tal como la entrega `get_widget_config` (0038/0039): tanto una del
 * formulario base como una propia de una intención tienen esta misma forma. */
export interface WidgetConfigField {
  fieldId: string; key: string; type: WidgetFieldType; label: string; placeholder: string | null;
  options: string[]; required: boolean; defaultValue: string | null;
}

/** Arquitectura del formulario (Entrega 4): el formulario BASE siempre se pregunta — tenga o no el widget un
 * menú de intenciones. Si además el visitante elige una intención, sus preguntas propias se SUMAN a las del
 * formulario base; nunca las reemplazan. Si una intención repite la misma clave que el formulario base (p. ej.
 * para pedirla con otra etiqueta u obligatoriedad distinta ahí), la de la intención manda para esa clave. */
export function mergeWidgetFields(base: WidgetConfigField[], extra: WidgetConfigField[]): WidgetConfigField[] {
  const out = base.slice();
  for (const f of extra) {
    const i = out.findIndex((b) => b.key === f.key);
    if (i === -1) out.push(f); else out[i] = f;
  }
  return out;
}
