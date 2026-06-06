import express from "express";
import morgan from "morgan";
import { issueToVtodo, calendarEventToVevent } from "./ics.js";
import { processVtodoCreate, processVtodoPut, runReportQuery } from "./caldav-core.js";
import {
  buildPrincipalCalendars,
  findCalendarForPrincipal,
  issueVisibleToPrincipal,
  issueVisibleInCalendar,
  listIssuesForCalendar,
  listCalendarEventsForCalendar,
  calendarEventVisibleToPrincipal
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

function principalAuth(principals, noasAuthProvider, onAuthenticatedContext) {
  return async (req, res, next) => {
    const auth = parseBasicAuth(req.headers.authorization);
    if (!auth) {
      res.set("WWW-Authenticate", 'Basic realm="nostr-caldav"');
      return res.status(401).end();
    }

    if (noasAuthProvider?.enabled) {
      try {
        const authContext = await noasAuthProvider.authenticate(auth.username, auth.password);
        if (!authContext?.principal) {
          return res.status(403).send("Forbidden");
        }
        req.principal = authContext.principal;
        req.authContext = authContext;
        if (typeof onAuthenticatedContext === "function") {
          onAuthenticatedContext(authContext);
        }
        return next();
      } catch {
        return res.status(403).send("Forbidden");
      }
    }

    const principal = principals.find((p) => p.username === auth.username && p.password === auth.password);
    if (!principal) {
      return res.status(403).send("Forbidden");
    }

    req.principal = principal;
    req.authContext = null;
    return next();
  };
}

function xmlResponse(res, code, body) {
  res.status(code);
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.send(body);
}

function currentUserPrivilegeSetXml() {
  return `<d:current-user-privilege-set>
          <d:privilege><d:read/></d:privilege>
          <d:privilege><d:write/></d:privilege>
          <d:privilege><d:write-properties/></d:privilege>
          <d:privilege><d:write-content/></d:privilege>
        </d:current-user-privilege-set>`;
}

function normalizeCollectionPath(path) {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function xmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function withPrincipalVisibility(issues, principal, db = null) {
  return (issues || []).filter((issue) =>
    issueVisibleToPrincipal(issue, principal, {
      getIssueByEventId: db?.getIssueByEventId
    })
  );
}

function resolveChannelTags(db, principal) {
  if (typeof db?.listIssuesFiltered !== "function") return [];
  const tags = new Set();
  const visible = withPrincipalVisibility(db.listIssuesFiltered({}), principal, db);
  for (const issue of visible) {
    let channelTags = [];
    try {
      channelTags = JSON.parse(issue.channel_tags || "[]");
    } catch {
      channelTags = [];
    }
    for (const tag of channelTags) {
      const value = String(tag || "").trim().toLowerCase();
      if (value) tags.add(value);
    }
  }
  const scoped = Array.from(tags).sort();
  if (scoped.length > 0) return scoped;
  return [];
}

function listVisibleIssuesForCalendar(db, principal, calendar) {
  return withPrincipalVisibility(listIssuesForCalendar(db, calendar), principal, db);
}

function hideEmptyCalendars(db, principal, calendars) {
  return (calendars || []).filter((calendar) => {
    const hasOpenIssues = listVisibleIssuesForCalendar(db, principal, calendar).some((issue) => issue.status === "open");
    if (hasOpenIssues) return true;
    return listCalendarEventsForCalendar(db, calendar).length > 0;
  });
}

function summarizeCalendars(calendars) {
  return (calendars || []).map((cal) => ({
    id: cal.id,
    name: cal.name,
    channelTag: cal.channelTag || null
  }));
}

function objectPath(user, calendarId, uid) {
  return `/calendars/${user}/${calendarId}/${uid}.ics`;
}

function calendarPath(user, calendarId) {
  return `/calendars/${user}/${calendarId}/`;
}

function decodePathSegment(value) {
  let current = String(value || "");
  for (let i = 0; i < 3; i += 1) {
    let next = current;
    try {
      next = decodeURIComponent(current);
    } catch {
      next = current;
    }
    if (next === current) break;
    current = next;
  }
  try {
    return current;
  } catch {
    return current;
  }
}

function matchesPrincipalUser(pathUser, principalUsername) {
  return decodePathSegment(pathUser) === principalUsername;
}

function rowToIcs(row) {
  if (row.calendarEvent) return calendarEventToVevent(row.calendarEvent);
  if (row._isCalEvent) return calendarEventToVevent(row.item || row);
  const issue = row.issue || row.item || row;
  return issueToVtodo(issue);
}

function rowItem(row) {
  return row.calendarEvent || row.issue || row.item || row;
}

function multistatusForCollection(_baseUrl, user, calendarId, token, rows) {
  const calendarHref = `${calendarPath(user, calendarId)}`;
  const responses = rows
    .map((row) => {
      const item = rowItem(row);
      const includeCalendarData = row.projection?.includeCalendarData !== false;
      const href = `${objectPath(user, calendarId, item.caldav_uid)}`;
      return `
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>${item.caldav_etag}</d:getetag>
        ${includeCalendarData ? `<c:calendar-data>${xmlEscape(rowToIcs(row))}</c:calendar-data>` : ""}
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:sync-token>urn:sync-token:${token}</d:sync-token>
  <d:response>
    <d:href>${calendarHref}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        ${currentUserPrivilegeSetXml()}
        <d:supported-report-set>
          <d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report>
          <d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report>
        </d:supported-report-set>
        <c:supported-calendar-component-set>
          <c:comp name="VTODO"/>
          <c:comp name="VEVENT"/>
        </c:supported-calendar-component-set>
        <cs:getctag>${token}</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
${responses}
</d:multistatus>`;
}

function multistatusForPrincipal(_baseUrl, principal, calendars) {
  const homeHref = `/calendars/${principal.username}/`;
  const responses = calendars
    .map((cal) => `
  <d:response>
    <d:href>${calendarPath(principal.username, cal.id)}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${xmlEscape(cal.name)}</d:displayname>
        <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
        ${currentUserPrivilegeSetXml()}
        <d:supported-report-set>
          <d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report>
          <d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report>
        </d:supported-report-set>
        <c:supported-calendar-component-set>
          <c:comp name="VTODO"/>
          <c:comp name="VEVENT"/>
        </c:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`)
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:response>
    <d:href>${homeHref}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${xmlEscape(principal.username)}</d:displayname>
        <d:resourcetype><d:collection/></d:resourcetype>
        <cs:getctag>${Date.now()}</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
${responses}
</d:multistatus>`;
}

function multistatusForServiceRoot(_baseUrl, principal) {
  const principalHref = `/principals/${principal.username}/`;
  return `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
        ${currentUserPrivilegeSetXml()}
        <d:current-user-principal><d:href>${principalHref}</d:href></d:current-user-principal>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
}

function multistatusForPrincipalRef(_baseUrl, principal, hrefPath) {
  const principalHref = `/principals/${principal.username}/`;
  const calendarHome = `/calendars/${principal.username}/`;
  return `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>${hrefPath}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><d:principal/></d:resourcetype>
        ${currentUserPrivilegeSetXml()}
        <d:displayname>${xmlEscape(principal.username)}</d:displayname>
        <c:calendar-home-set><d:href>${calendarHome}</d:href></c:calendar-home-set>
        <d:current-user-principal><d:href>${principalHref}</d:href></d:current-user-principal>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
}

export function createCaldavServer({ db, caldavConfig, syncService, trackedPubkeys, noasAuthProvider, onAuthenticatedContext }) {
  const app = express();
  const calendarOptions = {
    includeAutoPubkeyCalendars: caldavConfig.includeAutoPubkeyCalendars
  };
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
  app.use(principalAuth(principals, noasAuthProvider, onAuthenticatedContext));

  app.options("*", (_req, res) => {
    res.set("Allow", "OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE");
    res.set("DAV", "1, calendar-access");
    return res.status(200).end();
  });

  app.use((req, res, next) => {
    res.set("DAV", "1, calendar-access");
    next();
  });

  app.get("/debug/recent-writes", (req, res) => {
    const limitRaw = req.query.limit;
    const limit = Math.max(1, Math.min(Number(limitRaw) || 50, 200));
    const rows = db.listSyncLog(limit);

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      count: rows.length,
      rows
    });
  });

  app.get("/debug/calendars", (req, res) => {
    const principal = req.principal;
    const channelTags = resolveChannelTags(db, principal);
    const discoveredCalendars = buildPrincipalCalendars(principal, trackedPubkeys, {
      ...calendarOptions,
      channelTags
    });
    const calendars = hideEmptyCalendars(db, principal, discoveredCalendars);
    const visibleCount = withPrincipalVisibility(db.listIssues(), principal, db).length;
    return res.status(200).json({
      generated_at: new Date().toISOString(),
      principal: principal?.username || null,
      principal_pubkey: principal?.pubkeys?.[0] || null,
      visible_issue_count: visibleCount,
      discovered_calendar_count: discoveredCalendars.length,
      visible_calendar_count: calendars.length,
      channel_tag_count: channelTags.length,
      sample_channel_tags: channelTags.slice(0, 50),
      calendars: summarizeCalendars(calendars)
    });
  });

  app.get("/.well-known/caldav", (req, res) => {
    res.redirect(302, `/calendars/${req.principal.username}/`);
  });

  app.use((req, res, next) => {
    if (req.method !== "PROPFIND" && req.method !== "REPORT") return next();

    const principal = req.principal;
    const syncToken = db.getSyncToken();
    const normalizedPath = normalizeCollectionPath(req.path);
    const discoveredCalendars = buildPrincipalCalendars(principal, trackedPubkeys, {
      ...calendarOptions,
      channelTags: resolveChannelTags(db, principal)
    });
    const calendars = hideEmptyCalendars(db, principal, discoveredCalendars);
    if (normalizedPath.match(/^\/calendars\/[^/]+$/)) {
      const summary = summarizeCalendars(calendars);
      console.log(
        `[caldav] principal=${principal.username} calendar-home calendars=${summary.length} channels=${
          summary.filter((c) => c.channelTag).length
        } sample=${summary.slice(0, 10).map((c) => c.id).join(",")}`
      );
    }

    if (normalizedPath === "/") {
      return xmlResponse(res, 207, multistatusForServiceRoot(caldavConfig.baseUrl, principal));
    }

    if (normalizedPath === "/.well-known/caldav") {
      return xmlResponse(res, 207, multistatusForServiceRoot(caldavConfig.baseUrl, principal));
    }

    if (normalizedPath === "/principals" || normalizedPath === "/principals/") {
      return xmlResponse(res, 207, multistatusForPrincipalRef(caldavConfig.baseUrl, principal, "/principals/"));
    }

    const principalMatch = normalizedPath.match(/^\/principals\/([^/]+)$/);
    if (principalMatch && decodePathSegment(principalMatch[1]) === principal.username) {
      return xmlResponse(
        res,
        207,
        multistatusForPrincipalRef(caldavConfig.baseUrl, principal, `/principals/${principal.username}/`)
      );
    }

    const applePrincipalMatch = normalizedPath.match(/^\/calendar\/dav\/user\/([^/]+)$/);
    if (applePrincipalMatch && decodePathSegment(applePrincipalMatch[1]) === principal.username) {
      return xmlResponse(
        res,
        207,
        multistatusForPrincipalRef(caldavConfig.baseUrl, principal, `/calendar/dav/user/${principal.username}/`)
      );
    }

    const calendarHomeMatch = normalizedPath.match(/^\/calendars\/([^/]+)$/);
    if (calendarHomeMatch && matchesPrincipalUser(calendarHomeMatch[1], principal.username)) {
      return xmlResponse(res, 207, multistatusForPrincipal(caldavConfig.baseUrl, principal, calendars));
    }

    const collectionMatch = normalizedPath.match(/^\/calendars\/([^/]+)\/([^/]+)$/);
    if (!collectionMatch) {
      return res.status(404).send("Not found");
    }
    if (!matchesPrincipalUser(collectionMatch[1], principal.username)) {
      return res.status(404).send("Not found");
    }

    const calendarId = decodePathSegment(collectionMatch[2]);
    const calendar = findCalendarForPrincipal(principal, trackedPubkeys, calendarId, {
      ...calendarOptions,
      channelTags: resolveChannelTags(db, principal)
    });
    if (!calendar) {
      return res.status(404).send("Not found");
    }

    const baseIssues = listVisibleIssuesForCalendar(db, principal, calendar);
    const baseCalEvents = listCalendarEventsForCalendar(db, calendar).filter((ev) =>
      calendarEventVisibleToPrincipal(ev, principal)
    );
    const report = req.method === "REPORT"
      ? runReportQuery({ issues: baseIssues, calendarEvents: baseCalEvents, reportBody: req.body, syncToken })
      : null;
    const depth = String(req.header("depth") || "1");

    let rows;
    if (depth === "0" && req.method === "PROPFIND") {
      rows = [];
    } else if (report?.results) {
      rows = report.results;
    } else {
      const reportIssues = report?.issues || baseIssues;
      const reportCalEvents = report?.calendarEvents || baseCalEvents;
      rows = [
        ...reportIssues,
        ...reportCalEvents.map((ev) => ({ _isCalEvent: true, item: ev }))
      ];
    }

    console.log(
      `[caldav] principal=${principal.username} calendar=${calendarId} method=${req.method} depth=${depth} report=${
        report?.type || "none"
      } issues=${baseIssues.length} calEvents=${baseCalEvents.length} rows=${rows.length}`
    );

    return xmlResponse(res, 207, multistatusForCollection(caldavConfig.baseUrl, principal.username, calendarId, syncToken, rows));
  });

  app.get(/^\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\.ics$/, (req, res) => {
    const [, rawUser, rawCalendarId, rawUid] = req.path.match(/^\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\.ics$/) || [];
    const user = decodePathSegment(rawUser);
    const calendarId = decodePathSegment(rawCalendarId);
    const uid = decodePathSegment(rawUid);
    const principal = req.principal;

    if (user !== principal.username) {
      return res.status(404).send("Not found");
    }

    const calendar = findCalendarForPrincipal(principal, trackedPubkeys, calendarId, {
      ...calendarOptions,
      channelTags: resolveChannelTags(db, principal)
    });
    if (!calendar) return res.status(404).send("Not found");

    const calEvent = db.getCalendarEventByUid?.(uid);
    if (calEvent && calendarEventVisibleToPrincipal(calEvent, principal)) {
      res.set("Content-Type", "text/calendar; charset=utf-8");
      res.set("ETag", calEvent.caldav_etag || `\"${calEvent.event_id}\"`);
      return res.status(200).send(calendarEventToVevent(calEvent));
    }

    const issue = db.getIssueByUid(uid);
    if (
      !issue ||
      db.issueHasSubtasks?.(issue.event_id) ||
      !issueVisibleInCalendar(issue, calendar) ||
      !issueVisibleToPrincipal(issue, principal, { getIssueByEventId: db.getIssueByEventId })
    ) {
      return res.status(404).send("Not found");
    }

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("ETag", issue.caldav_etag || `\"${issue.event_id}\"`);
    return res.status(200).send(issueToVtodo(issue));
  });

  app.put(/^\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\.ics$/, async (req, res) => {
    const [, rawUser, rawCalendarId, rawUid] = req.path.match(/^\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\.ics$/) || [];
    const user = decodePathSegment(rawUser);
    const calendarId = decodePathSegment(rawCalendarId);
    const uid = decodePathSegment(rawUid);
    const principal = req.principal;

    if (user !== principal.username) {
      db.logSync({
        direction: "caldav_to_nostr",
        eventId: uid,
        action: "put_rejected_wrong_principal"
      });
      return res.status(404).send("Not found");
    }

    const calendar = findCalendarForPrincipal(principal, trackedPubkeys, calendarId, {
      ...calendarOptions,
      channelTags: resolveChannelTags(db, principal)
    });
    if (!calendar) {
      db.logSync({
        direction: "caldav_to_nostr",
        eventId: uid,
        action: "put_rejected_unknown_calendar"
      });
      return res.status(404).send("Not found");
    }

    const issue = db.getIssueByUid(uid);
    if (!issue) {
      const created = await processVtodoCreate({
        db,
        syncService,
        uid,
        body: req.body,
        channelTag: calendar.channelTag || null,
        authContext: req.authContext
      });

      if (created.etag) {
        res.set("ETag", created.etag);
      }
      if (created.status === 201) {
        db.logSync({
          direction: "caldav_to_nostr",
          eventId: created.eventId || uid,
          action: "put_created_201"
        });
      }
      return res.status(created.status).send(created.error || "");
    }

    if (
      db.issueHasSubtasks?.(issue.event_id) ||
      !issueVisibleInCalendar(issue, calendar) ||
      !issueVisibleToPrincipal(issue, principal, { getIssueByEventId: db.getIssueByEventId })
    ) {
      db.logSync({
        direction: "caldav_to_nostr",
        eventId: uid,
        action: "put_rejected_not_visible"
      });
      return res.status(404).send("Not found");
    }

    db.logSync({
      direction: "caldav_to_nostr",
      eventId: issue.event_id,
      action: "put_received"
    });

    const result = await processVtodoPut({
      db,
      syncService,
      uid,
      ifMatch: req.header("if-match"),
      body: req.body,
      authContext: req.authContext
    });

    if (result.etag) {
      res.set("ETag", result.etag);
    }

    if (result.status === 204) {
      db.logSync({
        direction: "caldav_to_nostr",
        eventId: issue.event_id,
        action: "put_applied_204"
      });
      return res.status(204).end();
    }

    db.logSync({
      direction: "caldav_to_nostr",
      eventId: issue.event_id,
      action: `put_failed_${result.status}`,
      error: result.error
    });

    return res.status(result.status).send(result.error);
  });

  app.delete(/^\/calendars\/([^/]+)\/([^/]+)\/([^/]+)\.ics$/, (_req, res) => {
    return res.status(405).send("Deleting tasks is not supported");
  });

  app.all("*", (_req, res) => res.status(404).send("Not found"));

  return app;
}
