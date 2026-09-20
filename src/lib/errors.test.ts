import { describe, expect, it } from 'vitest';
import { DbError, UserFacingError, toUserMessage, unwrap } from './errors';

describe('toUserMessage', () => {
  it('traduce errores de invitaciones', () => {
    expect(toUserMessage(new DbError({ message: 'invitation_expired', code: '55000' }))).toMatch(/venció/);
    expect(toUserMessage(new DbError({ message: 'invitation_revoked', code: '55000' }))).toMatch(/cancelada/);
    expect(toUserMessage(new DbError({ message: 'email_mismatch', code: '42501' }))).toMatch(/otro correo/);
    expect(toUserMessage(new DbError({ message: 'email_not_verified', code: '42501' }))).toMatch(/Verifica tu correo/);
  });
  it('traduce permisos y duplicados', () => {
    expect(toUserMessage(new DbError({ message: 'permission denied', code: '42501' }))).toBe('No tienes permiso para hacer esto.');
    expect(toUserMessage(new DbError({ message: 'duplicate key ... "organizations_slug_key"', code: '23505' }))).toMatch(/identificador/);
    expect(toUserMessage(new DbError({ message: 'duplicate key ... "teams_org_id_name_key"', code: '23505' }))).toMatch(/equipo/);
    expect(toUserMessage(new DbError({ message: 'user is already a member', code: '23505' }))).toMatch(/ya es miembro/);
  });
  it('protege la propiedad de la organización', () => {
    expect(toUserMessage(new DbError({ message: 'organization must keep at least one active super_admin', code: '23514' })))
      .toMatch(/al menos un super administrador/);
  });
  it('mensajes de UserFacingError pasan tal cual', () => {
    expect(toUserMessage(new UserFacingError('Escribe el nombre.'))).toBe('Escribe el nombre.');
  });
  it('nunca expone detalles internos de errores desconocidos', () => {
    const msg = toUserMessage(new Error('relation "public.secret_table" does not exist'));
    expect(msg).not.toMatch(/secret_table|relation/);
    expect(toUserMessage(new DbError({ message: 'select * from x failed', code: 'XX000' }))).not.toMatch(/select/);
  });
});

describe('unwrap', () => {
  it('devuelve data o lanza DbError con el código', () => {
    expect(unwrap({ data: 5, error: null })).toBe(5);
    try {
      unwrap({ data: null, error: { message: 'x', code: '42501' } });
      throw new Error('no lanzó');
    } catch (e) {
      expect(e).toBeInstanceOf(DbError);
      expect((e as DbError).code).toBe('42501');
    }
  });

  it('traduce los errores de clientes e identidad', () => {
    const e = (message: string, code?: string) => toUserMessage(new DbError({ message, code }));
    expect(e('contact_required', '22023')).toMatch(/dato de contacto/);
    expect(e('custom_field: presupuesto must be a number', '22023')).toMatch(/campos personalizados/);
    expect(e('only managers can clear do-not-contact', '42501')).toMatch(/no contactar/);
    expect(e('only managers can merge customers', '42501')).toMatch(/fusionar/);
    expect(e('owner must be an active member of the organization', '23514')).toMatch(/miembro activo/);
    expect(e('api key limit reached', '53400')).toMatch(/20 llaves/);
  });
  it('nunca filtra SQL ni nombres internos en estos mensajes', () => {
    const m = toUserMessage(new DbError({ message: 'insert into customer_identifiers violates x', code: '99999' }));
    expect(m).not.toMatch(/customer_identifiers|insert/i);
  });

  it('traduce los errores de cotizaciones y ventas', () => {
    const e = (message: string, code?: string) => toUserMessage(new DbError({ message, code }));
    expect(e('discount_requires_approval', '42501')).toMatch(/manager/);
    expect(e('quote_locked', '23514')).toMatch(/nueva versión/);
    expect(e('conversation_customer_mismatch', '23514')).toMatch(/otro cliente/);
    expect(e('window_closed', '23514')).toMatch(/24 horas/);
    expect(e('do_not_contact', '23514')).toMatch(/no ser contactado/);
    expect(e('channel_paused', '23514')).toMatch(/en pausa/);
    expect(e('template_params', '22023')).toMatch(/datos de la plantilla/);
    expect(e('message_empty', '22023')).toMatch(/Escribe el mensaje/);
    expect(e('duplicate key value violates unique constraint "quotes_one_accepted_uk"', '23505')).toMatch(/ya tiene una cotización aceptada/);
    expect(e('duplicate key value violates unique constraint "products_sku_uk"', '23505')).toMatch(/SKU/);
    expect(e('sale_already_exists', '23505')).toMatch(/ya tiene una venta/);
    expect(e('only managers can cancel sales', '42501')).toMatch(/anular/);
  });
});
