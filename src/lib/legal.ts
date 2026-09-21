/**
 * Datos de las páginas legales públicas (política de privacidad y eliminación de datos), que Meta y Google piden para publicar una app.
 * Si defines el correo de contacto, aparece en ambas páginas.
 */
export const LEGAL = {
  product: 'CRM OS',
  updatedAt: '20 de septiembre de 2026',
  /** Correo al que las personas pueden escribir para ejercer sus derechos. Vacío = se indica que deben dirigirse a la empresa que las atiende. */
  contactEmail: '',
  retention: { files: '12 meses' },
} as const;
