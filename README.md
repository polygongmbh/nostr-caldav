# nostr-caldav-bridge (JS)

Nostr Relay ↔ CalDAV bridge with two-way status sync for NIP-34 git issues.

## Implemented Scope

- Nostr subscriptions:
  - kind `1621` issues
  - status kinds `1630-1633`
  - comment kind `1622`
- NIP-42 relay auth support for read/write operations
- NIP-46 bunker signer support (`bunker_url`) plus local key signer fallback
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

## Signer Modes

`nostr.private_key`:
- `nsec1...`
- 64-char hex private key

`nostr.bunker_url`:
- NIP-46 bunker URL/identifier
- when set, bunker mode is used and local key mode is ignored

If neither is set, CalDAV status changes are stored locally but Nostr publish is skipped.

## Docker

Build and run with Docker Compose:

```bash
docker compose up --build
```

The container expects `/data/config.yaml` (mapped from local `config.yaml`) and stores DB under mounted `/data`.
