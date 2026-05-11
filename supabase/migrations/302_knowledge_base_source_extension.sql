-- ---------------------------------------------------------------------------
-- 302_knowledge_base_source_extension.sql  (live-customer fix 2026-05-11)
-- ---------------------------------------------------------------------------
-- The brain-dump "Send to Sage" path (/api/brain-dump/[id]/resolve) writes
-- knowledge_base rows with source='brain_dump_confirmed' to preserve
-- provenance — but the original CHECK constraint from migration 033 only
-- allowed ('manual', 'auto-learned', 'csv'), so every brain-dump-driven
-- KB insert was failing with:
--
--   new row for relation "knowledge_base" violates check constraint
--   "knowledge_base_source_check"
--
-- Live-customer 2026-05-11: Isadora hit this trying to add a calculator
-- rule note ("when replying to inquiries that submitted a calculator it
-- needs to not assume there are overnights unless overnights are listed
-- on the calculator").
--
-- Fix: extend the CHECK to include 'brain_dump_confirmed'. We also add
-- 'content_suggester' so the Wave 26 / Stream 6 USP + seasonal-content
-- suggester (which doesn't write KB today but plausibly will) has a
-- ready-to-use provenance tag — avoids another constraint extension on
-- the same column in two weeks.
--
-- Provenance values now allowed:
--   manual                — coordinator typed it in /portal/kb
--   auto-learned          — Sage queue resolution promoted Q+A
--   csv                   — bulk CSV import (data-import.ts paths)
--   brain_dump_confirmed  — brain-dump propose-and-confirm flow
--   content_suggester     — Sonnet-suggested entry from venue website
-- ---------------------------------------------------------------------------

ALTER TABLE knowledge_base DROP CONSTRAINT IF EXISTS knowledge_base_source_check;

ALTER TABLE knowledge_base
  ADD CONSTRAINT knowledge_base_source_check
  CHECK (source IN (
    'manual',
    'auto-learned',
    'csv',
    'brain_dump_confirmed',
    'content_suggester'
  ));

COMMENT ON COLUMN knowledge_base.source IS
  'Provenance tag for the KB entry. manual = coordinator typed in /portal/kb. auto-learned = Sage queue resolution. csv = data-import bulk. brain_dump_confirmed = brain-dump propose-and-confirm flow (2026-05-11). content_suggester = Sonnet pull-from-website (Stream 6).';

NOTIFY pgrst, 'reload schema';
