import { notFound, redirect } from 'next/navigation';
import { uuidSchema } from '@/services/schemas';

/** Enlace de compatibilidad (fichas de cliente y notificaciones antiguas): abre la conversación en la vista de tres paneles. */
export default async function ConversationRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  redirect(`/inbox?c=${id}`);
}
