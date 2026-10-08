CREATE TABLE private.operator_presence (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.operator_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.operator_presence FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON private.operator_presence TO service_role;
