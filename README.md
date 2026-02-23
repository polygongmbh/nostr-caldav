# nostr-caldav-bridge (JS)

Nostr Relay ↔ CalDAV bridge with two-way status sync for NIP-34 git issues.

## Implemented

- Nostr subscriptions:
  - kind `1621` issue events
  - status kinds `1630-1633`
- SQLite state storage with sync token and ETag/sequence tracking
- CalDAV endpoints for collection discovery, object GET, and sync `REPORT`
- VTODO rendering for Nostr issues
- Kind `1622` comments appended into task notes/description
- CalDAV `PUT` status updates with `If-Match` conflict handling
- CalDAV → Nostr writeback publishing for status changes (when private key configured)
- Unit and integration tests using `node:test`

## Not Implemented Yet

- NIP-42 relay auth
- NIP-46 bunker signer delegation
- Multi-principal calendars and advanced filtering
- Full RFC-complete `calendar-query` property filtering

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

## Endpoints

- `PROPFIND /.well-known/caldav`
- `PROPFIND /calendars/{user}/`
- `PROPFIND /calendars/{user}/nostr-issues/`
- `GET /calendars/{user}/nostr-issues/{uid}.ics`
- `PUT /calendars/{user}/nostr-issues/{uid}.ics`
- `DELETE /calendars/{user}/nostr-issues/{uid}.ics` (returns `405`)
- `REPORT /calendars/{user}/nostr-issues/`

## Nostr writeback key

Set `nostr.private_key` in `config.yaml` with either:

- `nsec1...`
- 64-char hex private key

If not set, CalDAV status changes are stored locally but publishing to relays is skipped.
