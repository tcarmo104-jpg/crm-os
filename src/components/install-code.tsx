'use client';

import { useState } from 'react';

/** Un bloque de código con un botón «Copiar». Nada más. */
export function InstallCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* el navegador no lo permitió; la persona lo copia a mano */ }
  };
  return (
    <div className="install-code">
      <pre><code>{code}</code></pre>
      <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>{copied ? '¡Copiado!' : 'Copiar código'}</button>
    </div>
  );
}
