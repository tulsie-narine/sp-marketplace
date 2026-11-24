-- PSA Role Sync: maps PSA company team roles (ConnectWise, Autotask) to ScalePad CS
-- client account team roles. Sync settings live in scheduled_tasks (app_id = 'psa-role-sync').
-- These tables hold the PSA connection, a ledger of what the sync assigned, and run history.

-- One PSA connection per ScalePad API key (owner_hash) and PSA type.
-- settings holds the non-secret connection fields, which differ per PSA:
--   connectwise: site, companyId, publicKey, clientId
--   autotask:    username, integrationCode, zoneUrl (looked up from the username)
-- The secret (ConnectWise private key, Autotask API secret) is encrypted by the psa-role-sync
-- edge function (AES-GCM, key in the PSA_CREDENTIALS_KEY function secret) before it is stored.
-- It is never returned to the browser.
CREATE TABLE IF NOT EXISTS public.psa_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_hash TEXT NOT NULL,
  psa_type TEXT NOT NULL CHECK (psa_type IN ('connectwise', 'autotask', 'halo')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_hash, psa_type)
);

-- Every assignment the sync has made. The sync only adds today; this ledger is what a
-- future "remove what the sync added" option would read, so manual CS assignments are never touched.
CREATE TABLE IF NOT EXISTS public.psa_role_sync_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.scheduled_tasks(id) ON DELETE CASCADE,
  owner_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT,
  psa_company_id TEXT,
  psa_member_id TEXT,
  last_status TEXT NOT NULL DEFAULT 'assigned',
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, client_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.psa_role_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.scheduled_tasks(id) ON DELETE CASCADE,
  owner_hash TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'live')),
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT
);

ALTER TABLE public.psa_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.psa_role_sync_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.psa_role_sync_runs ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.psa_connections TO service_role;
GRANT ALL ON public.psa_role_sync_assignments TO service_role;
GRANT ALL ON public.psa_role_sync_runs TO service_role;

CREATE INDEX IF NOT EXISTS psa_role_sync_assignments_task_idx
  ON public.psa_role_sync_assignments(task_id, client_id);
CREATE INDEX IF NOT EXISTS psa_role_sync_runs_task_idx
  ON public.psa_role_sync_runs(task_id, started_at DESC);

DROP TRIGGER IF EXISTS update_psa_connections_updated_at ON public.psa_connections;
CREATE TRIGGER update_psa_connections_updated_at
  BEFORE UPDATE ON public.psa_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_psa_role_sync_assignments_updated_at ON public.psa_role_sync_assignments;
CREATE TRIGGER update_psa_role_sync_assignments_updated_at
  BEFORE UPDATE ON public.psa_role_sync_assignments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Scheduling: run once per environment in the SQL editor, replacing the placeholders.
-- The job fires daily; the function only runs tasks whose sync interval (30 days by default) has passed.
--
--   SELECT cron.schedule(
--     'psa-role-sync-daily',
--     '0 6 * * *',
--     $$ SELECT net.http_post(
--          url := 'https://<project-ref>.supabase.co/functions/v1/psa-role-sync',
--          headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer <service-role-key>'),
--          body := '{"scheduled": true}'::jsonb
--        ); $$
--   );
