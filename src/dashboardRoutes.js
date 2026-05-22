"use strict";

const path = require("path");

function escapeCsv(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function requireDashboardAuth(req, res, next) {
  const pin = process.env.DASHBOARD_PIN || process.env.ADMIN_API_KEY || "123456";
  const cookieOk = String(req.headers.cookie || "").includes("dashboard_session=active");
  const headerPin = req.headers["x-dashboard-pin"] === pin;
  const queryPin = req.query.pin === pin;

  if (cookieOk || headerPin || queryPin) return next();

  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

function attachDashboardRoutes(app, { store, publicDir }) {
  app.get("/dashboard", (_req, res) => {
    res.sendFile(path.join(publicDir, "dashboard.html"));
  });

  app.post("/api/dashboard/login", (req, res) => {
    const pin = process.env.DASHBOARD_PIN || process.env.ADMIN_API_KEY || "123456";

    if (!req.body || req.body.pin !== pin) {
      return res.status(401).json({ ok: false, error: "Sai mã PIN" });
    }

    res.cookie("dashboard_session", "active", {
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000
    });

    return res.json({ ok: true });
  });

  app.post("/api/dashboard/logout", (_req, res) => {
    res.clearCookie("dashboard_session");
    res.json({ ok: true });
  });

  app.get("/api/dashboard/session", (req, res) => {
    const cookieOk = String(req.headers.cookie || "").includes("dashboard_session=active");
    res.json({ ok: true, authenticated: cookieOk });
  });

  app.get("/api/dashboard/summary", requireDashboardAuth, (req, res) => {
    const filtered = store.filterRecords(req.query);
    res.json({ ok: true, summary: store.getSummary(filtered) });
  });

  app.get("/api/dashboard/records", requireDashboardAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "100", 10), 1000);
    const filtered = store.filterRecords(req.query).slice(0, limit);

    if (req.query.keyword || req.query.status || req.query.source || req.query.from || req.query.to) {
      store.addHistory({
        keyword: req.query.keyword || req.query.source || req.query.from || "filter",
        status: req.query.status || "all",
        resultCount: filtered.length
      });
    }

    res.json({
      ok: true,
      records: filtered,
      summary: store.getSummary(filtered)
    });
  });

  app.get("/api/dashboard/history", requireDashboardAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "100", 10), 1000);
    res.json({ ok: true, history: store.getHistory(limit) });
  });

  app.get("/api/dashboard/logs", requireDashboardAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "100", 10), 1000);
    res.json({ ok: true, logs: store.getLogs(limit) });
  });

  app.get("/api/dashboard/export.csv", requireDashboardAuth, (req, res) => {
    const data = store.filterRecords(req.query);
    const columns = ["id", "user", "keyword", "status", "value", "source", "note", "createdAt"];
    const rows = data.map(row => columns.map(col => escapeCsv(row[col])).join(","));
    const csv = [columns.join(","), ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=dashboard-export.csv");
    res.send("\ufeff" + csv);
  });

  app.get("/api/dashboard/export.xls", requireDashboardAuth, (req, res) => {
    const data = store.filterRecords(req.query);
    const columns = ["id", "user", "keyword", "status", "value", "source", "note", "createdAt"];
    const htmlRows = data.map(row => (
      "<tr>" + columns.map(col => `<td>${String(row[col] ?? "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</td>`).join("") + "</tr>"
    )).join("");

    const html = `
      <html>
        <head><meta charset="UTF-8"></head>
        <body>
          <table>
            <thead><tr>${columns.map(col => `<th>${col}</th>`).join("")}</tr></thead>
            <tbody>${htmlRows}</tbody>
          </table>
        </body>
      </html>
    `;

    res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=dashboard-export.xls");
    res.send(html);
  });
}

module.exports = { attachDashboardRoutes };
