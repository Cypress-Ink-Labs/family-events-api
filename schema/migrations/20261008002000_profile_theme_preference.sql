ALTER TABLE public.user_profiles
  ADD COLUMN theme_preference text
  CONSTRAINT user_profiles_theme_preference_check
  CHECK (theme_preference IN ('light', 'dark', 'system'));

COMMENT ON COLUMN public.user_profiles.theme_preference IS
  'Saved appearance preference; NULL preserves an existing browser preference until the user saves one.';
