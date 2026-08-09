-- Persistencia de efectos no idempotentes de n8n (RECORD_PAYMENT / APPLY_BANK_ACCOUNT).
-- La API sigue siendo dueña del Case; estas tablas solo evitan duplicar el efecto
-- externo cuando se reintenta el mismo idempotencyKey (03_API_CONTRACT.md §B).

CREATE TABLE IF NOT EXISTS n8n_recorded_payments (
  idempotency_key TEXT PRIMARY KEY,
  national_id TEXT,
  amount NUMERIC NOT NULL,
  reference TEXT NOT NULL,
  payment_date TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS n8n_bank_account_requests (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  national_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result JSONB NOT NULL
);
