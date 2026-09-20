---
name: stack
description: Bring ModaCo's Docker environment up and reach its services. Use before running anything against the system — tests, benchmarks, psql, end-to-end checks. Covers the remapped host ports, the readiness order, and the two failure modes that look like bugs but are not.
---

# Running the stack

```bash
cp .env.example .env          # first time only
docker compose up -d --build
```

Brings up PostgreSQL, PgBouncer, two Redis instances, LocalStack (S3 + SQS), runs the
migrations, then the API, projector and ingestion workers.

## Host ports are remapped

`.env` overrides every default because they were taken on the development machine.
**Reading the defaults instead of `.env` is the most common way to waste ten minutes here.**

```bash
set -a && . ./.env && set +a
```

| Service | Variable | Local value |
|---|---|---|
| postgres | `POSTGRES_HOST_PORT` | 55432 |
| pgbouncer | `PGBOUNCER_HOST_PORT` | 56432 |
| redis (cache) | `REDIS_HOST_PORT` | 56379 |
| redis (queue) | `REDIS_QUEUE_HOST_PORT` | 56380 |
| localstack | `LOCALSTACK_HOST_PORT` | 54566 |
| api | `PORT` | 3000 |
| projector metrics | `PROJECTOR_METRICS_PORT` | 53001 |

Inside the compose network, services always use the canonical ports and each other's
service names (`postgres:5432`, `redis:6379`, `http://api:3000`).

## Waiting for readiness

```bash
until docker compose ps api --format '{{.Status}}' | grep -q healthy; do sleep 5; done
```

LocalStack's healthcheck probes for a queue its bootstrap creates, not merely that SQS
answers — so `depends_on: service_healthy` genuinely means ready. If consumers still
crash-loop with `QueueDoesNotExist`, that healthcheck has been weakened.

## Two things that look like bugs

**`docker compose up -d --build <service>` rebuilds the image but may leave the old
container running.** Code changes then appear to have no effect. Use
`--force-recreate` when verifying a code change:

```bash
docker compose up -d --build --force-recreate projector
```

**Measuring from the host measures Docker Desktop.** A primary-key read appeared to take
36ms at 10 connections, roughly ten times its real cost. Run load from inside the network:

```bash
docker compose run --rm bench bench/dist/bench-detail.js
```

## Useful

```bash
docker compose logs -f projector                  # JSON, one line per event
docker compose up -d --scale ingestion-worker=6   # Lambda reserved concurrency, locally
docker compose down -v                            # also drops volumes: fresh database
```

`down -v` destroys the ingested catalogue. Reload with `npm run feed -- 500000`, which
takes a few minutes.
