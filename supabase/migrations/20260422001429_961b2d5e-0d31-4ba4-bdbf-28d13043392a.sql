-- Saved LCM Data Reset configs (per-user, private)
CREATE TABLE public.lcm_data_reset_configs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL DEFAULT 'Default',
  destination_api_key TEXT NOT NULL,
  source_client_id TEXT NOT NULL,
  source_client_name TEXT NOT NULL,
  destination_client_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  destination_client_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_objects JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule_enabled BOOLEAN NOT NULL DEFAULT false,
  last_run_at TIMESTAMPTZ,
  last_run_status TEXT,
  last_run_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.lcm_data_reset_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own configs"
  ON public.lcm_data_reset_configs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own configs"
  ON public.lcm_data_reset_configs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own configs"
  ON public.lcm_data_reset_configs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own configs"
  ON public.lcm_data_reset_configs FOR DELETE
  USING (auth.uid() = user_id);

-- timestamp trigger fn (idempotent create)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_lcm_data_reset_configs_updated_at
  BEFORE UPDATE ON public.lcm_data_reset_configs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_lcm_data_reset_configs_user ON public.lcm_data_reset_configs(user_id);
CREATE INDEX idx_lcm_data_reset_configs_schedule ON public.lcm_data_reset_configs(schedule_enabled) WHERE schedule_enabled = true;

-- Run log table for visibility
CREATE TABLE public.lcm_data_reset_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  config_id UUID NOT NULL REFERENCES public.lcm_data_reset_configs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  total_deleted INTEGER NOT NULL DEFAULT 0,
  total_created INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  details JSONB,
  error_message TEXT
);

ALTER TABLE public.lcm_data_reset_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own run history"
  ON public.lcm_data_reset_runs FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX idx_lcm_data_reset_runs_config ON public.lcm_data_reset_runs(config_id, started_at DESC);

-- Enable cron extensions
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;