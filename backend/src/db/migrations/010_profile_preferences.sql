-- =============================================================================
-- Free-text study-partner preferences
--
-- Alongside the structured study preferences, a student can describe in their
-- own words what they want from a study partner or session. It lives on the
-- same row so the profile bundle carries it in the one round trip, and it is
-- available to the recommendation assistant when a language model is configured.
-- =============================================================================

ALTER TABLE study_preferences
  ADD COLUMN IF NOT EXISTS partner_preferences TEXT;
