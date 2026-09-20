import type { TagRow } from '@/lib/types';

export function TagPill({ tag, children }: { tag: TagRow; children?: React.ReactNode }) {
  return <span className={`ib-tag ib-tag--${tag.color}`}>{tag.name}{children}</span>;
}
