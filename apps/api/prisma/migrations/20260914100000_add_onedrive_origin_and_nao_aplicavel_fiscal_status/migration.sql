-- =============================================================================
-- Inbound multicanal & Fase B2: ONEDRIVE origin + NAO_APLICAVEL fiscal status
-- =============================================================================

ALTER TYPE "DocumentOrigin" ADD VALUE IF NOT EXISTS 'ONEDRIVE';
ALTER TYPE "FiscalStatus" ADD VALUE IF NOT EXISTS 'NAO_APLICAVEL';

