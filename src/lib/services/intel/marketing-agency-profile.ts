/**
 * Bloom House — Wave 6E depth (mig 306).
 *
 * CRUD for the four profile-depth tables that hang off marketing_agencies:
 *   - agency_contacts          (multiple humans at the agency)
 *   - agency_documents         (contracts / reports / statements)
 *   - agency_kpi_commitments   (what the agency promised)
 *   - agency_activity_log      (timeline of decisions)
 *
 * Service-role client throughout — RLS on marketing_agencies already
 * gates visibility upstream via the API layer.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ===========================================================================
// Contacts
// ===========================================================================

export interface AgencyContactRow {
  id: string
  agencyId: string
  name: string
  email: string | null
  phone: string | null
  role: string | null
  notes: string | null
  isPrimary: boolean
  createdAt: string
  updatedAt: string
}

interface ContactRowFromDb {
  id: string
  agency_id: string
  name: string
  email: string | null
  phone: string | null
  role: string | null
  notes: string | null
  is_primary: boolean
  created_at: string
  updated_at: string
}

function rowToContact(row: ContactRowFromDb): AgencyContactRow {
  return {
    id: row.id,
    agencyId: row.agency_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    notes: row.notes,
    isPrimary: row.is_primary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listContacts(agencyId: string): Promise<AgencyContactRow[]> {
  const service = createServiceClient()
  const { data } = await service
    .from('agency_contacts')
    .select('*')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('is_primary', { ascending: false })
    .order('name', { ascending: true })
  return (data ?? []).map((r) => rowToContact(r as ContactRowFromDb))
}

export interface CreateContactInput {
  agencyId: string
  name: string
  email?: string | null
  phone?: string | null
  role?: string | null
  notes?: string | null
  isPrimary?: boolean
}

export async function createContact(
  input: CreateContactInput,
): Promise<AgencyContactRow> {
  if (!input.name.trim()) throw new Error('contact name required')
  const service = createServiceClient()

  // If isPrimary, clear other primary flags first (partial unique index
  // would otherwise reject).
  if (input.isPrimary) {
    await service
      .from('agency_contacts')
      .update({ is_primary: false })
      .eq('agency_id', input.agencyId)
      .eq('is_primary', true)
      .is('deleted_at', null)
  }

  const { data, error } = await service
    .from('agency_contacts')
    .insert({
      agency_id: input.agencyId,
      name: input.name.trim(),
      email: input.email ?? null,
      phone: input.phone ?? null,
      role: input.role ?? null,
      notes: input.notes ?? null,
      is_primary: input.isPrimary ?? false,
    })
    .select('*')
    .single()
  if (error) throw new Error(`create contact failed: ${error.message}`)
  return rowToContact(data as ContactRowFromDb)
}

export async function updateContact(
  contactId: string,
  patch: Partial<Omit<CreateContactInput, 'agencyId'>>,
): Promise<AgencyContactRow> {
  const service = createServiceClient()

  if (patch.isPrimary) {
    // Clear other primary flags for this agency.
    const { data: existing } = await service
      .from('agency_contacts')
      .select('agency_id')
      .eq('id', contactId)
      .maybeSingle()
    if (existing?.agency_id) {
      await service
        .from('agency_contacts')
        .update({ is_primary: false })
        .eq('agency_id', existing.agency_id)
        .eq('is_primary', true)
        .is('deleted_at', null)
        .neq('id', contactId)
    }
  }

  const update: Record<string, unknown> = {}
  if (patch.name !== undefined) update.name = patch.name.trim()
  if (patch.email !== undefined) update.email = patch.email
  if (patch.phone !== undefined) update.phone = patch.phone
  if (patch.role !== undefined) update.role = patch.role
  if (patch.notes !== undefined) update.notes = patch.notes
  if (patch.isPrimary !== undefined) update.is_primary = patch.isPrimary

  const { data, error } = await service
    .from('agency_contacts')
    .update(update)
    .eq('id', contactId)
    .select('*')
    .single()
  if (error) throw new Error(`update contact failed: ${error.message}`)
  return rowToContact(data as ContactRowFromDb)
}

export async function softDeleteContact(contactId: string): Promise<void> {
  const service = createServiceClient()
  const { error } = await service
    .from('agency_contacts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', contactId)
  if (error) throw new Error(`delete contact failed: ${error.message}`)
}

// ===========================================================================
// Documents
// ===========================================================================

export interface AgencyDocumentRow {
  id: string
  agencyId: string
  engagementId: string | null
  name: string
  fileUrl: string | null
  fileSizeBytes: number | null
  mimeType: string | null
  kind: string | null
  effectiveDate: string | null
  expiresAt: string | null
  notes: string | null
  uploadedBy: string | null
  createdAt: string
  updatedAt: string
}

interface DocumentRowFromDb {
  id: string
  agency_id: string
  engagement_id: string | null
  name: string
  file_url: string | null
  file_size_bytes: number | null
  mime_type: string | null
  kind: string | null
  effective_date: string | null
  expires_at: string | null
  notes: string | null
  uploaded_by: string | null
  created_at: string
  updated_at: string
}

function rowToDocument(row: DocumentRowFromDb): AgencyDocumentRow {
  return {
    id: row.id,
    agencyId: row.agency_id,
    engagementId: row.engagement_id,
    name: row.name,
    fileUrl: row.file_url,
    fileSizeBytes: row.file_size_bytes,
    mimeType: row.mime_type,
    kind: row.kind,
    effectiveDate: row.effective_date,
    expiresAt: row.expires_at,
    notes: row.notes,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listDocuments(agencyId: string): Promise<AgencyDocumentRow[]> {
  const service = createServiceClient()
  const { data } = await service
    .from('agency_documents')
    .select('*')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  return (data ?? []).map((r) => rowToDocument(r as DocumentRowFromDb))
}

export interface CreateDocumentInput {
  agencyId: string
  engagementId?: string | null
  name: string
  fileUrl?: string | null
  fileSizeBytes?: number | null
  mimeType?: string | null
  kind?: string | null
  effectiveDate?: string | null
  expiresAt?: string | null
  notes?: string | null
  uploadedBy?: string | null
}

export async function createDocument(
  input: CreateDocumentInput,
): Promise<AgencyDocumentRow> {
  if (!input.name.trim()) throw new Error('document name required')
  const service = createServiceClient()
  const { data, error } = await service
    .from('agency_documents')
    .insert({
      agency_id: input.agencyId,
      engagement_id: input.engagementId ?? null,
      name: input.name.trim(),
      file_url: input.fileUrl ?? null,
      file_size_bytes: input.fileSizeBytes ?? null,
      mime_type: input.mimeType ?? null,
      kind: input.kind ?? null,
      effective_date: input.effectiveDate ?? null,
      expires_at: input.expiresAt ?? null,
      notes: input.notes ?? null,
      uploaded_by: input.uploadedBy ?? null,
    })
    .select('*')
    .single()
  if (error) throw new Error(`create document failed: ${error.message}`)
  return rowToDocument(data as DocumentRowFromDb)
}

export async function softDeleteDocument(documentId: string): Promise<void> {
  const service = createServiceClient()
  const { error } = await service
    .from('agency_documents')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', documentId)
  if (error) throw new Error(`delete document failed: ${error.message}`)
}

// ===========================================================================
// KPI commitments
// ===========================================================================

export interface AgencyKpiRow {
  id: string
  agencyId: string
  engagementId: string | null
  metricName: string
  targetValue: number
  targetUnit: string
  targetWindow: string
  notes: string | null
  effectiveFrom: string
  effectiveTo: string | null
  createdAt: string
}

interface KpiRowFromDb {
  id: string
  agency_id: string
  engagement_id: string | null
  metric_name: string
  target_value: number | string
  target_unit: string
  target_window: string
  notes: string | null
  effective_from: string
  effective_to: string | null
  created_at: string
}

function rowToKpi(row: KpiRowFromDb): AgencyKpiRow {
  return {
    id: row.id,
    agencyId: row.agency_id,
    engagementId: row.engagement_id,
    metricName: row.metric_name,
    targetValue: Number(row.target_value),
    targetUnit: row.target_unit,
    targetWindow: row.target_window,
    notes: row.notes,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
  }
}

export async function listKpis(
  agencyId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<AgencyKpiRow[]> {
  const service = createServiceClient()
  let q = service
    .from('agency_kpi_commitments')
    .select('*')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('effective_from', { ascending: false })
  if (opts.activeOnly) q = q.is('effective_to', null)
  const { data } = await q
  return (data ?? []).map((r) => rowToKpi(r as KpiRowFromDb))
}

export interface CreateKpiInput {
  agencyId: string
  engagementId?: string | null
  metricName: string
  targetValue: number
  targetUnit?: string
  targetWindow?: string
  notes?: string | null
  effectiveFrom?: string
}

export async function createKpi(input: CreateKpiInput): Promise<AgencyKpiRow> {
  if (!input.metricName.trim()) throw new Error('metricName required')
  if (!Number.isFinite(input.targetValue)) {
    throw new Error('targetValue must be a finite number')
  }
  const service = createServiceClient()
  const { data, error } = await service
    .from('agency_kpi_commitments')
    .insert({
      agency_id: input.agencyId,
      engagement_id: input.engagementId ?? null,
      metric_name: input.metricName.trim(),
      target_value: input.targetValue,
      target_unit: input.targetUnit ?? 'count',
      target_window: input.targetWindow ?? 'month',
      notes: input.notes ?? null,
      effective_from: input.effectiveFrom ?? new Date().toISOString().slice(0, 10),
    })
    .select('*')
    .single()
  if (error) throw new Error(`create kpi failed: ${error.message}`)
  return rowToKpi(data as KpiRowFromDb)
}

export async function retireKpi(kpiId: string, endedAt?: string): Promise<AgencyKpiRow> {
  const service = createServiceClient()
  const end = endedAt ?? new Date().toISOString().slice(0, 10)
  const { data, error } = await service
    .from('agency_kpi_commitments')
    .update({ effective_to: end })
    .eq('id', kpiId)
    .select('*')
    .single()
  if (error) throw new Error(`retire kpi failed: ${error.message}`)
  return rowToKpi(data as KpiRowFromDb)
}

export async function softDeleteKpi(kpiId: string): Promise<void> {
  const service = createServiceClient()
  const { error } = await service
    .from('agency_kpi_commitments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', kpiId)
  if (error) throw new Error(`delete kpi failed: ${error.message}`)
}

// ===========================================================================
// Activity log
// ===========================================================================

export interface AgencyActivityRow {
  id: string
  agencyId: string
  engagementId: string | null
  venueId: string | null
  occurredAt: string
  kind: string
  summary: string
  body: string | null
  payload: Record<string, unknown>
  recordedBy: string | null
  createdAt: string
}

interface ActivityRowFromDb {
  id: string
  agency_id: string
  engagement_id: string | null
  venue_id: string | null
  occurred_at: string
  kind: string
  summary: string
  body: string | null
  payload: unknown
  recorded_by: string | null
  created_at: string
}

function rowToActivity(row: ActivityRowFromDb): AgencyActivityRow {
  return {
    id: row.id,
    agencyId: row.agency_id,
    engagementId: row.engagement_id,
    venueId: row.venue_id,
    occurredAt: row.occurred_at,
    kind: row.kind,
    summary: row.summary,
    body: row.body,
    payload:
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {},
    recordedBy: row.recorded_by,
    createdAt: row.created_at,
  }
}

export async function listActivity(
  agencyId: string,
  opts: { limit?: number } = {},
): Promise<AgencyActivityRow[]> {
  const service = createServiceClient()
  const { data } = await service
    .from('agency_activity_log')
    .select('*')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('occurred_at', { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 500))
  return (data ?? []).map((r) => rowToActivity(r as ActivityRowFromDb))
}

export interface CreateActivityInput {
  agencyId: string
  engagementId?: string | null
  venueId?: string | null
  occurredAt?: string
  kind?: string
  summary: string
  body?: string | null
  payload?: Record<string, unknown>
  recordedBy?: string | null
}

export async function createActivity(
  input: CreateActivityInput,
): Promise<AgencyActivityRow> {
  if (!input.summary.trim()) throw new Error('summary required')
  const service = createServiceClient()
  const { data, error } = await service
    .from('agency_activity_log')
    .insert({
      agency_id: input.agencyId,
      engagement_id: input.engagementId ?? null,
      venue_id: input.venueId ?? null,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
      kind: input.kind ?? 'note',
      summary: input.summary.trim(),
      body: input.body ?? null,
      payload: input.payload ?? {},
      recorded_by: input.recordedBy ?? null,
    })
    .select('*')
    .single()
  if (error) throw new Error(`create activity failed: ${error.message}`)
  return rowToActivity(data as ActivityRowFromDb)
}

export async function softDeleteActivity(activityId: string): Promise<void> {
  const service = createServiceClient()
  const { error } = await service
    .from('agency_activity_log')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', activityId)
  if (error) throw new Error(`delete activity failed: ${error.message}`)
}
