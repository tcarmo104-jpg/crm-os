import { describe, expect, it } from 'vitest';
import { MB, SEND_RULES, extOf, formatBytes, hasDangerousName, imageSize, isAllowedMetaUrl, kindFromMime, normalizeMime, resolveMime, sanitizeFileName, sniff, validateBatch, validateOutgoing } from './media';

const u = (...n: number[]) => Uint8Array.from(n);
const str = (s: string) => new TextEncoder().encode(s);
const pad = (b: Uint8Array, n = 64) => { const o = new Uint8Array(Math.max(n, b.length)); o.set(b); return o; };
const JPEG = pad(u(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46));
const PNG = pad(u(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0x80, 0, 0, 1, 0xe0));   // 640 x 480
const GIF = pad(new Uint8Array([...str('GIF89a'), 0x40, 0x01, 0xf0, 0x00]));
const PDF = pad(str('%PDF-1.7\n'));
const ftyp = (brand: string) => pad(new Uint8Array([0, 0, 0, 24, ...str('ftyp'), ...str(brand)]));
const ZIP = pad(u(0x50, 0x4b, 0x03, 0x04, 20, 0));
const OLE = pad(u(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1));
const EXE = pad(u(0x4d, 0x5a, 0x90, 0));

describe('nombres', () => {
  it('extensión y MIME normalizado', () => {
    expect(extOf('Plano Final.PDF')).toBe('pdf'); expect(extOf('sin_extension')).toBe(''); expect(extOf('.oculto')).toBe(''); expect(extOf('a/b\\c.tar.gz')).toBe('gz');
    expect(normalizeMime('Audio/OGG; codecs=opus')).toBe('audio/ogg'); expect(normalizeMime(null)).toBe('');
  });
  it('limpia rutas, caracteres de control, comillas y marcas de derecha a izquierda (XSS / cabeceras / engaños)', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\x\\foto.jpg')).toBe('foto.jpg');
    expect(sanitizeFileName('a"b\r\nContent-Type: text html.pdf')).toBe('a_bContent-Type_ text html.pdf');
    expect(sanitizeFileName('x\r\nSet-Cookie: a=b.pdf')).not.toMatch(/[\r\n]/);
    expect(sanitizeFileName('<img src=x onerror=alert(1)>.png')).toBe('_img src=x onerror=alert(1)_.png');
    expect(sanitizeFileName('factura\u202Egpj.exe')).toBe('facturagpj.exe');
    expect(sanitizeFileName('   ...  ')).toBe('archivo'); expect(sanitizeFileName(null, 'x')).toBe('x');
    const long = sanitizeFileName(`${'a'.repeat(300)}.pdf`); expect(long.length).toBeLessThanOrEqual(120); expect(long.endsWith('.pdf')).toBe(true);
  });
  it('detecta ejecutables, scripts y páginas web por el nombre, incluida la doble extensión', () => {
    for (const n of ['virus.exe', 'x.BAT', 'setup.msi', 'a.js', 'run.sh', 'app.apk', 'factura.pdf.exe', 'foto.jpg.scr', 'pagina.html', 'logo.svg', 'x.exe.pdf', 'acceso.lnk']) expect(hasDangerousName(n)).toBe(true);
    for (const n of ['plano.pdf', 'foto.jpg', 'datos.xlsx', 'nota.txt', 'informe.final.docx', 'sin_extension', null]) expect(hasDangerousName(n)).toBe(false);
  });
});

describe('tipo real por contenido', () => {
  it('reconoce los formatos habituales', () => {
    expect(sniff(JPEG)).toMatchObject({ mime: 'image/jpeg', family: 'image' }); expect(sniff(PNG).mime).toBe('image/png'); expect(sniff(GIF).mime).toBe('image/gif');
    expect(sniff(pad(str('RIFF\x00\x00\x00\x00WEBPVP8 '))).mime).toBe('image/webp'); expect(sniff(pad(str('RIFF\x00\x00\x00\x00WAVEfmt '))).mime).toBe('audio/wav');
    expect(sniff(PDF).mime).toBe('application/pdf');
    expect(sniff(ftyp('isom')).mime).toBe('video/mp4'); expect(sniff(ftyp('qt  ')).mime).toBe('video/quicktime'); expect(sniff(ftyp('3gp4')).mime).toBe('video/3gpp');
    expect(sniff(ftyp('M4A ')).mime).toBe('audio/mp4'); expect(sniff(ftyp('heic')).mime).toBe('image/heic');
    expect(sniff(pad(str('OggS\x00\x02'))).family).toBe('container'); expect(sniff(pad(str('ID3\x04'))).mime).toBe('audio/mpeg'); expect(sniff(pad(u(0xff, 0xf1, 0x50))).mime).toBe('audio/aac');
    expect(sniff(pad(str('#!AMR\n'))).mime).toBe('audio/amr'); expect(resolveMime('audio/amr', pad(str('#!AMR\n')))).toMatchObject({ ok: true, kind: 'audio' }); expect(sniff(ZIP).mime).toBe('application/zip'); expect(sniff(OLE).family).toBe('container');
    expect(sniff(str('nombre,valor\nAna,10\n'.repeat(5))).family).toBe('text');
  });
  it('detecta ejecutables (Windows, Linux, macOS), guiones y HTML/SVG disfrazados', () => {
    expect(sniff(EXE).family).toBe('executable'); expect(sniff(pad(u(0x7f, 0x45, 0x4c, 0x46))).family).toBe('executable'); expect(sniff(pad(str('#!/bin/sh\nrm -rf /'))).family).toBe('executable');
    expect(sniff(pad(u(0xcf, 0xfa, 0xed, 0xfe))).family).toBe('executable');
    for (const html of ['<!DOCTYPE html><html>', '<html><body>', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '  <script>alert(1)</script>', '<?xml version="1.0"?><svg>']) expect(sniff(str(html)).family).toBe('markup');
  });
  it('un archivo demasiado corto o binario desconocido no se reconoce', () => { expect(sniff(u(1, 2)).family).toBe('unknown'); expect(sniff(pad(u(0, 1, 2, 3, 0, 5))).family).toBe('unknown'); });
});

describe('MIME declarado frente al contenido (anti-suplantación)', () => {
  it('lo declarado y lo real coinciden → se acepta con su tipo', () => {
    expect(resolveMime('image/jpeg', JPEG)).toEqual({ ok: true, mime: 'image/jpeg', kind: 'image' });
    expect(resolveMime('application/pdf', PDF)).toEqual({ ok: true, mime: 'application/pdf', kind: 'document' });
    expect(resolveMime('audio/ogg; codecs=opus', pad(str('OggS\x00\x02')))).toEqual({ ok: true, mime: 'audio/ogg', kind: 'audio' });
    expect(resolveMime('audio/mp4', ftyp('isom'))).toMatchObject({ ok: true, kind: 'audio' });
    expect(resolveMime('video/quicktime', ftyp('isom'))).toMatchObject({ ok: true, kind: 'video' });
    expect(resolveMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP)).toMatchObject({ ok: true, kind: 'document' });
    expect(resolveMime('application/vnd.ms-excel', OLE)).toMatchObject({ ok: true, kind: 'document' });
    expect(resolveMime('text/csv', str('a,b\n1,2\n'.repeat(4)))).toEqual({ ok: true, mime: 'text/csv', kind: 'document' });
  });
  it('sin MIME o «octet-stream» se usa el real', () => {
    expect(resolveMime('application/octet-stream', PNG)).toEqual({ ok: true, mime: 'image/png', kind: 'image' });
    expect(resolveMime(null, PDF)).toMatchObject({ ok: true, mime: 'application/pdf' });
    expect(resolveMime('application/x-zip-compressed', ZIP)).toMatchObject({ mime: 'application/zip', kind: 'file' });
  });
  it('un ejecutable disfrazado de imagen o PDF se BLOQUEA', () => {
    expect(resolveMime('image/png', EXE)).toEqual({ ok: false, reason: 'dangerous_file' });
    expect(resolveMime('application/pdf', pad(u(0x7f, 0x45, 0x4c, 0x46)))).toEqual({ ok: false, reason: 'dangerous_file' });
    expect(resolveMime('image/svg+xml', str('<svg onload=alert(1)>'))).toEqual({ ok: false, reason: 'dangerous_file' });
    expect(resolveMime('application/pdf', PDF, 'factura.pdf.exe')).toEqual({ ok: false, reason: 'dangerous_file' });
  });
  it('un tipo que no coincide con el contenido se rechaza', () => {
    expect(resolveMime('image/jpeg', PDF)).toEqual({ ok: false, reason: 'mime_mismatch' });
    expect(resolveMime('application/pdf', JPEG)).toEqual({ ok: false, reason: 'mime_mismatch' });
    expect(resolveMime('video/mp4', PNG)).toEqual({ ok: false, reason: 'mime_mismatch' });
    expect(resolveMime('image/png', pad(u(0, 1, 2, 3, 0, 5)))).toEqual({ ok: false, reason: 'mime_mismatch' });
  });
  it('clasifica por MIME', () => {
    expect(kindFromMime('image/webp')).toBe('image'); expect(kindFromMime('video/mp4')).toBe('video'); expect(kindFromMime('audio/ogg')).toBe('audio');
    expect(kindFromMime('application/pdf')).toBe('document'); expect(kindFromMime('text/csv')).toBe('document'); expect(kindFromMime('application/vnd.ms-excel')).toBe('document');
    expect(kindFromMime('application/zip')).toBe('file'); expect(kindFromMime('application/x-rar')).toBe('file'); expect(kindFromMime(null)).toBe('file');
  });
});

describe('dimensiones de imagen', () => {
  it('PNG, GIF, JPEG y WebP', () => {
    expect(imageSize(PNG)).toEqual({ width: 640, height: 480 });
    expect(imageSize(GIF)).toEqual({ width: 320, height: 240 });
    expect(imageSize(pad(u(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1)))).toEqual({ width: 640, height: 480 });
    const vp8x = pad(new Uint8Array([...str('RIFF'), 0, 0, 0, 0, ...str('WEBP'), ...str('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, 0x7f, 0x02, 0, 0xdf, 0x01, 0]), 40);
    expect(imageSize(vp8x)).toEqual({ width: 640, height: 480 });
    expect(imageSize(PDF)).toBeNull(); expect(imageSize(u(0xff, 0xd8))).toBeNull(); expect(imageSize(u(1))).toBeNull();
  });
});

describe('tamaños', () => {
  it('se muestran en español', () => { expect(formatBytes(512)).toBe('512 B'); expect(formatBytes(2048)).toBe('2 KB'); expect(formatBytes(2.4 * MB)).toBe('2,4 MB'); expect(formatBytes(null)).toBe(''); expect(formatBytes(-1)).toBe(''); });
});

describe('reglas de envío por canal', () => {
  const ok = (channel: Parameters<typeof validateOutgoing>[0]['channel'], fileName: string, mime: string, size: number) => validateOutgoing({ channel, fileName, mime, size });
  it('WhatsApp: solo lo que su API admite, con sus tamaños', () => {
    expect(ok('whatsapp', 'foto.jpg', 'image/jpeg', 4 * MB)).toMatchObject({ ok: true, kind: 'image' });
    expect(ok('whatsapp', 'foto.png', 'image/png', 5 * MB)).toMatchObject({ ok: true });
    expect(ok('whatsapp', 'plano.pdf', 'application/pdf', 90 * MB)).toMatchObject({ ok: true, kind: 'document' });
    expect(ok('whatsapp', 'v.mp4', 'video/mp4', 16 * MB)).toMatchObject({ ok: true });
    expect(ok('whatsapp', 'nota.ogg', 'audio/ogg', MB)).toMatchObject({ ok: true, kind: 'audio' });
    for (const [n, m] of [['a.gif', 'image/gif'], ['a.webp', 'image/webp'], ['a.heic', 'image/heic'], ['v.mov', 'video/quicktime'], ['v.webm', 'video/webm'], ['d.csv', 'text/csv'], ['d.zip', 'application/zip']] as const) {
      const r = ok('whatsapp', n, m, 1000); expect(r).toMatchObject({ ok: false, code: 'type_not_allowed' }); expect((r as { message: string }).message).toMatch(/no puede enviarse mediante WhatsApp/);
    }
    const big = ok('whatsapp', 'foto.jpg', 'image/jpeg', 5 * MB + 1); expect(big).toMatchObject({ ok: false, code: 'too_large' });
    expect((big as { message: string }).message).toBe('El archivo supera el tamaño máximo permitido para WhatsApp (5 MB para imágenes).');
    expect(ok('whatsapp', 'v.mp4', 'video/mp4', 17 * MB)).toMatchObject({ code: 'too_large' });
  });
  it('Instagram: imágenes 8 MB (png/jpg/gif), sin WebP; mensaje con el nombre del canal', () => {
    expect(ok('instagram', 'a.gif', 'image/gif', 7 * MB)).toMatchObject({ ok: true });
    const r = ok('instagram', 'a.webp', 'image/webp', 1000); expect(r).toMatchObject({ ok: false }); expect((r as { message: string }).message).toMatch(/Este tipo de archivo no puede enviarse mediante Instagram/);
    expect(ok('instagram', 'a.png', 'image/png', 9 * MB)).toMatchObject({ code: 'too_large' });
    expect(ok('instagram', 'v.mov', 'video/quicktime', 24 * MB)).toMatchObject({ ok: true });
  });
  it('Messenger: imagen, video, audio y archivo hasta 25 MB', () => {
    expect(ok('facebook', 'a.zip', 'application/zip', 24 * MB)).toMatchObject({ ok: true, kind: 'document' });
    expect(ok('facebook', 'a.zip', 'application/zip', 26 * MB)).toMatchObject({ code: 'too_large' });
    expect(ok('facebook', 'a.jpg', 'image/jpeg', 8 * MB + 1)).toMatchObject({ code: 'too_large' });
  });
  it('Gmail: casi cualquier archivo seguro, varios a la vez, 25 MB en total', () => {
    expect(ok('gmail', 'datos.csv', 'text/csv', MB)).toMatchObject({ ok: true }); expect(ok('gmail', 'a.heic', 'image/heic', MB)).toMatchObject({ ok: true });
    expect(validateBatch('gmail', [10 * MB, 10 * MB])).toEqual({ ok: true });
    expect(validateBatch('gmail', [20 * MB, 10 * MB])).toMatchObject({ ok: false, message: expect.stringMatching(/juntos superan/) });
    expect(validateBatch('gmail', Array(11).fill(1))).toMatchObject({ ok: false, message: expect.stringMatching(/hasta 10 archivos/) });
    expect(validateBatch('whatsapp', [1, 1])).toMatchObject({ ok: false, message: 'WhatsApp solo permite enviar un archivo por mensaje.' });
    expect(validateBatch('whatsapp', [1])).toEqual({ ok: true });
  });
  it('en NINGÚN canal se envían ejecutables, scripts ni HTML, ni archivos vacíos', () => {
    for (const ch of Object.keys(SEND_RULES) as (keyof typeof SEND_RULES)[]) {
      for (const n of ['a.exe', 'a.js', 'a.sh', 'a.html', 'a.pdf.exe', 'a.svg']) expect(ok(ch, n, 'application/pdf', 100)).toMatchObject({ ok: false, code: 'dangerous' });
      expect(ok(ch, 'a.pdf', 'application/pdf', 0)).toMatchObject({ ok: false, code: 'empty' });
    }
  });
  it('con el contenido a la vista: MIME suplantado o ejecutable disfrazado se rechazan; el tipo real manda', () => {
    expect(validateOutgoing({ channel: 'whatsapp', fileName: 'foto.png', mime: 'image/png', size: 100, head: EXE })).toMatchObject({ ok: false, code: 'dangerous' });
    expect(validateOutgoing({ channel: 'whatsapp', fileName: 'foto.png', mime: 'image/png', size: 100, head: PDF })).toMatchObject({ ok: false, code: 'mismatch' });
    expect(validateOutgoing({ channel: 'whatsapp', fileName: 'foto', mime: 'application/octet-stream', size: 100, head: PNG })).toMatchObject({ ok: true, kind: 'image', mime: 'image/png' });
  });
});

describe('descarga solo de servidores de Meta', () => {
  it('acepta https de los dominios de Meta', () => {
    for (const x of ['https://scontent.xx.fbcdn.net/v/t1/a.jpg?x=1', 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1', 'https://scontent-mad1-1.cdninstagram.com/v/x.mp4', 'https://cdn.fbsbx.com/x']) expect(isAllowedMetaUrl(x)).toBe(true);
  });
  it('rechaza todo lo demás: http, IPs, direcciones internas, credenciales, otros dominios y parecidos engañosos', () => {
    for (const x of ['http://scontent.xx.fbcdn.net/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/a', 'https://evil.com/fbcdn.net',
      'https://fbcdn.net.evil.com/a', 'https://evilfbcdn.net/a', 'https://user:pw@scontent.xx.fbcdn.net/a', 'https://scontent.xx.fbcdn.net:8443/a', 'ftp://x.fbcdn.net/a', 'no-es-url', '', null, undefined]) expect(isAllowedMetaUrl(x as string)).toBe(false);
  });
});
