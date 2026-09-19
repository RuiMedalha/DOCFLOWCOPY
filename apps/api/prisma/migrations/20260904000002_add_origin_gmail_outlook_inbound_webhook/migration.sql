-- =============================================================================
-- Sprint F — extend DocumentOrigin enum with GMAIL / OUTLOOK / INBOUND_WEBHOOK
-- =============================================================================
--
-- Sprint F (Inbox multi-canal) introduces three new inbound channels:
--   * GMAIL  — Gmail API OAuth polling (gmail.readonly scope)
--   * OUTLOOK — Microsoft Graph API OAuth polling (Mail.Read scope)
--   * INBOUND_WEBHOOK — explicit alias for the SendGrid / Mailgun inbound
--     parse webhook (which previously wrote `EMAIL`). The legacy `EMAIL`
--     value is RETAINED for backward compatibility with existing rows
--     produced by the IMAP cron + SendGrid/Mailgun webhook prior to this
--     migration. New webhook ingests can pick `INBOUND_WEBHOOK` going
--     forward; both values continue to be accepted by the API.
--
-- Postgres `ALTER TYPE ... ADD VALUE` cannot run inside a transaction in
-- older versions, but Postgres 12+ (and the project's PG15+) is fine.
-- The migration is a sequence of `ADD VALUE IF NOT EXISTS` statements so
-- it is idempotent and safe to re-run on databases that may have
-- partially applied it (e.g. a multi-replica rolling deploy).

ALTER TYPE "DocumentOrigin" ADD VALUE IF NOT EXISTS 'GMAIL';
ALTER TYPE "DocumentOrigin" ADD VALUE IF NOT EXISTS 'OUTLOOK';
ALTER TYPE "DocumentOrigin" ADD VALUE IF NOT EXISTS 'INBOUND_WEBHOOK';
