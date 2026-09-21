import type { ReactNode } from 'react';
import './legal.css';

/** Páginas públicas (sin iniciar sesión, sin menú): política de privacidad y eliminación de datos. */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="legal">
      <header className="legal-head"><span className="legal-mark" aria-hidden="true" /><span>CRM OS</span></header>
      <main className="legal-body">{children}</main>
      <footer className="legal-foot"><a href="/privacidad">Política de privacidad</a> · <a href="/eliminacion-de-datos">Eliminación de datos</a></footer>
    </div>
  );
}
