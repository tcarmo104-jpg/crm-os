import type { ReactNode } from 'react';
import { BRAND_NAME } from '@/lib/brand';

/**
 * El «acceso» al CRM: login, crear cuenta, recuperar contraseña. En escritorio, un panel de marca a la
 * izquierda y el formulario a la derecha (el patrón habitual de un SaaS empresarial); en móvil, una sola
 * columna centrada. Nada de esto toca el sistema de autenticación: es solo la vitrina.
 */
export default function FocusLayout({ children }: { children: ReactNode }) {
  return (
    <div className="focus">
      <aside className="focus-brand" aria-hidden="true">
        <div className="focus-brand-inner">
          <span className="focus-brand-mark" />
          <span className="focus-brand-name">{BRAND_NAME}</span>
          <p className="focus-brand-tag">Todas tus conversaciones, clientes y ventas, en un solo lugar.</p>
          <ul className="focus-brand-points">
            <li><span className="focus-brand-dot" />WhatsApp, Instagram, Facebook y correo en un mismo Inbox</li>
            <li><span className="focus-brand-dot" />Oportunidades, cotizaciones y ventas bajo control</li>
            <li><span className="focus-brand-dot" />Tus datos, cifrados y con acceso por roles</li>
          </ul>
        </div>
      </aside>
      <main className="focus-panel">
        <header className="focus-head">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">{BRAND_NAME}</span>
        </header>
        <div className="focus-body">{children}</div>
      </main>
    </div>
  );
}
