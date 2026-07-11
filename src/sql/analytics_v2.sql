-- Analytics v2 — correr en Supabase SQL Editor (opcional pero recomendado)
-- Extiende query_events y agrega retención + índices.

-- 1) Columnas extra (idempotente)
ALTER TABLE query_events ADD COLUMN IF NOT EXISTS ramal text;
ALTER TABLE query_events ADD COLUMN IF NOT EXISTS client_hash text;
ALTER TABLE query_events ADD COLUMN IF NOT EXISTS cache_status text;
ALTER TABLE query_events ADD COLUMN IF NOT EXISTS duration_ms int;

-- 2) Índices para lecturas rápidas
CREATE INDEX IF NOT EXISTS idx_query_events_accion_ts
  ON query_events (accion, ts DESC);
CREATE INDEX IF NOT EXISTS idx_query_events_linea_ts
  ON query_events (linea, ts DESC)
  WHERE linea IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_query_events_parada_ts
  ON query_events (codigo_parada, ts DESC)
  WHERE codigo_parada IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_query_events_client_ts
  ON query_events (client_hash, ts DESC)
  WHERE client_hash IS NOT NULL;

-- 3) Retención: borrar eventos crudos > 90 días (dejar rollups locales en el proxy)
-- Programar como cron job en Supabase o correr a mano:
-- DELETE FROM query_events WHERE ts < now() - interval '90 days';

-- 4) (Opcional) Vista de demanda diaria
CREATE OR REPLACE VIEW analytics_daily_arribos AS
SELECT
  (ts AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS day,
  codigo_parada,
  linea,
  count(*)::int AS cnt
FROM query_events
WHERE accion = 'RecuperarProximosArribosW'
GROUP BY 1, 2, 3;
