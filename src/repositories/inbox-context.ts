import type { ServerSupabase } from '@/lib/supabase/server';
import { unwrap } from '@/lib/errors';
import type { ActivityRow, CustomerRow, FieldDefinition, IdentifierRow, SaleRow, TagRow, TaskRow } from '@/lib/types';
import { getCustomer, getCustomersByIds, listIdentifiers } from './customers';
import { listActivities } from './activities';
import { listSales } from './sales';
import { listTasks } from './tasks';
import { listFieldDefinitions } from './custom-fields';
import { tagsByCustomer } from './inbox';

export interface ProductLine { name: string; quantity: number }

export interface CustomerContext {
  customer: CustomerRow;
  identifiers: IdentifierRow[];
  company: { id: string; fullName: string } | null;
  tags: TagRow[];
  sales: { items: SaleRow[]; total: number; count: number };
  tasks: TaskRow[];
  notes: ActivityRow[];                 // todas (hasta 100): el hilo las necesita; la ficha muestra las últimas 5
  noteCount: number;
  products: ProductLine[];
  fieldDefs: FieldDefinition[];
}

/** Junta por nombre las líneas de las ventas del cliente (suma de cantidades), de mayor a menor. */
export function aggregateProducts(lines: { description: string; quantity: number }[], max = 8): ProductLine[] {
  const acc = new Map<string, number>();
  for (const l of lines) {
    const key = l.description.trim();
    if (key) acc.set(key, (acc.get(key) ?? 0) + Number(l.quantity));
  }
  return [...acc.entries()].map(([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'es')).slice(0, max);
}

/**
 * Todo lo que el panel derecho muestra de un cliente. Solo lecturas con la sesión de la persona (RLS):
 * si no puede ver ventas, tareas o notas, esas secciones simplemente vienen vacías.
 */
export async function loadCustomerContext(db: ServerSupabase, orgId: string, customerId: string): Promise<CustomerContext | null> {
  const customer = await getCustomer(db, customerId);
  if (!customer) return null;
  const [identifiers, tagMap, salesPage, tasks, activities, fieldDefs, companies] = await Promise.all([
    listIdentifiers(db, [customerId]),
    tagsByCustomer(db, [customerId]),
    listSales(db, { orgId, customerId, limit: 50 }),
    listTasks(db, { orgId, customerId, status: 'open', limit: 50 }),
    listActivities(db, { customerId, limit: 100 }),
    listFieldDefinitions(db, orgId, 'customer'),
    customer.companyId ? getCustomersByIds(db, [customer.companyId]) : Promise.resolve([] as CustomerRow[]),
  ]);

  const live = salesPage.items.filter((s) => s.status !== 'cancelled');
  let products: ProductLine[] = [];
  if (live.length > 0) {
    const rows = unwrap(await db.from('sale_items').select('description, quantity').in('sale_id', live.map((s) => s.id)).limit(500)) as unknown as { description: string; quantity: number }[];
    products = aggregateProducts(rows);
  }
  const allNotes = activities.filter((a) => a.type === 'note');
  return {
    customer, identifiers, tags: tagMap.get(customerId) ?? [],
    company: companies[0] ? { id: companies[0].id, fullName: companies[0].fullName } : null,
    sales: { items: salesPage.items.slice(0, 5), total: live.reduce((n, s) => n + s.total, 0), count: salesPage.items.length },
    tasks, notes: allNotes, noteCount: allNotes.length, products, fieldDefs,
  };
}
