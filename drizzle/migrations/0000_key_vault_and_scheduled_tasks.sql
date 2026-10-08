CREATE TABLE public.saved_api_keys (
  key_hash text PRIMARY KEY,
  api_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.saved_api_keys TO service_role;
ALTER TABLE public.saved_api_keys ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.scheduled_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_hash text NOT NULL,
  app_id text NOT NULL,
  name text NOT NULL DEFAULT 'Default',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule_enabled boolean NOT NULL DEFAULT false,
  last_run_at timestamptz,
  last_run_status text,
  last_run_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_tasks_owner_idx ON public.scheduled_tasks(owner_hash, app_id);
GRANT ALL ON public.scheduled_tasks TO service_role;
ALTER TABLE public.scheduled_tasks ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER update_scheduled_tasks_updated_at BEFORE UPDATE ON public.scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_saved_api_keys_updated_at BEFORE UPDATE ON public.saved_api_keys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.lcm_data_reset_configs ADD COLUMN owner_hash text, ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.lcm_data_reset_runs ADD COLUMN owner_hash text, ALTER COLUMN user_id DROP NOT NULL;
GRANT ALL ON public.lcm_data_reset_configs TO service_role;
GRANT ALL ON public.lcm_data_reset_runs TO service_role;
DROP POLICY IF EXISTS "Users can delete their own configs" ON public.lcm_data_reset_configs;
DROP POLICY IF EXISTS "Users can insert their own configs" ON public.lcm_data_reset_configs;
DROP POLICY IF EXISTS "Users can update their own configs" ON public.lcm_data_reset_configs;
DROP POLICY IF EXISTS "Users can view their own configs" ON public.lcm_data_reset_configs;
DROP POLICY IF EXISTS "Users can view their own run history" ON public.lcm_data_reset_runs;