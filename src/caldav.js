import express from "express";
import morgan from "morgan";
import { issueToVtodo } from "./ics.js";
import { processVtodoPut, runReportQuery } from "./caldav-core.js";
import {
  buildPrincipalCalendars,
  findCalendarForPrincipal,
  issueVisibleInCalendar,
  listIssuesForCalendar
} from "./caldav-calendars.js";

function parseBasicAuth(header) {
  const [scheme, encoded] = String(header || "").split(" ");
  if (scheme !== "Basic" || !encoded) return null;

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;

  return {
    username: decoded.slice(0, idx),
    password: decoded.slice(idx + 1)
  };
}

function principalAuth(principals) {
  return (req, res, next) => {
    const auth = parseBasicAuth(req.headers.authorization);
    if (!auth) {
      res.set("WWW-Authenticate", 'Basic realm="nostr-caldav"');
      return res.status(401).end();
    }

    const principal = principals.find((p) => p.username === auth.username && p.password === auth.password);
    if (!principal) {
      return res.status(403).send("Forbidden");
    }

    req.principal = principal;
    return next();
  };
}

function xmlResponse(res, code, body) {
  res.status(code);
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.send(body);
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function objectPath(user, calendarId, uid) {
  return `/calendars/${user}/${calendarId}/${uid}.ics`;
}

function calendarPath(user, calendarId) {
  return `/calendars/${user}/${calendarId}/`;
}

function multistatusForCollection(baseUrl, user, calendarId, token, rows) {
  const responses = rows
    .map((row) => {
      const issue = row.issue || row;
      const includeCalendarData = row.projection?.includeCalendarData !== false;
      const href = `${baseUrl}${objectPath(user, calendarId, issue.caldav_uid)}`;
      return `
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>${issue.caldav_etag}</d:getetag>
        ${includeCalendarData ? `<c:calendar-data>${xmlEscape(issueToVtodo(issue))}</c:calendar-data>` : ""}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token>urn:sync-token:${token}</d:sync-token>
${responses}
</d:multistatus>`;
}

function multistatusForPrincipal(baseUrl, principal, calendars) {
  const responses = calendars
    .map((cal) => `
  <d:response>
    <d:href>${baseUrl}${calendarPath(principal.username, cal.id)}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${xmlEscape(cal.name)}</d:displayname>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`)
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
${responses}
</d:multistatus>`;
}

export function createCaldavServer({ db, caldavConfig, syncService, trackedPubkeys }) {
  const app = express();
  const principals = caldavConfig.principals || [
    {
      username: caldavConfig.username,
      password: caldavConfig.password,
      pubkeys: [],
      calendars: []
    }
  ];

  app.use(morgan("combined"));
  app.use(express.text({ type: "*/*", limit: "2mb" }));
  app.use(principalAuth(principals));

  app.use((req, res, next) => {
    res.set("DAV", "1, calendar-access");
    next();
  });

  app.get("/.well-known/caldav", (req, res) => {
    res.redirect(302, `/calendars/${req.principal.username}/`);
  });

  app.use((req, res, next) => {
    if (req.method !== "PROPFIND" && req.method !== "REPORT") return next();

    const principal = req.principal;
    const syncToken = db.getSyncToken();
    const calendars = buildPrincipalCalendars(principal, trackedPubkeys);

    if (req.path === `/calendars/${principal.username}/`) {
      return xmlResponse(res, 207, multistatusForPrincipal(caldavConfig.baseUrl, principal, calendars));
    }

    const collectionMatch = req.path.match(new RegExp(`^/calendars/${principal.username}/([^/]+)/$`));
    if (!collectionMatch) {
      return res.status(404).send("Not found");
    }

    const calendarId = collectionMatch[1];
    const calendar = findCalendarForPrincipal(principal, trackedPubkeys, calendarId);
    if (!calendar) {
      return res.status(404).send("Not found");
    }

    const baseIssues = listIssuesForCalendar(db, calendar);
    const report = req.method === "REPORT" ? runReportQuery({ issues: baseIssues, reportBody: req.body, syncToken }) : null;
    const rows = report?.results || report?.issues || baseIssues;

    return xmlResponse(res, 207, multistatusForCollection(caldavConfig.baseUrl, principal.username, calendarId, syncToken, rows));
  });

  app.get(/^\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\.ics$/, (req, res) => {
    const [, user, calendarId, uid] = req.path.match(/^\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\.ics$/) || [];
    const principal = req.principal;

    if (user !== principal.username) {
      return res.status(404).send("Not found");
    }

    const calendar = findCalendarForPrincipal(principal, trackedPubkeys, calendarId);
    if (!calendar) return res.status(404).send("Not found");

    const issue = db.getIssueByUid(uid);
    if (!issue || !issueVisibleInCalendar(issue, calendar)) {
      return res.status(404).send("Not found");
    }

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("ETag", issue.caldav_etag || `\"${issue.event_id}\"`);
    return res.status(200).send(issueToVtodo(issue));
  });

  app.put(/^\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\.ics$/, async (req, res) => {
    const [, user, calendarId, uid] = req.path.match(/^\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\.ics$/) || [];
    const principal = req.principal;

    if (user !== principal.username) {
      return res.status(404).send("Not found");
    }

    const calendar = findCalendarForPrincipal(principal, trackedPubkeys, calendarId);
    if (!calendar) return res.status(404).send("Not found");

    const issue = db.getIssueByUid(uid);
    if (!issue || !issueVisibleInCalendar(issue, calendar)) {
      return res.status(404).send("Not found");
    }

    const result = await processVtodoPut({
      db,
      syncService,
      uid,
      ifMatch: req.header("if-match"),
      body: req.body
    });

    if (result.etag) {
      res.set("ETag", result.etag);
    }

    if (result.status === 204) {
      return res.status(204).end();
    }

    return res.status(result.status).send(result.error);
  });

  app.delete(/^\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\.ics$/, (_req, res) => {
    return res.status(405).send("Deleting tasks is not supported");
  });

  app.all("*", (_req, res) => res.status(404).send("Not found"));

  return app;
}
