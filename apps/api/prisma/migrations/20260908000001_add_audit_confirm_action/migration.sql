-- Sprint 1.A — extend AuditAction enum with CONFIRM.
--
-- `POST /documents/:id/confirm-all` (the "Confirmar e arquivar"
-- button on the review screen) emits an audit row carrying the bulk
-- confirmation. `APPROVE` was the previous candidate but its
-- semantic is "approved for posting to accounting", distinct from
-- "supplier extraction reviewed and OK as-is". `CONFIRM` keeps the
-- two ledger lines separable for the forensics dashboard.
--
-- Postgres enums cannot ALTER VALUE in place; the safe migration is
-- ADD VALUE, which is not transactional. We use IF NOT EXISTS so
-- re-running the migration on a database that already has the value
-- is a no-op rather than an error.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONFIRM';
