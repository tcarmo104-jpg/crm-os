import type { Metadata } from 'next';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Eliminación de datos · CRM OS', description: 'Cómo pedir que se eliminen tus datos de CRM OS.' };

export default function DataDeletionPage() {
  return (
    <article>
      <h1>Eliminación de datos</h1>
      <p className="legal-meta">Última actualización: {LEGAL.updatedAt}</p>

      <p>Si escribiste a una empresa por WhatsApp, Instagram, Facebook Messenger o correo, y esa empresa usa {LEGAL.product}, puedes pedir que se eliminen tus datos (mensajes, archivos y ficha de cliente).</p>

      <h2>Cómo pedirlo</h2>
      <ol>
        <li>{LEGAL.contactEmail
          ? <>Escribe a <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a>, o </>
          : <>Escribe </>}
          directamente a la empresa con la que hablaste, por el mismo canal, indicando que quieres <strong>eliminar tus datos</strong>. Ella es la responsable de tu información.</li>
        <li>Indica el nombre, número de teléfono, correo o cuenta de Instagram/Facebook con el que la contactaste, para poder encontrar tu ficha.</li>
        <li>La empresa (o {LEGAL.product}, por su encargo) eliminará tu información en un plazo máximo de <strong>30 días</strong> y te confirmará por el mismo medio.</li>
      </ol>

      <h2>Qué se elimina</h2>
      <ul>
        <li>Tus mensajes y los archivos de tus conversaciones.</li>
        <li>Tu ficha de cliente (datos de contacto, notas y etiquetas).</li>
        <li>Se pueden conservar los datos que la ley obligue a guardar, por ejemplo los de una factura.</li>
      </ul>

      <h2>Si usaste «Iniciar sesión con Facebook o Instagram»</h2>
      <p>Además puedes quitar la aplicación desde tu cuenta: en Facebook, <em>Configuración → Aplicaciones y sitios web</em>; en Instagram, <em>Configuración → Sitios web y aplicaciones</em>. Al quitarla, la aplicación deja de tener acceso a tu cuenta.</p>

      <p>Más información sobre cómo tratamos tus datos en la <a href="/privacidad">política de privacidad</a>.</p>
    </article>
  );
}
