import { Icon } from './Icon';

/** Búsqueda global: por ahora busca clientes (nombre, teléfono o correo). Es un formulario normal: funciona sin JavaScript. */
export function GlobalSearch() {
  return (
    <form className="gsearch" action="/customers" method="get" role="search">
      <Icon name="search" size={16} />
      <input type="search" name="q" placeholder="Buscar clientes por nombre, teléfono o correo" aria-label="Buscar clientes" maxLength={80} autoComplete="off" />
    </form>
  );
}
