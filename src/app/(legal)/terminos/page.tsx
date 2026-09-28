import type { Metadata } from 'next';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Términos y condiciones · CRM OS', description: 'Condiciones de uso de CRM OS.' };

const contact = LEGAL.contactEmail
  ? <>escribe a <a href={`mailto:${LEGAL.contactEmail}`}>{LEGAL.contactEmail}</a></>
  : <>escribe directamente a la empresa que te atiende</>;

export default function TermsPage() {
  return (
    <article>
      <h1>Términos y condiciones</h1>
      <p className="legal-meta">Última actualización: {LEGAL.updatedAt}</p>

      <h2>1. Qué es {LEGAL.product}</h2>
      <p>{LEGAL.product} es una plataforma de gestión de clientes (CRM) que una empresa usa para atender a
        sus clientes por WhatsApp, Instagram, Facebook Messenger y correo electrónico, y para llevar el
        seguimiento de sus oportunidades de venta. Si estás leyendo esto, probablemente escribiste a una
        empresa que usa {LEGAL.product}, o formas parte de una empresa que lo usa.</p>

      <h2>2. Quién es responsable de qué</h2>
      <p>La <strong>empresa que te atiende</strong> es responsable de su relación contigo, de lo que te
        ofrece y de las decisiones que toma sobre tus datos. {LEGAL.product} le presta la herramienta y
        actúa por su cuenta, siguiendo sus instrucciones.</p>

      <h2>3. Cuentas de acceso al CRM</h2>
      <p>Quien tiene una cuenta para usar {LEGAL.product} (por ejemplo, el equipo de la empresa) es
        responsable de mantener su contraseña segura y de todo lo que ocurra desde su cuenta. Si sospechas
        de un acceso no autorizado, avisa de inmediato a la empresa dueña de la cuenta.</p>

      <h2>4. Uso permitido</h2>
      <ul>
        <li>{LEGAL.product} se usa para gestionar clientes, conversaciones y ventas de forma legítima.</li>
        <li>No está permitido usarlo para enviar spam, contenido engañoso, o mensajes a personas que hayan
          pedido no ser contactadas.</li>
        <li>No está permitido intentar acceder a datos de otra organización que use {LEGAL.product}, ni
          poner a prueba la seguridad del servicio sin autorización.</li>
      </ul>

      <h2>5. Conexión con WhatsApp, Instagram, Facebook y Gmail</h2>
      <p>Cuando una empresa conecta sus propias cuentas de estos servicios, {LEGAL.product} las usa
        únicamente para enviar y recibir los mensajes que esa empresa autoriza. El uso de esas cuentas
        también está sujeto a los términos del proveedor correspondiente (Meta, Google).</p>

      <h2>6. Disponibilidad del servicio</h2>
      <p>Se hace un esfuerzo razonable para mantener el servicio disponible, pero puede haber
        interrupciones por mantenimiento, fallas técnicas, o causas fuera de nuestro control. No se
        garantiza un funcionamiento ininterrumpido.</p>

      <h2>7. Cambios en el servicio</h2>
      <p>El servicio puede cambiar, mejorar o dejar de ofrecer alguna función con el tiempo. Cuando el
        cambio sea importante, se buscará avisar con antelación razonable.</p>

      <h2>8. Tus datos</h2>
      <p>Cómo se tratan tus datos personales se explica en la <a href="/privacidad">política de
        privacidad</a>. Si quieres que se eliminen, sigue las instrucciones de <a
        href="/eliminacion-de-datos">eliminación de datos</a>.</p>

      <h2>9. Límite de responsabilidad</h2>
      <p>{LEGAL.product} se ofrece «tal cual». En la medida permitida por la ley, no se garantiza que el
        servicio esté libre de errores, y no se responde por daños indirectos derivados de su uso.</p>

      <h2>10. Contacto</h2>
      <p>Si tienes preguntas sobre estos términos, {contact}.</p>

      <h2>11. Cambios en estos términos</h2>
      <p>Si se actualizan, se publicará aquí la nueva versión con su fecha.</p>
    </article>
  );
}
