-- Phase 3: per-user session versioning (session invalidation on logout).
-- Every session token carries the user's session_version at login. Each authenticated request compares it with the
-- current value; logout increments it, so every token issued before the logout stops working immediately.
-- Existing users start at version 1.
ALTER TABLE users
  ADD COLUMN session_version integer NOT NULL DEFAULT 1 CHECK (session_version >= 1);
