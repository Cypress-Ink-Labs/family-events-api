DROP TRIGGER reject_deleted_user_access ON public.user_access;
DROP FUNCTION private.reject_deleted_user_access();
DROP TABLE private.account_deletions;
