/** Traduce el error de inicio de sesión de Supabase a un mensaje en español que la persona entiende:
 * nunca expone detalles técnicos, y nunca insinúa si un correo en particular está o no registrado.
 * `status` es el código HTTP que ya entrega el proveedor de autenticación (no se inventa ninguno nuevo). */
export function loginErrorMessage(error: { status?: number; message: string }): string {
  const msg = error.message.toLowerCase();
  if (msg.includes('not confirmed')) return 'Confirma tu correo desde el mensaje que te enviamos y vuelve a iniciar sesión.';
  if (error.status === 429 || msg.includes('rate limit')) return 'Hiciste demasiados intentos. Espera un minuto y vuelve a intentarlo.';
  if (error.status === 400 || msg.includes('invalid login credentials')) return 'El correo electrónico o la contraseña no son correctos.';
  return 'No pudimos iniciar sesión. Inténtalo nuevamente.';
}
