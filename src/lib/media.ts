/**
 * Multimedia del Inbox: lógica PURA (sin red ni base de datos). Reconoce el tipo REAL de un archivo por su contenido,
 * bloquea ejecutables, limpia nombres y aplica las reglas que cada canal (API) permite de verdad.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'file' | 'location' | 'contact' | 'unsupported';
export type ChannelKey = 'whatsapp' | 'facebook' | 'instagram' | 'gmail';
export const MB = 1024 * 1024;
export const MAX_STORE_BYTES = 100 * MB;                    // tope de lo que se guarda (igual que el bucket)

const CHANNEL_NAME: Record<ChannelKey, string> = { whatsapp: 'WhatsApp', facebook: 'Messenger', instagram: 'Instagram', gmail: 'Gmail' };
const KIND_NAME: Record<string, string> = { image: 'imágenes', video: 'videos', audio: 'audios', document: 'documentos', file: 'archivos' };

// ---------------------------------------------------------------------------------------------- nombres
export const normalizeMime = (m: string | null | undefined): string => (m ?? '').split(';')[0]!.trim().toLowerCase();
export function extOf(name: string | null | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 && i < base.length - 1 ? base.slice(i + 1).toLowerCase() : '';
}

/** Nombre seguro para mostrar y para cabeceras: sin rutas, caracteres de control, comillas ni marcas de derecha-a-izquierda. */
export function sanitizeFileName(name: string | null | undefined, fallback = 'archivo'): string {
  let n = (name ?? '').split(/[\\/]/).pop() ?? '';
  n = n.replace(/[\u0000-\u001f\u007f\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
       .replace(/["'`<>:|?*\\]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (n.length > 120) { const e = extOf(n); n = e ? `${n.slice(0, 120 - e.length - 1)}.${e}` : n.slice(0, 120); }
  return n || fallback;
}

const DANGEROUS = new Set([
  'exe', 'msi', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'psd1', 'sh', 'bash', 'zsh', 'csh',
  'jar', 'jnlp', 'apk', 'ipa', 'dmg', 'app', 'dll', 'sys', 'drv', 'lnk', 'hta', 'reg', 'inf', 'msc', 'scf', 'gadget', 'command', 'run', 'bin', 'appimage',
  'html', 'htm', 'xhtml', 'shtml', 'svg', 'swf', 'vb', 'ws', 'url', 'iso', 'img',
]);
/** ¿El nombre parece de un ejecutable/script (también con doble extensión, como «factura.pdf.exe»)? */
export function hasDangerousName(name: string | null | undefined): boolean {
  const parts = (name ?? '').split(/[\\/]/).pop()!.toLowerCase().split('.').slice(1);
  return parts.some((p) => DANGEROUS.has(p.trim()));
}

// ---------------------------------------------------------------------------------------------- tipo real (por contenido)
export type Family = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'text' | 'executable' | 'markup' | 'container' | 'unknown';
export interface Sniff { mime: string | null; family: Family; alt?: string[] }

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

export function sniff(b: Uint8Array): Sniff {
  if (b.length < 4) return { mime: null, family: 'unknown' };
  if (ascii(b, 0, 5) === '#!AMR') return { mime: 'audio/amr', family: 'audio' };     // antes que los guiones: comparten «#!»
  // ejecutables y guiones
  if (startsWith(b, [0x4d, 0x5a]) || startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(b, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(b, [0xfe, 0xed, 0xfa, 0xcf])
    || startsWith(b, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xca, 0xfe, 0xba, 0xbe]) || startsWith(b, [0x23, 0x21])) return { mime: null, family: 'executable' };
  // imágenes
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', family: 'image' };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', family: 'image' };
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { mime: 'image/gif', family: 'image' };
  if (ascii(b, 0, 4) === 'RIFF' && b.length >= 12) {
    const t = ascii(b, 8, 12);
    if (t === 'WEBP') return { mime: 'image/webp', family: 'image' };
    if (t === 'WAVE') return { mime: 'audio/wav', family: 'audio' };
    if (t === 'AVI ') return { mime: 'video/x-msvideo', family: 'video' };
  }
  // contenedor ISO (mp4 / mov / 3gp / m4a / heic)
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return { mime: 'image/heic', family: 'image' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', family: 'video' };
    if (brand.startsWith('3g')) return { mime: 'video/3gpp', family: 'video', alt: ['audio/3gpp'] };
    if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return { mime: 'audio/mp4', family: 'audio', alt: ['audio/x-m4a', 'audio/aac'] };
    return { mime: 'video/mp4', family: 'container', alt: ['audio/mp4', 'audio/x-m4a', 'audio/aac', 'video/quicktime'] };
  }
  if (ascii(b, 0, 4) === 'OggS') return { mime: 'audio/ogg', family: 'container', alt: ['video/ogg', 'audio/opus', 'application/ogg'] };
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', family: 'container', alt: ['audio/webm'] };
  if (ascii(b, 0, 3) === 'ID3') return { mime: 'audio/mpeg', family: 'audio' };
  if (b[0] === 0xff && (b[1] === 0xf1 || b[1] === 0xf9)) return { mime: 'audio/aac', family: 'audio' };
  if (b[0] === 0xff && ((b[1]! & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', family: 'audio' };
  // documentos
  if (ascii(b, 0, 5) === '%PDF-') return { mime: 'application/pdf', family: 'document' };
  if (ascii(b, 0, 5) === '{\\rtf') return { mime: 'application/rtf', family: 'document' };
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { mime: 'application/msword', family: 'container', alt: ['application/vnd.ms-excel', 'application/vnd.ms-powerpoint'] };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]) || startsWith(b, [0x50, 0x4b, 0x07, 0x08])) {
    return { mime: 'application/zip', family: 'archive', alt: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/x-zip-compressed', 'application/vnd.oasis.opendocument.text'] };
  }
  // texto (y HTML/SVG disfrazado)
  const head = b.slice(0, 4096);
  if (!head.includes(0)) {
    let printable = 0;
    for (const c of head) if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) printable++;
    if (printable / head.length > 0.95) {
      const txt = new TextDecoder('utf-8', { fatal: false }).decode(head.slice(0, 1024)).trimStart().toLowerCase();
      if (/^(<!doctype html|<html|<head|<body|<script|<svg|<\?xml|<iframe)/.test(txt) || /<script[\s>]/.test(txt)) return { mime: null, family: 'markup' };
      return { mime: 'text/plain', family: 'text', alt: ['text/csv', 'application/json'] };
    }
  }
  return { mime: null, family: 'unknown' };
}

export type Resolved = { ok: true; mime: string; kind: MediaKind } | { ok: false; reason: 'dangerous_file' | 'mime_mismatch' };
const OCTET = 'application/octet-stream';

/** Cruza lo que DICE el canal con lo que el contenido ES. Nunca se confía solo en la extensión ni en el MIME declarado. */
export function resolveMime(declared: string | null | undefined, bytes: Uint8Array, fileName?: string | null): Resolved {
  const d = normalizeMime(declared);
  const s = sniff(bytes);
  if (s.family === 'executable' || s.family === 'markup') return { ok: false, reason: 'dangerous_file' };
  if (hasDangerousName(fileName)) return { ok: false, reason: 'dangerous_file' };
  if (!s.mime) {
    // sin firma conocida: solo se acepta texto plano o CSV declarado como tal
    return s.family === 'unknown' && (d === 'text/plain' || d === 'text/csv') ? { ok: true, mime: d, kind: 'document' } : { ok: false, reason: 'mime_mismatch' };
  }
  const compatible = d === '' || d === OCTET || d === s.mime || (s.alt ?? []).includes(d);
  if (compatible) {
    const mime = d === '' || d === OCTET ? s.mime : d === 'application/x-zip-compressed' ? 'application/zip' : d;
    return { ok: true, mime, kind: kindFromMime(mime) };
  }
  // el texto también puede declararse como CSV / JSON
  if (s.family === 'text' && d.startsWith('text/')) return { ok: true, mime: d, kind: 'document' };
  return { ok: false, reason: 'mime_mismatch' };
}

export function kindFromMime(mime: string | null | undefined): MediaKind {
  const m = normalizeMime(mime);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || m === 'application/msword' || m === 'application/rtf' || m.startsWith('text/') || m.startsWith('application/vnd.ms-')
    || m.startsWith('application/vnd.openxmlformats-officedocument') || m.startsWith('application/vnd.oasis.opendocument')) return 'document';
  return 'file';
}

// ---------------------------------------------------------------------------------------------- dimensiones de imagen
/** Ancho y alto leyendo solo la cabecera (PNG, GIF, JPEG, WebP). null si no se puede. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (startsWith(b, [0x89, 0x50, 0x4e, 0x47]) && b.length >= 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
    if (ascii(b, 0, 3) === 'GIF' && b.length >= 10) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    if (startsWith(b, [0xff, 0xd8])) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1]!;
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        const len = dv.getUint16(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
        i += 2 + len;
      }
      return null;
    }
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' && b.length >= 30) {
      const t = ascii(b, 12, 16);
      if (t === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
      if (t === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
      if (t === 'VP8L') { const v = dv.getUint32(21, true); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
    }
  } catch { /* cabecera incompleta */ }
  return null;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  return `${(n / MB).toFixed(1).replace('.', ',')} MB`;
}

// ---------------------------------------------------------------------------------------------- reglas de envío por canal
interface Group { kind: MediaKind; mimes: string[]; maxBytes: number }
const OFFICE = ['application/pdf', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'];
const DOCS_WIDE = [...OFFICE, 'text/plain', 'text/csv', 'application/zip', 'application/rtf'];

/** Lo que cada API permite ENVIAR (documentación oficial de Meta y Gmail; ver docs/MULTIMEDIA.md). */
export const SEND_RULES: Record<ChannelKey, { maxFiles: number; totalMax?: number; groups: Group[] }> = {
  whatsapp: { maxFiles: 1, groups: [
    { kind: 'image', mimes: ['image/jpeg', 'image/png'], maxBytes: 5 * MB },
    { kind: 'video', mimes: ['video/mp4', 'video/3gpp'], maxBytes: 16 * MB },
    { kind: 'audio', mimes: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'], maxBytes: 16 * MB },
    { kind: 'document', mimes: [...OFFICE, 'text/plain'], maxBytes: 100 * MB },
  ] },
  facebook: { maxFiles: 1, groups: [
    { kind: 'image', mimes: ['image/jpeg', 'image/png', 'image/gif'], maxBytes: 8 * MB },
    { kind: 'video', mimes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/3gpp'], maxBytes: 25 * MB },
    { kind: 'audio', mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/amr', 'audio/x-m4a'], maxBytes: 25 * MB },
    { kind: 'document', mimes: DOCS_WIDE, maxBytes: 25 * MB },
  ] },
  instagram: { maxFiles: 1, groups: [
    { kind: 'image', mimes: ['image/jpeg', 'image/png', 'image/gif'], maxBytes: 8 * MB },
    { kind: 'video', mimes: ['video/mp4', 'video/ogg', 'video/x-msvideo', 'video/quicktime', 'video/webm'], maxBytes: 25 * MB },
    { kind: 'audio', mimes: ['audio/aac', 'audio/x-m4a', 'audio/mp4', 'audio/wav'], maxBytes: 25 * MB },
    { kind: 'document', mimes: DOCS_WIDE, maxBytes: 25 * MB },
  ] },
  gmail: { maxFiles: 10, totalMax: 25 * MB, groups: [
    { kind: 'image', mimes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'], maxBytes: 25 * MB },
    { kind: 'video', mimes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/3gpp', 'video/ogg'], maxBytes: 25 * MB },
    { kind: 'audio', mimes: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/amr', 'audio/x-m4a', 'audio/webm'], maxBytes: 25 * MB },
    { kind: 'document', mimes: DOCS_WIDE, maxBytes: 25 * MB },
  ] },
};

export type SendCheck = { ok: true; kind: MediaKind; mime: string; maxBytes: number } | { ok: false; code: 'dangerous' | 'empty' | 'type_not_allowed' | 'too_large' | 'mismatch'; message: string };

/** Valida un archivo ANTES de subirlo o enviarlo, con el mensaje amigable que verá la persona. */
export function validateOutgoing(o: { channel: ChannelKey; fileName: string; mime: string; size: number; head?: Uint8Array }): SendCheck {
  const ch = CHANNEL_NAME[o.channel];
  const bad = (code: Exclude<SendCheck, { ok: true }>['code'], message: string): SendCheck => ({ ok: false, code, message });
  if (hasDangerousName(o.fileName)) return bad('dangerous', 'Por seguridad no se pueden enviar programas, scripts ni páginas web. Comprime el archivo en un ZIP o envíalo como documento.');
  if (!(o.size > 0)) return bad('empty', 'El archivo está vacío.');
  let mime = normalizeMime(o.mime);
  if (o.head) {
    const r = resolveMime(mime, o.head, o.fileName);
    if (!r.ok) return r.reason === 'dangerous_file'
      ? bad('dangerous', 'Por seguridad no se pueden enviar programas, scripts ni páginas web.')
      : bad('mismatch', 'El contenido del archivo no coincide con su tipo. Vuelve a exportarlo desde su programa e inténtalo de nuevo.');
    mime = r.mime;
  }
  const rules = SEND_RULES[o.channel];
  const group = rules.groups.find((g) => g.mimes.includes(mime));
  if (!group) {
    const accepted = rules.groups.map((g) => KIND_NAME[g.kind] ?? g.kind).join(', ');
    return bad('type_not_allowed', `Este tipo de archivo no puede enviarse mediante ${ch}. Formatos permitidos: ${accepted}${o.channel === 'whatsapp' ? ' (imágenes JPG o PNG, video MP4, audio AAC/MP3/M4A/OGG, y documentos PDF/Word/Excel/PowerPoint/TXT)' : ''}.`);
  }
  if (o.size > group.maxBytes) return bad('too_large', `El archivo supera el tamaño máximo permitido para ${ch} (${Math.round(group.maxBytes / MB)} MB para ${KIND_NAME[group.kind] ?? 'este tipo'}).`);
  return { ok: true, kind: group.kind, mime, maxBytes: group.maxBytes };
}

/** Varios archivos a la vez (solo Gmail admite más de uno; el total también tiene tope). */
export function validateBatch(channel: ChannelKey, sizes: number[]): { ok: true } | { ok: false; message: string } {
  const r = SEND_RULES[channel];
  if (sizes.length > r.maxFiles) return { ok: false, message: r.maxFiles === 1 ? `${CHANNEL_NAME[channel]} solo permite enviar un archivo por mensaje.` : `Se pueden adjuntar hasta ${r.maxFiles} archivos por mensaje.` };
  if (r.totalMax && sizes.reduce((a, b) => a + b, 0) > r.totalMax) return { ok: false, message: `Los archivos juntos superan el máximo permitido para ${CHANNEL_NAME[channel]} (${Math.round(r.totalMax / MB)} MB).` };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------- URLs externas (recibidos de Meta)
const META_HOSTS = ['.fbcdn.net', '.cdninstagram.com', '.fbsbx.com', '.facebook.com', '.instagram.com'];
/** Solo se descarga de los servidores de Meta (evita que un mensaje falso haga que el servidor visite direcciones internas). */
export function isAllowedMetaUrl(raw: string | null | undefined): boolean {
  try {
    const u = new URL(raw ?? '');
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
    const h = u.hostname.toLowerCase();
    if (/^[\d.]+$/.test(h) || h.includes(':') || h === 'localhost') return false;
    return META_HOSTS.some((s) => h.endsWith(s));
  } catch { return false; }
}

/** Un adjunto tal como lo entrega cualquier canal, antes de descargarlo (formato común para el Inbox). */
export interface AttachmentInput {
  kind: MediaKind; mime_type?: string | null; file_name?: string | null; file_size?: number | null; is_voice?: boolean;
  source?: Record<string, unknown>; meta?: Record<string, unknown>;
}
