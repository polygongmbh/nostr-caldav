import express from "express";
import morgan from "morgan";
import { issueToVtodo } from "./ical.js";

function basicAuth(expectedUser, expectedPass) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme !== "Basic" || !encoded) {
      res.set("WWW-Authenticate", 'Basic realm="nostr-caldav"');
      return res.status(401).end();
    }

    const [user, pass] = Buffer.from(encoded, "base64").toString("utf8").split(":");
    if (user !== expectedUser || pass !== expectedPass) {
      return res.status(403).send("Forbidden");
    }
    return next();
  };
}

function xmlResponse(res, code, body) {
  res.status(code);
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.send(body);
}

function objectPath(user, uid) {
  return `/calendars/${user}/nostr-issues/${uid}.ics`;
}

function multistatusForCollection(baseUrl, user, token, issues) {
  const responses = issues
    .map((issue) => {
      const href = `${baseUrl}${objectPath(user, issue.caldav_uid)}`;
      return `
  <d:response>
    <d:href>${href}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>${issue.caldav_etag}</d:getetag>
        <c:calendar-data/>
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

export function createCaldavServer({ db, caldavConfig }) {
  const app = express();
  const user = caldavConfig.username;

  app.use(morgan("combined"));
  app.use(express.text({ type: "*/*", limit: "2mb" }));
  app.use(basicAuth(caldavConfig.username, caldavConfig.password));

  app.use((req, res, next) => {
    res.set("DAV", "1, calendar-access");
    next();
  });

  app.get("/.well-known/caldav", (_req, res) => {
    res.redirect(302, `/calendars/${user}/`);
  });

  app.use((req, res, next) => {
    if (req.method !== "PROPFIND" && req.method !== "REPORT") return next();

    const syncToken = db.getSyncToken();
    const issues = db.listIssues();

    if (req.path === `/${".well-known"}/caldav`) {
      return xmlResponse(
        res,
        207,
        `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/calendars/${user}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`
      );
    }

    if (req.path === `/calendars/${user}/` || req.path === `/calendars/${user}/nostr-issues/`) {
      return xmlResponse(res, 207, multistatusForCollection(caldavConfig.baseUrl, user, syncToken, issues));
    }

    return res.status(404).send("Not found");
  });

  app.get(`/calendars/${user}/nostr-issues/:uid.ics`, (req, res) => {
    const issue = db.getIssueByUid(req.params.uid);
    if (!issue) return res.status(404).send("Not found");

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("ETag", issue.caldav_etag || `\"${issue.event_id}\"`);
    return res.status(200).send(issueToVtodo(issue));
  });

  app.put(`/calendars/${user}/nostr-issues/:uid.ics`, (_req, res) => {
    return res.status(405).send("Read-only in phase 1");
  });

  app.delete(`/calendars/${user}/nostr-issues/:uid.ics`, (_req, res) => {
    return res.status(405).send("Read-only in phase 1");
  });

  app.all("*", (_req, res) => res.status(404).send("Not found"));

  return app;
}
