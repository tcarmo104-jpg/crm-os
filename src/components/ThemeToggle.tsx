'use client';

import { useEffect, useState } from 'react';
import { Icon } from './Icon';

type Theme = 'light' | 'dark';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as Theme) === 'dark' ? 'dark' : 'light');
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('crm_theme', next);
    } catch {
      /* modo privado: el tema solo dura esta visita */
    }
    setTheme(next);
  };

  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema oscuro'}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}
