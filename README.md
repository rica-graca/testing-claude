# ⏱ timewaste

> Know exactly where your day goes. Track tasks, mark waste, and get brutally honest reports.

## Features

- **Task tracking** — start/stop a timer on any task
- **Waste flagging** — mark tasks as wasted time with one click
- **Categories** — group tasks (Meetings, Social Media, Email, etc.)
- **Daily dashboard** — live overview of tracked vs wasted time
- **Waste reports** — breakdown by category over any date range
- **REST API** — fully documented endpoints
- **Web dashboard** — clean dark UI, no dependencies

## Quick start

### Prerequisites
- Go 1.22+
- Docker (for PostgreSQL)

### Run locally

```bash
# 1. Clone and enter the repo
git clone https://github.com/yourname/timewaste
cd timewaste

# 2. Copy env config
cp .env.example .env

# 3. Start PostgreSQL (Docker)
make db-up

# 4. Run the server (auto-migrates on first start)
make dev
```

Open [http://localhost:8080](http://localhost:8080)

### Or with Docker Compose (everything at once)

```bash
docker compose up --build
```

## API Reference

### Tasks

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks (filter: `category_id`, `is_waste`, `from`, `to`) |
| POST | `/api/tasks` | Create a task |
| GET | `/api/tasks/:id` | Get a task |
| PATCH | `/api/tasks/:id` | Update a task |
| DELETE | `/api/tasks/:id` | Delete a task |
| POST | `/api/tasks/:id/start` | Start the timer |
| POST | `/api/tasks/:id/stop` | Stop the timer |

### Categories

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/categories` | List all categories |
| POST | `/api/categories` | Create a category |
| DELETE | `/api/categories/:id` | Delete a category |

### Reports

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/report?from=YYYY-MM-DD&to=YYYY-MM-DD` | Waste report by category |

### Example: create and time a task

```bash
# Create a task
curl -X POST localhost:8080/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Weekly sync meeting","is_waste":true,"category_id":"<uuid>"}'

# Start timer
curl -X POST localhost:8080/api/tasks/<id>/start

# Stop timer
curl -X POST localhost:8080/api/tasks/<id>/stop

# Get today's waste report
curl "localhost:8080/api/report?from=$(date +%F)&to=$(date +%F)"
```

## Project structure

```
.
├── cmd/server/         # Main entrypoint
├── internal/
│   ├── db/             # PostgreSQL repos (tasks, categories)
│   ├── handlers/       # HTTP handlers + router
│   └── models/         # Domain types & request/response structs
├── web/static/         # Dashboard (HTML + CSS + JS)
├── docker-compose.yml
├── Dockerfile
└── Makefile
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL DSN (required) |
| `PORT` | `8080` | HTTP port |
# testing-claude
# testing-claude
# testing-claude
