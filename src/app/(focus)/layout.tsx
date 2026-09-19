import type { ReactNode } from 'react';
import { BRAND_NAME } from '@/lib/brand';

export default function FocusLayout({ children }: { children: ReactNode }) {
  return (
    <div className="focus">
      <header className="focus-head">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">{BRAND_NAME}</span>
      </header>
      <main className="focus-body">{children}</main>
    </div>
  );
}
