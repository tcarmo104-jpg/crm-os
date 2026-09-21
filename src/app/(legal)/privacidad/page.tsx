import type { Metadata } from 'next';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Política de privacidad · CRM OS', description: 'Cómo CRM OS trata los datos de las personas que escriben a las empresas que lo usan.' };

const contact = LEGAL.contactEmail
  ? <>escribe a <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a> o directamente a la empresa que te atiende</>
  : <>escribe directamente a la empresa que te atiende (por el mismo canal en el que hablaste con ella: WhatsApp, Instagram, Messenger o correo)</>;

export default function PrivacyPage() {
  return (
    <article>
      <h1>Política de privacidad</h1>
      <p className="legal-meta">Última actualización: {LEGAL.updatedAt}</p>

      <h2>1. Quiénes somos</h2>
      <p>{LEGAL.product} es una plataforma de gestión de clientes (CRM) que las empresas usan para atender a sus clientes por WhatsApp, Instagram, Facebook Messenger y correo electrónico (Gmail).
        La <strong>empresa que te atiende es la responsable</strong> de tus datos; {LEGAL.product} los trata únicamente por cuenta de esa empresa y siguiendo sus instrucciones.</p>

      <h2>2. Qué datos tratamos</h2>
      <ul>
        <li>Los <strong>mensajes</strong> que envías a la empresa y sus respuestas, con la fecha y la hora, y los <strong>archivos</strong> que se intercambian (fotos, documentos, audios, videos, ubicaciones).</li>
        <li>Datos de contacto que tu cuenta hace visibles: nombre de perfil, número de teléfono, dirección de correo o identificador de tu cuenta en Instagram o Messenger.</li>
        <li>Datos que la empresa añade a tu ficha de cliente: notas, etiquetas, cotizaciones, pedidos y seguimiento comercial.</li>
        <li>De las personas que usan el CRM en la empresa: nombre, correo y actividad dentro de la plataforma.</li>
      </ul>

      <h2>3. Para qué los usamos</h2>
      <ul>
        <li>Recibir tus mensajes y permitir que la empresa te responda.</li>
        <li>Asociar cada conversación a tu ficha de cliente y dar seguimiento a tu consulta, cotización o compra.</li>
        <li>Mantener la seguridad y el buen funcionamiento del servicio.</li>
      </ul>
      <p><strong>No vendemos tus datos, no los usamos para publicidad</strong> y no los compartimos con otras empresas clientes de la plataforma: cada empresa solo ve lo suyo.</p>

      <h2>4. Datos que recibimos de Meta y Google</h2>
      <p>Cuando una empresa conecta su cuenta de WhatsApp Business, Instagram, Facebook o Gmail, usamos los permisos que ella autoriza <strong>únicamente</strong> para leer y responder los mensajes de esa cuenta.
        El uso de la información recibida de las API de Google respeta la Política de datos de usuario de los servicios de API de Google, incluidos los requisitos de uso limitado.
        No usamos esos datos para publicidad ni para entrenar modelos de inteligencia artificial de uso general.</p>

      <h2>5. Con quién los compartimos</h2>
      <p>Solo con los proveedores de infraestructura necesarios para operar el servicio (alojamiento y base de datos) y con Meta y Google cuando se envían o reciben mensajes por sus canales. No hay otros destinatarios, salvo que una ley lo exija.</p>

      <h2>6. Cuánto tiempo los conservamos</h2>
      <p>Los mensajes y la ficha del cliente se conservan mientras la empresa mantenga su cuenta o hasta que se solicite su eliminación. Los archivos recibidos o enviados se guardan hasta {LEGAL.retention.files}; después se eliminan.</p>

      <h2>7. Cómo los protegemos</h2>
      <p>La comunicación viaja cifrada, el acceso se controla por roles, los datos de cada empresa están aislados de los de las demás y las credenciales de conexión se guardan en el servidor y nunca se muestran.</p>

      <h2>8. Tus derechos</h2>
      <p>Puedes pedir acceso, corrección, oposición o eliminación de tus datos. Para ejercerlos, {contact}.
        También puedes seguir las instrucciones de la página de <a href="/eliminacion-de-datos">eliminación de datos</a>.</p>

      <h2>9. Menores de edad</h2>
      <p>El servicio no está dirigido a menores de edad. Si crees que un menor nos ha enviado datos, pídenos eliminarlos.</p>

      <h2>10. Cambios en esta política</h2>
      <p>Si la actualizamos, publicaremos aquí la nueva versión con su fecha.</p>
    </article>
  );
}
