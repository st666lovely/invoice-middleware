"use strict";

const MAX_RECORDS = Number(process.env.DASHBOARD_MAX_RECORDS || 5000);
const MAX_LOGS = Number(process.env.DASHBOARD_MAX_LOGS || 1000);
const MAX_HISTORY = Number(process.env.DASHBOARD_MAX_HISTORY || 1000);

const records = [];
const logs = [];
const searchHistory = [];

function normalizeStatus(status) {
  return String(status || "unknown").trim().toLowerCase().replace(/\s+/g, "_");
}

function addRecord(input) {
  const record = {
    id: String(input.id || Date.now()),
    user: String(input.user || "unknown"),
    keyword: String(input.keyword || "-"),
    status: normalizeStatus(input.status),
    value: Number(input.value || 0),
    source: String(input.source || "system"),
    note: input.note || null,
    createdAt: input.createdAt || new Date().toISOString()
  };

  records.unshift(record);
  if (records.length > MAX_RECORDS) records.pop();

  return record;
}

function addLog(input) {
  logs.unshift({
    id: Date.now().toString() + Math.random().toString(16).slice(2),
    ts: input.ts || new Date().toISOString(),
    level: input.level || "info",
    msg: input.msg || "",
    meta: input.meta || {}
  });

  if (logs.length > MAX_LOGS) logs.pop();
}

function addHistory(input) {
  searchHistory.unshift({
    id: Date.now().toString() + Math.random().toString(16).slice(2),
    keyword: input.keyword || "",
    status: input.status || "all",
    resultCount: Number(input.resultCount || 0),
    createdAt: new Date().toISOString()
  });

  if (searchHistory.length > MAX_HISTORY) searchHistory.pop();
}

function filterRecords({ keyword = "", status = "", source = "", from = "", to = "" } = {}) {
  const kw = String(keyword || "").toLowerCase().trim();
  const st = String(status || "").toLowerCase().trim();
  const src = String(source || "").toLowerCase().trim();
  const fromTime = from ? new Date(from).getTime() : null;
  const toTime = to ? new Date(to).getTime() : null;

  return records.filter(item => {
    const created = new Date(item.createdAt).getTime();
    const matchKeyword = !kw || [item.id, item.user, item.keyword, item.note, item.source]
      .filter(Boolean)
      .some(v => String(v).toLowerCase().includes(kw));
    const matchStatus = !st || item.status === st;
    const matchSource = !src || item.source === src;
    const matchFrom = !fromTime || created >= fromTime;
    const matchTo = !toTime || created <= toTime;

    return matchKeyword && matchStatus && matchSource && matchFrom && matchTo;
  });
}

function getSummary(source = records) {
  const statusMap = {};
  const sourceMap = {};
  let totalValue = 0;

  for (const item of source) {
    statusMap[item.status] = (statusMap[item.status] || 0) + 1;
    sourceMap[item.source] = (sourceMap[item.source] || 0) + 1;
    totalValue += Number(item.value || 0);
  }

  const byStatus = Object.entries(statusMap)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  const bySource = Object.entries(sourceMap)
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  const timelineMap = {};
  for (const item of source.slice().reverse()) {
    const d = new Date(item.createdAt);
    const key = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    timelineMap[key] = (timelineMap[key] || 0) + 1;
  }

  const timeline = Object.entries(timelineMap).slice(-30).map(([label, count]) => ({ label, count }));

  return {
    total: source.length,
    totalValue,
    byStatus,
    bySource,
    timeline,
    latest: source.slice(0, 20),
    generatedAt: new Date().toISOString()
  };
}

function getAllRecords() {
  return records;
}

function getLogs(limit = 100) {
  return logs.slice(0, limit);
}

function getHistory(limit = 100) {
  return searchHistory.slice(0, limit);
}

module.exports = {
  addRecord,
  addLog,
  addHistory,
  filterRecords,
  getSummary,
  getAllRecords,
  getLogs,
  getHistory
};
