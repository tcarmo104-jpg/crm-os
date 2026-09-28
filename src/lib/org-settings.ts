/** Opciones para Configuración general: unas pocas zonas horarias e idiomas comunes en la región,
 * más un par de referencias internacionales. No es exhaustivo a propósito: una lista más corta es
 * más fácil de usar que las ~400 zonas horarias de la IANA. */
export const TIMEZONE_OPTIONS = [
  'America/Bogota', 'America/Mexico_City', 'America/Lima', 'America/Santiago', 'America/Argentina/Buenos_Aires',
  'America/Caracas', 'America/Guayaquil', 'America/La_Paz', 'America/Montevideo', 'America/New_York', 'America/Los_Angeles', 'Europe/Madrid',
] as const;
export const LOCALE_OPTIONS = [
  { value: 'es-CO', label: 'Español (Colombia)' }, { value: 'es-MX', label: 'Español (México)' }, { value: 'es-AR', label: 'Español (Argentina)' },
  { value: 'es-CL', label: 'Español (Chile)' }, { value: 'es-PE', label: 'Español (Perú)' }, { value: 'es-ES', label: 'Español (España)' }, { value: 'en-US', label: 'English (US)' },
] as const;
