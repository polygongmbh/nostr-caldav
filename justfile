# nostr-caldav - Just Commands
caldav_base_url := env_var_or_default("CALDAV_BASE_URL", "http://localhost:5232")
service := "nostr-caldav"
container := "nostr-caldav-nostr-caldav-1"

# Default recipe (shows available commands)
default:
    @just --list

# Install dependencies locally
install:
    npm install

# Start the bridge
up:
    docker compose up -d

# Rebuild and restart the bridge with current source code
restart:
    docker compose up -d --build --force-recreate {{service}}

# Stop the bridge stack
down:
    docker compose down

# Show running bridge containers
ps:
    docker compose ps

# Follow bridge logs
logs:
    docker compose logs -f --tail=200 {{service}}

# Show recent bridge logs
logs-tail:
    docker compose logs --tail=200 {{service}}

# Run syntax check locally
check:
    npm run check

# Run tests locally
test:
    npm test

# Run syntax check in Docker against the current workspace
check-docker:
    docker run --rm -v "$PWD:/work" -w /work nostr-caldav-nostr-caldav npm run check

# Run tests in Docker against the current workspace
test-docker:
    docker run --rm -v "$PWD:/work" -w /work nostr-caldav-nostr-caldav npm test

# Rebuild image, restart service, then show logs
deploy: restart
    docker compose logs --tail=80 {{service}}

# Health check the local CalDAV endpoint
health:
    @curl -sS -i --max-time 10 "{{caldav_base_url}}/" | sed -n '1,20p'

# Open a shell in the running bridge container
shell:
    docker exec -it {{container}} sh

# Query live task/subtask visibility counts
db-counts:
    @docker exec {{container}} sh -lc "node --input-type=module -e \"import Database from 'better-sqlite3'; const db=new Database('/data/bridge.db'); const rows={total:db.prepare('select count(*) n from issues').get().n, children:db.prepare('select count(*) n from issues where parent_event_id is not null and length(parent_event_id) > 0').get().n, hidden_parents:db.prepare('select count(distinct p.event_id) n from issues p join issues c on c.parent_event_id = p.event_id').get().n, visible_filtered:db.prepare('select count(*) n from issues where not exists (select 1 from issues child where child.parent_event_id = issues.event_id)').get().n}; console.log(JSON.stringify(rows,null,2)); db.close();\""

# Show git status
status:
    git status --short
