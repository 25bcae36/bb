-- BorrowBox database schema for Neon PostgreSQL.
-- App content is stored as shared JSONB state; account credentials are stored
-- separately with scrypt password hashes (never plaintext passwords).

CREATE TABLE IF NOT EXISTS public.borrowbox_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.borrowbox_users (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',
  dept TEXT NOT NULL DEFAULT 'Student',
  joined DATE NOT NULL DEFAULT CURRENT_DATE,
  suspended BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.borrowbox_state (id, state)
VALUES (
  1,
  '{"users": {}, "items": [], "requests": [], "history": [], "reports": []}'::jsonb
)
ON CONFLICT (id) DO NOTHING;
