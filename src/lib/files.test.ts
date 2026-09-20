import { describe, expect, it } from 'vitest';
import { FILE_GROUPS, fileGroup, type MediaKind } from './media';

describe('pestañas de «Archivos»', () => {
  it('imágenes y stickers → Imágenes; audio y video → Audio y video; todo lo demás → Documentos', () => {
    const map: Record<string, string> = {};
    for (const k of ['image', 'sticker', 'video', 'audio', 'document', 'file', 'location', 'contact', 'unsupported'] as MediaKind[]) map[k] = fileGroup(k);
    expect(map).toEqual({ image: 'images', sticker: 'images', video: 'av', audio: 'av', document: 'docs', file: 'docs', location: 'docs', contact: 'docs', unsupported: 'docs' });
  });
  it('las tres pestañas tienen etiqueta en español y clave única', () => {
    expect(FILE_GROUPS.map((g) => g.label)).toEqual(['Imágenes', 'Documentos', 'Audio y video']);
    expect(new Set(FILE_GROUPS.map((g) => g.key)).size).toBe(3);
  });
});
