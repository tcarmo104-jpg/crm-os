import { describe, expect, it, vi } from 'vitest';
import type { DomainEvent } from './dispatcher';

vi.mock('server-only', () => ({}));

const ev = (overrides: Partial<DomainEvent> = {}): DomainEvent => ({
  id: 'ev-1', org_id: 'org-1', type: 'lead.created', entity_type: 'lead', entity_id: 'lead-1', customer_id: 'cust-1',
  payload: { source: 'feria' }, actor_id: null, occurred_at: new Date().toISOString(), attempts: 1, ...overrides,
});

function mockAdmin(rules: { id: string }[]) {
  const rpcCalls: { fn: string; args: unknown }[] = [];
  const client = {
    from: (table: string) => {
      expect(table).toBe('automation_rules');
      const chain = {
        select: () => chain, eq: () => chain,
        then: (resolve: (v: { data: typeof rules; error: null }) => void) => resolve({ data: rules, error: null }),
      };
      return chain;
    },
    rpc: vi.fn(async (fn: string, args: unknown) => { rpcCalls.push({ fn, args }); return { data: {}, error: null }; }),
  };
  return { client, rpcCalls };
}

vi.mock('@/server/supabase-admin', () => ({ createAdminClient: vi.fn() }));

describe('runAutomations: encuentra las reglas activas de la organización del evento y las ejecuta', () => {
  it('llama run_automation_rule una vez por cada regla encontrada, con el evento correcto', async () => {
    const { client, rpcCalls } = mockAdmin([{ id: 'rule-1' }, { id: 'rule-2' }]);
    const { createAdminClient } = await import('@/server/supabase-admin');
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { runAutomations } = await import('./automation-handler');

    await runAutomations(ev());

    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0]).toEqual({ fn: 'run_automation_rule', args: {
      p_rule_id: 'rule-1', p_event_id: 'ev-1',
      p_event: { customer_id: 'cust-1', entity_type: 'lead', entity_id: 'lead-1', payload: { source: 'feria' } },
    } });
    expect(rpcCalls[1]!.args).toMatchObject({ p_rule_id: 'rule-2' });
  });

  it('sin reglas activas para ese disparador, no llama a run_automation_rule', async () => {
    const { client, rpcCalls } = mockAdmin([]);
    const { createAdminClient } = await import('@/server/supabase-admin');
    vi.mocked(createAdminClient).mockReturnValue(client as never);
    const { runAutomations } = await import('./automation-handler');

    await runAutomations(ev());
    expect(rpcCalls).toHaveLength(0);
  });
});
