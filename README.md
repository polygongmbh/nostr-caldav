# nostr-caldav-bridge

Nostr Relay ↔ CalDAV bridge with two-way status sync for NIP-34 git issues.

## Implemented Scope

- Nostr subscriptions:
  - kind `1621` issues
  - status kinds `1630-1633`
  - comment kind `1622`
- NIP-42 relay auth support for read/write operations
- NOAS-backed CalDAV authentication (`handle@domain + password`) for per-user signing
- SQLite state store with:
  - sync token tracking
  - ETag/SEQUENCE conflict handling
  - sync log
- CalDAV/WebDAV endpoints:
  - principal collection discovery
  - per-calendar collection listing
  - object GET/PUT/DELETE behavior (`DELETE` intentionally unsupported)
  - REPORT handling for `sync-collection` and `calendar-query`
- Multi-principal support with per-principal credentials and visibility filters
- Automatic per-pubkey calendars (one calendar per tracked pubkey)
- Configurable filtered calendars per principal (labels/status/text/pubkeys)
- VTODO mapping for issues, labels, status, description, and nevent URL back-links
- CalDAV -> Nostr writeback on status transitions
- Unit/integration test suite via `node:test`

## Run

```bash
cp config.example.yaml config.yaml
npm install
npm start
```

Server defaults to `http://localhost:5232`.

## Apple Reminders Setup (HTTPS via Caddy)

Apple account verification is most reliable over HTTPS on port `443`.

1. Point a DNS hostname (example: `caldav.example.com`) to your server IP.
2. Update `config.yaml`:
   - `caldav.host: "::"`
   - `caldav.base_url: "https://caldav.example.com"`
3. Edit `Caddyfile` and replace `caldav.example.com` with your real hostname.
4. Run bridge and Caddy:

```bash
npm start
caddy run --config ./Caddyfile
```

5. In Apple Reminders CalDAV account:
   - Server: `caldav.example.com`
   - Username: NOAS handle (example `janek@polygon.gmbh`)
   - Password: NOAS account password
   - SSL: on (default)

## Test

```bash
npm test
```

## CalDAV Endpoints

- `PROPFIND /.well-known/caldav`
- `PROPFIND /calendars/{user}/`
- `PROPFIND /calendars/{user}/{calendarId}/`
- `GET /calendars/{user}/{calendarId}/{uid}.ics`
- `PUT /calendars/{user}/{calendarId}/{uid}.ics`
- `DELETE /calendars/{user}/{calendarId}/{uid}.ics` (returns `405`)
- `REPORT /calendars/{user}/{calendarId}/`

## Auth Mode

This bridge runs in NOAS-only auth mode.

`nostr.noas`:
- `enabled` must be `true`
- `caldav_auth_enabled` must be `true`
- CalDAV basic auth is validated against NOAS `POST /auth/signin` using handle/password
- bridge decrypts `private_key_encrypted` with the provided password for signing and caches session data in memory

Example:

```yaml
nostr:
  noas:
    enabled: true
    base_url: "https://noas.example.com"
    api_path_prefix: "/api/v1"
    timeout_ms: 10000
    caldav_auth_enabled: true
    domain_base_urls:
      example.com: "https://noas.example.com"
    cache_mode: "encrypted"
    cache_ttl_ms: 300000
```

## Docker

Build and run with Docker Compose:

```bash
docker compose up --build
```

The container expects `/data/config.yaml` (mapped from local `config.yaml`) and stores DB under mounted `/data`.
