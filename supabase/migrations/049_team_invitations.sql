-- Add 'readonly' to user_profiles role check constraint
ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_role_check
  CHECK (role IN ('super_admin', 'org_admin', 'venue_manager', 'coordinator', 'couple', 'readonly'));

-- Team Invitations — invite team members to org/venue
CREATE TABLE IF NOT EXISTS team_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id),
  venue_id uuid REFERENCES venues(id),  -- null = org-level invite
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('org_admin', 'venue_manager', 'coordinator', 'readonly')),
  invited_by uuid REFERENCES auth.users(id),
  token text UNIQUE NOT NULL,  -- for the invite link
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_team_invitations_token ON team_invitations(token);
CREATE INDEX idx_team_invitations_org ON team_invitations(org_id);
CREATE INDEX idx_team_invitations_email ON team_invitations(email);

-- RLS
ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_invitations" ON team_invitations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_select_invitations" ON team_invitations FOR SELECT TO anon USING (true);
