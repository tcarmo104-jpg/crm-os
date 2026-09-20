export type Scope = 'own' | 'team' | 'org';

export type MembershipStatus = 'invited' | 'active' | 'suspended';

/** Roles que pueden asignarse por invitación (super_admin se promueve, no se invita). */
export const INVITABLE_ROLES = [
  'admin',
  'manager',
  'sales_manager',
  'sales_agent',
  'marketing',
  'customer_service',
  'analyst',
  'viewer',
] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export interface OrgMembership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  orgTimezone: string;
  orgLocale: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  teamId: string | null;
}

export interface SessionContext {
  user: { id: string; email: string; fullName: string | null };
  memberships: OrgMembership[];
  active: OrgMembership | null;
  permissions: Record<string, Scope>;
}

export interface RoleRow { id: string; key: string; name: string }
export interface TeamRow { id: string; name: string; region: string | null }

export interface MemberRow {
  membershipId: string;
  userId: string;
  fullName: string | null;
  email: string | null;
  roleId: string;
  roleKey: string;
  roleName: string;
  teamId: string | null;
  status: MembershipStatus;
}

export interface PendingInvitationRow {
  id: string;
  email: string;
  roleName: string;
  teamId: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface InvitationPreview {
  orgName: string;
  roleName: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

// ---------------------------------------------------------------------------
// Fase 2: clientes, leads, identidad
// ---------------------------------------------------------------------------
export type CustomerType = 'person' | 'company';
export type PreferredChannel = 'whatsapp' | 'phone' | 'email' | 'instagram' | 'facebook';

export interface CustomerRow {
  id: string;
  orgId: string;
  type: CustomerType;
  fullName: string;
  companyId: string | null;
  ownerId: string | null;
  teamId: string | null;
  city: string | null;
  country: string | null;
  address: string | null;
  preferredChannel: PreferredChannel | null;
  lifecycleStage: string;
  doNotContact: boolean;
  dncReason: string | null;
  dncAt: string | null;
  customFields: Record<string, unknown>;
  firstContactAt: string;
  createdAt: string;
}

export interface IdentifierRow { id: string; customerId: string; type: string; value: string; source: string | null }

export type LeadResolution = 'created' | 'matched' | 'review' | 'conflict';
export interface LeadRow {
  id: string;
  customerId: string;
  ownerId: string | null;
  status: string;
  source: string;
  channel: string | null;
  campaign: string | null;
  productInterest: string | null;
  resolution: LeadResolution;
  receivedAt: string;
}

export interface TimelineEvent {
  id: string;
  type: string;
  occurredAt: string;
  actorId: string | null;
  payload: Record<string, unknown>;
}

export type ReviewKind = 'possible_duplicate' | 'identifier_conflict' | 'duplicate_attempt';
export interface ReviewRow {
  id: string;
  kind: ReviewKind;
  customerId: string;
  candidateId: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export type FieldType = 'text' | 'number' | 'date' | 'select' | 'multi_select' | 'boolean' | 'currency' | 'url' | 'phone' | 'email';
export type FieldEntity = 'customer' | 'lead' | 'opportunity';
export interface FieldDefinition {
  id: string;
  entity: FieldEntity;
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  position: number;
  archivedAt: string | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  rateLimitPerMin: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Page<T> { items: T[]; nextCursor: string | null }

// ---------------------------------------------------------------------------
// Fase 3: pipelines, oportunidades, tareas, actividades
// ---------------------------------------------------------------------------
export type StageKind = 'open' | 'won' | 'lost';
export interface StageRow {
  id: string; pipelineId: string; name: string; kind: StageKind; position: number; probability: number; archivedAt: string | null;
}
export interface PipelineRow { id: string; name: string; isDefault: boolean; archivedAt: string | null; stages: StageRow[] }

export type OpportunityStatus = 'open' | 'won' | 'lost';
export interface OpportunityRow {
  id: string; customerId: string; pipelineId: string; stageId: string; title: string; amount: number; currency: string | null;
  expectedCloseDate: string | null; productInterest: string | null; status: OpportunityStatus; lostReason: string | null;
  closedAt: string | null; ownerId: string | null; customFields: Record<string, unknown>; createdAt: string;
  number: string; priority: 'high' | 'medium' | 'low'; temperature: 'hot' | 'warm' | 'cold' | null; channel: string | null; conversationId: string | null;
}

export interface TransitionRow {
  id: string; entityType: 'lead' | 'opportunity' | 'quote' | 'sale' | 'case'; entityId: string; fromState: string | null; toState: string;
  actorId: string | null; source: string; reason: string | null; occurredAt: string;
}

export type TaskStatus = 'open' | 'done' | 'cancelled';
export interface TaskRow {
  id: string; title: string; description: string | null; type: string; priority: string; dueAt: string | null; status: TaskStatus;
  assigneeId: string | null; customerId: string | null; opportunityId: string | null; outcome: string | null;
  completedAt: string | null; createdAt: string;
}

export interface ActivityRow {
  id: string; customerId: string; opportunityId: string | null; type: string; direction: string | null;
  summary: string; occurredAt: string; createdBy: string | null;
}

// ---------------------------------------------------------------------------
// Fase 4: catálogo, cotizaciones, ventas, casos
// ---------------------------------------------------------------------------
export interface ProductRow {
  id: string; kind: 'product' | 'service'; sku: string | null; name: string; description: string | null;
  unit: string; unitPrice: number; taxRate: number; active: boolean;
}

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'superseded';
export interface QuoteRow {
  id: string; number: string; version: number; opportunityId: string; customerId: string; status: QuoteStatus;
  currency: string | null; validUntil: string | null; notes: string | null; subtotal: number; discountTotal: number;
  taxTotal: number; total: number; maxDiscountPct: number; ownerId: string | null; sentAt: string | null; createdAt: string;
}
export interface LineItem {
  id: string; position: number; productId: string | null; description: string; unit: string; quantity: number;
  unitPrice: number; discountPct: number; taxRate: number; lineGross: number; lineDiscount: number; lineTax: number; lineTotal: number;
}

export type SaleStatus = 'confirmed' | 'delivered' | 'cancelled';
export interface SaleRow {
  id: string; number: string; customerId: string; opportunityId: string; quoteId: string; status: SaleStatus;
  currency: string | null; subtotal: number; discountTotal: number; taxTotal: number; total: number;
  soldAt: string; deliveredAt: string | null; cancelledAt: string | null; cancelReason: string | null; ownerId: string | null;
}

export type CaseStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export interface CaseRow {
  id: string; number: string; customerId: string; saleId: string | null; kind: string; priority: string; status: CaseStatus;
  title: string; description: string | null; resolution: string | null; assigneeId: string | null; createdAt: string;
}

// ---------------------------------------------------------------------------
// Fase 5: bandeja (WhatsApp)
// ---------------------------------------------------------------------------
export interface ChannelRow { id: string; kind: 'whatsapp'; name: string; externalId: string; displayPhone: string | null; status: 'active' | 'paused' }
export interface TemplateRow { id: string; channelId: string; name: string; language: string; body: string; paramCount: number; status: 'approved' | 'disabled' }
export interface ConversationRow {
  id: string; channelId: string; customerId: string; threadKey: string; contactName: string | null; status: 'open' | 'closed';
  ownerId: string | null; lastMessageAt: string | null; lastInboundAt: string | null; lastMessagePreview: string | null;
  lastDirection: 'inbound' | 'outbound' | null; needsReply: boolean; unread: boolean; unreadCount: number;
}
export type MessageStatus = 'received' | 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
export interface MessageRow {
  id: string; direction: 'inbound' | 'outbound'; kind: 'text' | 'template' | 'media' | 'other'; body: string; status: MessageStatus;
  error: string | null; errorCode: string | null; sentBy: string | null; occurredAt: string; meta: Record<string, unknown>;
}

export type TagColor = 'violet' | 'blue' | 'teal' | 'green' | 'yellow' | 'orange' | 'red' | 'pink' | 'gray';
export interface TagRow { id: string; name: string; color: TagColor }
export interface QuickReplyRow { id: string; title: string; body: string }
