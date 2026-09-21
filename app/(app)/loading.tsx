/** Mientras llega una pantalla: esqueleto del mismo ancho y forma que la página real (sin saltos ni pantalla en blanco). */
export default function Loading() {
  return (
    <div className="stack-lg" role="status" aria-label="Cargando">
      <div className="stack"><div className="skeleton sk-title" /><div className="skeleton sk-line" style={{ width: 180 }} /></div>
      <div className="kpi-grid"><div className="skeleton sk-card" /><div className="skeleton sk-card" /><div className="skeleton sk-card" /><div className="skeleton sk-card" /></div>
      <div className="dash-grid"><div className="skeleton sk-panel" /><div className="skeleton sk-panel" /></div>
    </div>
  );
}
