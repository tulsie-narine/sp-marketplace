-- saved_api_keys and scheduled_tasks were created without row level security.
-- Supabase grants the anon role access to new tables in the public schema, so
-- PostgREST exposes both to anyone holding the publishable key, and that key
-- ships in the browser bundle. saved_api_keys.api_key holds ScalePad API keys
-- in plaintext.
--
-- The edge functions reach these tables with the service role, which bypasses
-- row level security, so enabling it with no policies shuts out every other
-- role and leaves the functions working.

ALTER TABLE public.saved_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_tasks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.saved_api_keys FROM anon, authenticated;
REVOKE ALL ON public.scheduled_tasks FROM anon, authenticated;
