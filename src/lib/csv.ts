/**
 * Lector CSV (RFC 4180) para importar leads. Maneja BOM, comillas, saltos de línea dentro de
 * campos, CRLF y detecta el separador (coma, punto y coma o tabulador): en Latinoamérica Excel
 * suele exportar con punto y coma.
 */
export interface ParsedCsv { headers: string[]; rows: string[][]; delimiter: string }

export const MAX_CSV_ROWS = 5000;

export function detectDelimiter(firstLine: string): string {
  const candidates = [',', ';', '\t'];
  let best = ',';
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let inQuotes = false;
    for (const ch of firstLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => {
    endField();
    if (record.some((f) => f.trim() !== '')) records.push(record);   // ignora líneas vacías
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n') {
      endRecord();
    } else if (ch === '\r') {
      if (text.charAt(i + 1) === '\n') i++;
      endRecord();
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) endRecord();

  const [headers = [], ...rows] = records;
  return { headers: headers.map((h) => h.trim()), rows, delimiter };
}

// ---------------------------------------------------------------------------
// Mapeo de columnas
// ---------------------------------------------------------------------------
export type CoreField =
  | 'name' | 'lastName' | 'email' | 'phone' | 'whatsapp' | 'instagram' | 'facebook' | 'city' | 'country'
  | 'source' | 'channel' | 'campaign' | 'productInterest' | 'notes' | 'externalId';

const ALIASES: Record<CoreField, string[]> = {
  name: ['nombre', 'nombres', 'name', 'fullname', 'nombrecompleto', 'cliente', 'contacto', 'firstname'],
  lastName: ['apellido', 'apellidos', 'lastname', 'surname'],
  email: ['email', 'correo', 'correoelectronico', 'mail', 'emailaddress'],
  phone: ['telefono', 'celular', 'movil', 'phone', 'tel', 'telefonocelular', 'phonenumber', 'numero'],
  whatsapp: ['whatsapp', 'wa'],
  instagram: ['instagram', 'ig', 'usuarioinstagram'],
  facebook: ['facebook', 'fb'],
  city: ['ciudad', 'city', 'municipio'],
  country: ['pais', 'country'],
  source: ['fuente', 'source', 'origen'],
  channel: ['canal', 'channel'],
  campaign: ['campana', 'campaign', 'campanha'],
  productInterest: ['producto', 'productointeres', 'interes', 'product', 'productinterest', 'servicio'],
  notes: ['notas', 'comentarios', 'observaciones', 'notes', 'comments', 'mensaje'],
  externalId: ['idexterno', 'externalid', 'id'],
};

/** "Correo electrónico" → "correoelectronico" */
export function normalizeHeader(h: string): string {
  return h.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ColumnMapping {
  core: Partial<Record<CoreField, number>>;
  custom: { key: string; index: number }[];
  ignored: string[];
}

export function mapColumns(headers: string[], customFields: { key: string; label: string }[] = []): ColumnMapping {
  const core: Partial<Record<CoreField, number>> = {};
  const custom: { key: string; index: number }[] = [];
  const ignored: string[] = [];
  const byNorm = new Map<string, string>();
  for (const f of customFields) {
    byNorm.set(normalizeHeader(f.key), f.key);
    byNorm.set(normalizeHeader(f.label), f.key);
  }

  headers.forEach((h, index) => {
    const n = normalizeHeader(h);
    if (!n) return;
    const coreField = (Object.keys(ALIASES) as CoreField[]).find((f) => ALIASES[f].includes(n));
    if (coreField && core[coreField] === undefined) { core[coreField] = index; return; }
    const customKey = byNorm.get(n);
    if (customKey) { custom.push({ key: customKey, index }); return; }
    ignored.push(h);
  });
  return { core, custom, ignored };
}

/** Convierte el texto de una celda al tipo del campo personalizado. La BD valida el resultado. */
export function coerceCustomValue(raw: string, type: string): string | number | boolean | string[] | null {
  const v = raw.trim();
  if (v === '') return null;
  switch (type) {
    case 'number':
    case 'currency': {
      const normalized = v.includes('.') ? v.replace(/,/g, '') : v.replace(',', '.');
      const n = Number(normalized.replace(/[^\d.\-]/g, ''));
      return Number.isFinite(n) && /\d/.test(v) ? n : v;
    }
    case 'boolean': {
      const l = v.toLowerCase();
      if (['si', 'sí', 'yes', 'true', '1', 'verdadero'].includes(l)) return true;
      if (['no', 'false', '0', 'falso'].includes(l)) return false;
      return v;
    }
    case 'multi_select':
      return v.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
    default:
      return v;
  }
}

/**
 * Decodifica el archivo subido. Excel en Windows suele guardar CSV en Windows-1252 (no UTF-8):
 * si el archivo no es UTF-8 válido se lee como Windows-1252 para no romper acentos y eñes.
 * Devuelve null si parece un archivo binario (p. ej. .xlsx, que es un ZIP).
 */
export function decodeCsvBuffer(buf: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return null;          // "PK": ZIP/.xlsx
  if (bytes.subarray(0, 4096).includes(0)) return null;                                  // byte nulo: binario
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
