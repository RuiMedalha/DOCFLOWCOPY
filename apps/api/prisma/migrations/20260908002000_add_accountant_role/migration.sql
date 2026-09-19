-- Sprint 1.C — add ACCOUNTANT to the Role enum.
--
-- Dedicated role for the SAF-T PT exporter and the NIF base
-- (Portal das Finanças) lookup. Distinct from CONTABILIDADE so
-- we can grant read-only access to accounting partners without
-- exposing them to the operator write surface (which
-- CONTABILIDADE already carries in some flows — bank import,
-- reconciliation, payment schedules).
--
-- No data backfill: legacy rows keep their current role; the
-- SAF-T endpoints gate on (ADMIN, ACCOUNTANT) so a row with
-- CONTABILIDADE will not gain export rights until an ADMIN
-- upgrades the role explicitly.

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ACCOUNTANT';
