REVOKE EXECUTE ON FUNCTION private.resolve_correction_report(uuid, uuid, integer, public.correction_report_status, text, uuid) FROM service_role;
REVOKE EXECUTE ON FUNCTION private.claim_correction_report(uuid, uuid, integer) FROM service_role;
REVOKE EXECUTE ON FUNCTION private.link_listing_correction(uuid, uuid, uuid, uuid, text) FROM service_role;
REVOKE EXECUTE ON FUNCTION private.valid_correction_evidence_urls(text[]) FROM service_role;
REVOKE SELECT, INSERT, UPDATE ON public.correction_reports, public.listing_corrections FROM service_role;
REVOKE SELECT, INSERT, UPDATE, DELETE ON private.correction_report_private,
  private.correction_report_capabilities, private.correction_report_recent_content,
  private.correction_reporter_restrictions FROM service_role;
DROP FUNCTION IF EXISTS private.resolve_correction_report(uuid, uuid, integer, public.correction_report_status, text, uuid);
DROP FUNCTION IF EXISTS private.claim_correction_report(uuid, uuid, integer);
DROP FUNCTION IF EXISTS private.link_listing_correction(uuid, uuid, uuid, uuid, text);
DROP TABLE IF EXISTS private.correction_reporter_restrictions;
DROP TABLE IF EXISTS private.correction_report_recent_content;
DROP TABLE IF EXISTS private.correction_report_capabilities;
ALTER TABLE IF EXISTS public.correction_reports DROP CONSTRAINT IF EXISTS correction_reports_correction_id_fkey;
DROP TABLE IF EXISTS public.listing_corrections;
DROP TABLE IF EXISTS private.correction_report_private;
DROP FUNCTION IF EXISTS private.valid_correction_evidence_urls(text[]);
DROP TABLE IF EXISTS public.correction_reports;
DROP TYPE IF EXISTS public.correction_report_status;
DROP TYPE IF EXISTS public.correction_report_category;
