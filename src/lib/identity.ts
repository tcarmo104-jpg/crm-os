import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/**
 * Normalización de identificadores. Debe producir EXACTAMENTE el formato que exige la base de datos
 * (E.164, emails en minúsculas, handles en minúsculas y sin @); la BD lo verifica con restricciones CHECK.
 */

export type IdentifierType = 'phone' | 'email' | 'instagram' | 'facebook' | 'external';
export interface Identifier { type: IdentifierType; value: string }

/** "es-CO" → "CO". Si no se puede deducir, Colombia. */
export function countryFromLocale(locale: string | undefined): CountryCode {
  const region = locale?.split('-')[1]?.toUpperCase();
  return (region && /^[A-Z]{2}$/.test(region) ? region : 'CO') as CountryCode;
}

export function normalizePhone(raw: string, defaultCountry: CountryCode = 'CO'): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Excel suele convertir 3001112233 en 3001112233.0 o notación científica
  let cleaned = /^\d+\.0+$/.test(trimmed) ? trimmed.replace(/\.0+$/, '') : trimmed;
  // "0057 300…" significa "+57 300…". Sin esto, la librería lee 005 como código de operador
  // colombiano y crearía en silencio un número de otro país (+7…).
  cleaned = cleaned.replace(/^\s*00(?=[1-9])/, '+');
  const parsed = parsePhoneNumberFromString(cleaned, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164
}

export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v.length > 254) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

/** "@Carlos.R", "https://instagram.com/carlos.r/" → "carlos.r" */
export function normalizeHandle(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  v = v.replace(/^https?:\/\/(www\.)?(instagram|facebook|fb)\.com\//, '').replace(/[/?#].*$/, '');
  v = v.replace(/^@/, '');
  return /^[a-z0-9._-]{1,100}$/.test(v) ? v : null;
}

/** Espejo de app.normalize_name (SQL): compara sin acentos, mayúsculas ni símbolos. */
const FROM = 'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ';
const TO = 'aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc';
export function nameKey(name: string): string {
  let out = '';
  for (const ch of name.normalize('NFC')) {
    const i = FROM.indexOf(ch);
    out += i >= 0 ? TO.charAt(i) : ch;
  }
  return out.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export interface ContactInput {
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  instagram?: string | null;
  facebook?: string | null;
}

export interface BuiltIdentifiers { identifiers: Identifier[]; problems: string[] }

/** Convierte los datos de contacto crudos en identificadores normalizados y sin repetir. */
export function buildIdentifiers(input: ContactInput, country: CountryCode): BuiltIdentifiers {
  const found = new Map<string, Identifier>();
  const problems: string[] = [];
  const add = (type: IdentifierType, value: string | null) => {
    if (value) found.set(`${type}|${value}`, { type, value });
  };

  for (const [label, raw] of [['Teléfono', input.phone], ['WhatsApp', input.whatsapp]] as const) {
    if (raw && raw.trim()) {
      const n = normalizePhone(raw, country);
      if (n) add('phone', n);
      else problems.push(`${label} no válido: «${raw.trim().slice(0, 40)}»`);
    }
  }
  if (input.email && input.email.trim()) {
    const n = normalizeEmail(input.email);
    if (n) add('email', n);
    else problems.push(`Correo no válido: «${input.email.trim().slice(0, 60)}»`);
  }
  for (const [type, label, raw] of [['instagram', 'Instagram', input.instagram], ['facebook', 'Facebook', input.facebook]] as const) {
    if (raw && raw.trim()) {
      const n = normalizeHandle(raw);
      if (n) add(type, n);
      else problems.push(`${label} no válido: «${raw.trim().slice(0, 60)}»`);
    }
  }
  return { identifiers: [...found.values()], problems };
}
