/** Mientras llega una pestaña (al entrar desde el menú): la forma de la pantalla, no una página en blanco. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Cargando" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="kpi-grid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="an-skel" style={{ height: 116 }} />)}</div>
      <div className="an-grid-wide"><div className="an-skel" style={{ height: 300 }} /><div className="an-skel" style={{ height: 300 }} /></div>
    </div>
  );
}
