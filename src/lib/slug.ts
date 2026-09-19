/** "Distribuidora Andina S.A.S." → "distribuidora-andina-s-a-s" */
export function slugify(input: string, maxLen = 40): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
}
