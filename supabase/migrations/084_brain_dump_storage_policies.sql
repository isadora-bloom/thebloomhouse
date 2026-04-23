-- ---------------------------------------------------------------------------
-- 084_brain_dump_storage_policies.sql
-- ---------------------------------------------------------------------------
-- The brain-dump storage bucket was created alongside Phase 2.5 Task 26 but
-- its storage.objects RLS policies were never added. Every other bucket
-- (contracts, couple-photos, inspo-gallery, vendor-contracts, venue-assets)
-- has auth_insert_* / auth_select_* / auth_update_* / auth_delete_* policies.
-- brain-dump is the odd one out: authenticated coordinators hit "new row
-- violates row-level security policy" when the FloatingBrainDump component
-- tries to upload a file via the browser Supabase client.
--
-- This migration adds the four CRUD policies for authenticated users,
-- scoped to bucket_id='brain-dump'. Matches the pattern established by
-- migration 028 for the other private buckets. Service role (server-side
-- processing) bypasses RLS and is unchanged.
--
-- The brain-dump bucket is private (public=false) so no anon policies are
-- added — only authenticated coordinators can read/write their venue's
-- uploads. Path convention is {venueId}/{uuid}-{safeName} (see
-- src/components/shell/floating-brain-dump.tsx). Per-venue scoping via
-- the path prefix is a future tightening — for now, belonging to the
-- platform is sufficient (auth role + no anon).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "auth_insert_brain_dump" ON storage.objects;
CREATE POLICY "auth_insert_brain_dump" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'brain-dump');

DROP POLICY IF EXISTS "auth_select_brain_dump" ON storage.objects;
CREATE POLICY "auth_select_brain_dump" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'brain-dump');

DROP POLICY IF EXISTS "auth_update_brain_dump" ON storage.objects;
CREATE POLICY "auth_update_brain_dump" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'brain-dump')
  WITH CHECK (bucket_id = 'brain-dump');

DROP POLICY IF EXISTS "auth_delete_brain_dump" ON storage.objects;
CREATE POLICY "auth_delete_brain_dump" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'brain-dump');
