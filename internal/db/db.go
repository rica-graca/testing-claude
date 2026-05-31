package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect opens a connection pool to PostgreSQL.
func Connect(dsn string) (*pgxpool.Pool, error) {
	if dsn == "" {
		return nil, fmt.Errorf("DATABASE_URL is not set")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.New: %w", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// Migrate runs the embedded SQL migrations.
func Migrate(pool *pgxpool.Pool) error {
	_, err := pool.Exec(context.Background(), schema)
	return err
}

const schema = `
CREATE TABLE IF NOT EXISTS categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    color       TEXT NOT NULL DEFAULT '#6366f1',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title        TEXT NOT NULL,
    description  TEXT,
    category_id  UUID REFERENCES categories(id) ON DELETE SET NULL,
    started_at   TIMESTAMPTZ,
    ended_at     TIMESTAMPTZ,
    duration_sec INT GENERATED ALWAYS AS (
        CASE WHEN ended_at IS NOT NULL AND started_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (ended_at - started_at))::INT
             ELSE NULL
        END
    ) STORED,
    is_waste     BOOLEAN NOT NULL DEFAULT false,
    notes        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tasks_category_id_idx ON tasks(category_id);
CREATE INDEX IF NOT EXISTS tasks_started_at_idx  ON tasks(started_at);
CREATE INDEX IF NOT EXISTS tasks_is_waste_idx    ON tasks(is_waste);

-- Seed default categories if empty
INSERT INTO categories (name, color) VALUES
    ('Meetings',       '#f97316'),
    ('Social Media',   '#ec4899'),
    ('Email',          '#8b5cf6'),
    ('Admin',          '#06b6d4'),
    ('Deep Work',      '#22c55e'),
    ('Breaks',         '#eab308')
ON CONFLICT DO NOTHING;
`
