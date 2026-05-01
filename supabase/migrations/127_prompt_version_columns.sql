-- Migration 127: prompt_version columns on api_costs + drafts (T1-E)
--
-- Per Playbook OPS-21.5.1 / BUILD-PLAN T1-E: every LLM call must log
-- which prompt revision produced its output. Pre-migration api_costs
-- captured model + tokens + cost but no prompt version, so a prompt
-- regression after a quiet edit had no audit trail. drafts had the
-- same gap on the output side — a coordinator looking at a flagged
-- draft couldn't tell which prompt produced it.
--
-- Each prompt module exports a BRAIN_PROMPT_VERSION constant
-- (e.g. 'inquiry-brain.prompt.v1.0'). callAI threads the version
-- through to logUsage. Brain callers stamp drafts.prompt_version_used
-- on insert. Bumping a prompt module's version on edit is a
-- contributor responsibility — see PROMPTS-CHANGELOG.md at the repo
-- root for the per-prompt history.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE api_costs
  ADD COLUMN IF NOT EXISTS prompt_version text;

ALTER TABLE drafts
  ADD COLUMN IF NOT EXISTS prompt_version_used text;

COMMENT ON COLUMN api_costs.prompt_version IS
  'Prompt revision identifier provided by the caller, e.g. '
  '''inquiry-brain.prompt.v1.0''. Each brain module exports a '
  'BRAIN_PROMPT_VERSION constant; callers thread it through to '
  'callAI. NULL is permitted for legacy / non-brain callers but '
  'every brain call should set this. Per Playbook OPS-21.5.1 / T1-E.';

COMMENT ON COLUMN drafts.prompt_version_used IS
  'Prompt revision that produced this draft. Populated at insert '
  'time by the brain caller. Lets coordinators reviewing a '
  'flagged draft tell whether a recent prompt edit caused the '
  'regression. Per BUILD-PLAN T1-E.';

CREATE INDEX IF NOT EXISTS idx_api_costs_prompt_version
  ON api_costs (prompt_version)
  WHERE prompt_version IS NOT NULL;
