# nostr-caldav-bridge (JS)

Phase-1 implementation of a Nostr Relay to CalDAV bridge.

## Implemented

- Nostr subscription for kind `1621` (git issue events)
- SQLite state storage
- Read-only CalDAV endpoints exposing VTODO objects
- Basic auth for CalDAV access

## Not Implemented Yet

- Status kinds `1630-1633`
- CalDAV `PUT` to Nostr write-back
- NIP-42 auth, NIP-46 signer delegation
- Robust `calendar-query`/`sync-collection` REPORT parsing

## Run

```bash
cp config.example.yaml config.yaml
npm install
npm start
```

Server starts on `http://localhost:5232` by default.

## Endpoints

- `PROPFIND /.well-known/caldav`
- `PROPFIND /calendars/{user}/`
- `PROPFIND /calendars/{user}/nostr-issues/`
- `GET /calendars/{user}/nostr-issues/{uid}.ics`
- `PUT /calendars/{user}/nostr-issues/{uid}.ics` (returns `405` in phase 1)
- `DELETE /calendars/{user}/nostr-issues/{uid}.ics` (returns `405` in phase 1)
- `REPORT /calendars/{user}/nostr-issues/`
