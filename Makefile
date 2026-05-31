.PHONY: dev build run db-up db-down test tidy

dev: db-up
	@go run ./cmd/server

build:
	@go build -o bin/timewaste ./cmd/server

run: build
	@./bin/timewaste

db-up:
	@docker compose up -d postgres
	@echo "Waiting for PostgreSQL..." && sleep 2

db-down:
	@docker compose down

docker-up:
	@docker compose up --build

test:
	@go test ./...

tidy:
	@go mod tidy
