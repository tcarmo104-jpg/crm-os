import { describe, expect, it } from 'vitest';
import { acceptFor, captionMode, isAutoLabel, mimeFromName } from './media';
import { buildMediaPayload } from './meta';
import { buildMimeMessage } from './gmail';

describe('selector de archivos por canal', () => {
  it('WhatsApp no ofrece lo que no admite (GIF, WebP, HEIC, MOV, CSV, ZIP)', () => {
    const a = acceptFor('whatsapp').split(',');
    for (const ok of ['image/jpeg', 'image/png', '.jpg', '.pdf', '.docx', 'video/mp4', '.mp3', '.ogg']) expect(a).toContain(ok);
    for (const no of ['image/gif', '.gif', 'image/webp', '.heic', '.mov', '.csv', '.zip', 'video/quicktime']) expect(a).not.toContain(no);
  });
  it('Instagram: imágenes PNG/JPG/GIF; solo imágenes si se pide «imagen»', () => {
    expect(acceptFor('instagram', 'image').split(',')).toEqual(expect.arrayContaining(['image/png', '.gif']));
    expect(acceptFor('instagram', 'image')).not.toMatch(/pdf|mp4/);
    expect(acceptFor('instagram')).toMatch(/\.mov/);
  });
  it('Gmail admite casi todo lo seguro (incluye CSV, ZIP y HEIC) y nunca ejecutables', () => {
    const a = acceptFor('gmail'); expect(a).toMatch(/\.csv/); expect(a).toMatch(/\.zip/); expect(a).toMatch(/\.heic/); expect(a).not.toMatch(/\.exe|\.js|\.html|\.svg/);
  });
  it('deduce el tipo por la extensión cuando el navegador no lo informa', () => {
    expect(mimeFromName('Plano Final.PDF')).toBe('application/pdf'); expect(mimeFromName('foto.jpeg')).toBe('image/jpeg'); expect(mimeFromName('nota.opus')).toBe('audio/ogg');
    expect(mimeFromName('sin_extension')).toBe(''); expect(mimeFromName('virus.exe')).toBe(''); expect(mimeFromName(null)).toBe('');
  });
});

describe('texto que acompaña al archivo', () => {
  it('WhatsApp lo lleva en imagen, video y documento (1024) pero NO en audio; Messenger/Instagram lo mandan aparte; Gmail es el cuerpo', () => {
    for (const k of ['image', 'video', 'document'] as const) expect(captionMode('whatsapp', k)).toEqual({ inline: true, max: 1024 });
    expect(captionMode('whatsapp', 'audio').inline).toBe(false);
    expect(captionMode('facebook', 'image').inline).toBe(false); expect(captionMode('instagram', 'document').inline).toBe(false);
    expect(captionMode('gmail', 'document')).toEqual({ inline: true, max: 4096 });
  });
  it('las etiquetas automáticas no cuentan como pie de foto', () => {
    for (const l of ['[Imagen]', '[Video]', '[Audio]', '[Documento: plano.pdf]', '[2 adjuntos]']) expect(isAutoLabel(l)).toBe(true);
    for (const l of ['Mira esto', '[Imagen] Mira', 'Ver [Imagen] abajo', '', null]) expect(isAutoLabel(l as string)).toBe(false);
  });
});

describe('mensaje de WhatsApp con archivo', () => {
  it('imagen y video llevan pie de foto; documento lleva pie y nombre; audio NO lleva pie', () => {
    expect(buildMediaPayload('573001110000', 'image', 'M1', { caption: 'Mira' })).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001110000', type: 'image', image: { id: 'M1', caption: 'Mira' } });
    expect(buildMediaPayload('573001110000', 'video', 'M2', { caption: 'Recorrido' }).video).toEqual({ id: 'M2', caption: 'Recorrido' });
    expect(buildMediaPayload('573001110000', 'document', 'M3', { caption: 'Plano', fileName: 'plano.pdf' }).document).toEqual({ id: 'M3', caption: 'Plano', filename: 'plano.pdf' });
    expect(buildMediaPayload('573001110000', 'audio', 'M4', { caption: 'no debe ir' }).audio).toEqual({ id: 'M4' });
    expect(buildMediaPayload('573001110000', 'image', 'M5').image).toEqual({ id: 'M5' });
    expect((buildMediaPayload('573001110000', 'image', 'M6', { caption: 'a'.repeat(2000) }).image as { caption: string }).caption).toHaveLength(1024);
  });
});

const dec = (b: Uint8Array) => Buffer.from(b).toString('utf8');
const unfold = (s: string) => Buffer.from(s.replace(/\r\n/g, ''), 'base64');
describe('correo con adjuntos (MIME)', () => {
  const base = { from: 'ventas@arkos.co', to: 'ana@ejemplo.com', subject: 'Re: Cotización', body: 'Hola Ana, adjunto el plano.' };
  it('sin adjuntos es un correo simple de texto', () => {
    const m = dec(buildMimeMessage(base));
    expect(m).toContain('To: ana@ejemplo.com'); expect(m).not.toMatch(/multipart/); expect(unfold(m.split('\r\n\r\n')[1]!).toString()).toBe(base.body);
  });
  it('con adjuntos: multipart/mixed, texto primero y cada archivo en base64 con su nombre y tipo', () => {
    const pdf = Buffer.from('%PDF-1.7 contenido de prueba '.repeat(50)); const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const m = dec(buildMimeMessage({ ...base, boundary: 'B1', attachments: [{ fileName: 'plano.pdf', mime: 'application/pdf', bytes: pdf }, { fileName: 'foto.png', mime: 'image/png', bytes: png }] }));
    expect(m).toContain('Content-Type: multipart/mixed; boundary="B1"');
    expect(m.split('--B1').length).toBe(5);                                   // vacío + texto + 2 adjuntos + cierre
    expect(m).toContain('Content-Type: application/pdf; name="plano.pdf"'); expect(m).toContain('Content-Disposition: attachment; filename="plano.pdf"');
    const partPdf = m.split('--B1').find((x) => x.includes('plano.pdf'))!.split('\r\n\r\n')[1]!;
    expect(unfold(partPdf).equals(pdf)).toBe(true);                            // el contenido viaja íntegro
    expect(Math.max(...partPdf.split('\r\n').map((l) => l.length))).toBeLessThanOrEqual(76);
    expect(m.endsWith('--B1--\r\n')).toBe(true);
  });
  it('nombres con acentos: respaldo ASCII y formato RFC 2231', () => {
    const m = dec(buildMimeMessage({ ...base, attachments: [{ fileName: 'Cotización año 2026.pdf', mime: 'application/pdf', bytes: Uint8Array.from([1]) }] }));
    expect(m).toContain('filename="Cotizaci_n a_o 2026.pdf"'); expect(m).toContain("filename*=UTF-8''Cotizaci%C3%B3n%20a%C3%B1o%202026.pdf");
  });
  it('no permite inyectar cabeceras por el nombre del archivo, el asunto ni un tipo raro', () => {
    const m = dec(buildMimeMessage({ ...base, subject: 'Hola\r\nBcc: espia@malo.com', attachments: [{ fileName: 'a"\r\nBcc: otro@malo.com.pdf', mime: 'text/html\r\nX: y', bytes: Uint8Array.from([1]) }] }));
    expect(m).not.toMatch(/^Bcc:/im);
    expect(m).toContain('Content-Type: application/octet-stream; name=');
    expect(() => buildMimeMessage({ ...base, to: 'ana@ejemplo.com\r\nBcc: x@y.com' })).toThrow('invalid_address');
  });
});
