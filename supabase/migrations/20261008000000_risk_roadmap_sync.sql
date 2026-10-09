-- Durable reconciliation state for the ControlMap to LMX Workstream Sync.
-- API keys remain in saved_api_keys; these tables only store sync metadata.

CREATE TABLE IF NOT EXISTS public.saved_api_keys (
  key_hash TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.scheduled_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_hash TEXT NOT NULL,
  app_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Default',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule_enabled BOOLEAN NOT NULL DEFAULT false,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  last_run_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT ALL ON public.saved_api_keys TO service_role;
GRANT ALL ON public.scheduled_tasks TO service_role;

CREATE TABLE IF NOT EXISTS public.roadmap_sync_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES public.scheduled_tasks(id) ON DELETE CASCADE,
  owner_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('action_items', 'risks')),
  source_id TEXT NOT NULL,
  source_code TEXT,
  initiative_id TEXT,
  source_fingerprint TEXT,
  retired BOOLEAN NOT NULL DEFAULT false,
  last_status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, client_id, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS public.roadmap_sync_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES public.scheduled_tasks(id) ON DELETE CASCADE,
  owner_hash TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'live')),
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT
);

ALTER TABLE public.roadmap_sync_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roadmap_sync_runs ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.roadmap_sync_items TO service_role;
GRANT ALL ON public.roadmap_sync_runs TO service_role;

CREATE INDEX IF NOT EXISTS roadmap_sync_items_task_idx
  ON public.roadmap_sync_items(task_id, client_id, source_type);
CREATE INDEX IF NOT EXISTS roadmap_sync_runs_task_idx
  ON public.roadmap_sync_runs(task_id, started_at DESC);

DROP TRIGGER IF EXISTS update_saved_api_keys_updated_at ON public.saved_api_keys;
CREATE TRIGGER update_saved_api_keys_updated_at
  BEFORE UPDATE ON public.saved_api_keys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_scheduled_tasks_updated_at ON public.scheduled_tasks;
CREATE TRIGGER update_scheduled_tasks_updated_at
  BEFORE UPDATE ON public.scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_roadmap_sync_items_updated_at ON public.roadmap_sync_items;
CREATE TRIGGER update_roadmap_sync_items_updated_at
  BEFORE UPDATE ON public.roadmap_sync_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
