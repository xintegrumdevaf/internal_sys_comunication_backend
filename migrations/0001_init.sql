-- Migracion 0001: esquema inicial (docs/spec/01_DATA_MODEL.md §2)
--
-- Desviacion documentada (AGENTS.md - "documentar cualquier desviacion"):
-- `case` es palabra reservada en PostgreSQL, por lo que la tabla se crea
-- como `"case"` (entre comillas dobles) en todas sus referencias. El
-- nombre, columnas, tipos, constraints e indices son exactamente los del DDL
-- de la especificacion, sin ningun otro cambio.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE department (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  TEXT NOT NULL,
  email                 TEXT NOT NULL UNIQUE,
  is_global_admin       BOOLEAN NOT NULL DEFAULT false,
  primary_department_id UUID REFERENCES department(id),
  active                BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_membership (
  agent_id      UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES department(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, department_id)
);

CREATE TABLE customer (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  national_id   TEXT UNIQUE,          -- cedula
  full_name     TEXT,
  wa_phone      TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contract (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id   UUID NOT NULL REFERENCES customer(id),
  contract_number TEXT NOT NULL,
  sector        TEXT,
  olt_name      TEXT,
  pon           TEXT,
  serial        TEXT,
  router_model  TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, contract_number)
);

CREATE TABLE conversation (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wa_phone          TEXT NOT NULL,
  customer_id       UUID REFERENCES customer(id),
  active_case_id    UUID,                       -- FK diferida a "case" (agregada tras crear case)
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','resolved','closed')),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversation_wa_phone ON conversation(wa_phone);

CREATE TABLE message (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id  UUID NOT NULL REFERENCES conversation(id),
  case_id          UUID,                        -- nullable: no todo mensaje pertenece a un case (ej. saludo)
  direction        TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  author           TEXT NOT NULL CHECK (author IN ('customer','ai','agent','system')),
  external_id      TEXT,                        -- waMessageId
  body             TEXT NOT NULL,
  type             TEXT NOT NULL DEFAULT 'text',
  media_id         TEXT,
  mime_type        TEXT,
  caption          TEXT,
  filename         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, external_id)          -- idempotencia de ingesta
);
CREATE INDEX idx_message_conversation ON message(conversation_id, created_at);

CREATE TABLE "case" (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id   UUID NOT NULL REFERENCES conversation(id),
  department_id     UUID NOT NULL REFERENCES department(id),
  workflow_type     TEXT NOT NULL,               -- 'SUPPORT_INTERNET' | 'BILLING_BALANCE' | 'SALES_PACKAGES' | ...
  status            TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN
                       ('NEW','ACTIVE','WAITING_USER','PAUSED','ESCALATED','HUMAN_ACTIVE','COMPLETED','EXPIRED','CANCELLED')),
  context           JSONB NOT NULL DEFAULT '{}', -- tipado a nivel de aplicacion, ver 01_DATA_MODEL.md §4
  version           INT NOT NULL DEFAULT 1,      -- optimistic concurrency
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_case_conversation ON "case"(conversation_id);
CREATE INDEX idx_case_department_status ON "case"(department_id, status);

ALTER TABLE conversation ADD CONSTRAINT fk_conversation_active_case
  FOREIGN KEY (active_case_id) REFERENCES "case"(id);
ALTER TABLE message ADD CONSTRAINT fk_message_case FOREIGN KEY (case_id) REFERENCES "case"(id);

CREATE TABLE workflow_instance (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id             UUID NOT NULL UNIQUE REFERENCES "case"(id),
  workflow_type       TEXT NOT NULL,
  current_state       TEXT NOT NULL,             -- p.ej. 'VALIDATE_CLIENT'
  version             INT NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workflow_execution (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workflow_instance_id  UUID NOT NULL REFERENCES workflow_instance(id),
  case_id               UUID NOT NULL REFERENCES "case"(id),
  action                TEXT NOT NULL,           -- 'VALIDATE_CLIENT' | 'CHECK_BALANCE' | ...
  status                TEXT NOT NULL CHECK (status IN ('DISPATCHED','COMPLETED','FAILED')),
  input                 JSONB,
  output                JSONB,
  error                 JSONB,
  idempotency_key       TEXT NOT NULL,
  correlation_id        TEXT NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  UNIQUE (idempotency_key)
);
CREATE INDEX idx_execution_case ON workflow_execution(case_id, started_at);

CREATE TABLE workflow_event (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id       UUID NOT NULL REFERENCES "case"(id),
  type          TEXT NOT NULL,                   -- ver 03_API_CONTRACT.md §D para el catalogo
  payload       JSONB NOT NULL DEFAULT '{}',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_event_case ON workflow_event(case_id, occurred_at);

CREATE TABLE automation_state (
  case_id         UUID PRIMARY KEY REFERENCES "case"(id),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  disabled_reason TEXT,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by      UUID REFERENCES agent(id)       -- null si el cambio lo hizo el sistema
);

CREATE TABLE escalation (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id           UUID NOT NULL REFERENCES "case"(id),
  department_id     UUID NOT NULL REFERENCES department(id),
  priority          TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  reason            TEXT NOT NULL,
  summary           JSONB NOT NULL,               -- estructura de 03_API_CONTRACT.md §B.4
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ASSIGNED','RESOLVED')),
  assigned_agent_id UUID REFERENCES agent(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ
);
CREATE INDEX idx_escalation_department_status ON escalation(department_id, status);

CREATE TABLE audit_event (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  action        TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  actor_id      UUID,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_resource ON audit_event(resource_type, resource_id, occurred_at);
