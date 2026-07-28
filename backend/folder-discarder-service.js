"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const QUARANTINE_FOLDER = "SGA_FILE_NEXUS_QUARANTINE";
const SYSTEM_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function createFolderDiscarderService() {
  let activeJob = null;
  const routes = new Set(["/api/health", "/api/check-path", "/api/scan", "/api/discard", "/api/restore", "/api/cancel"]);

  function handle(req, res) {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (!routes.has(requestUrl.pathname)) return false;
    run(req, res, requestUrl.pathname).catch(error => sendJson(res, error.statusCode || 500, { error: error.message }));
    return true;
  }

  async function run(req, res, pathname) {
    authorize(req);
    if (pathname === "/api/health" && req.method === "GET") {
      const roots = allowedRoots();
      sendJson(res, 200, { ok: true, cleanupEnabled: roots.length > 0, allowedRootCount: roots.length, quarantineFolder: QUARANTINE_FOLDER });
      return;
    }
    if (pathname === "/api/cancel" && req.method === "POST") {
      if (activeJob) activeJob.cancelled = true;
      sendJson(res, 200, { ok: true, message: activeJob ? "Cancel requested for the current scan." : "No active scan." });
      return;
    }
    if (req.method !== "POST") throw httpError(405, "Method not allowed.");
    const body = await readJson(req);
    if (pathname === "/api/check-path") {
      const root = await validateRoot(body.rootPath);
      sendJson(res, 200, { ok: true, rootPath: root });
      return;
    }
    if (pathname === "/api/scan") {
      const root = await validateRoot(body.rootPath);
      if (activeJob) throw httpError(409, "Another folder scan is already running.");
      const job = { cancelled: false };
      activeJob = job;
      try {
        sendJson(res, 200, { ok: true, ...(await scanRoot(root, body.settings || {}, job)) });
      } finally {
        if (activeJob === job) activeJob = null;
      }
      return;
    }
    if (pathname === "/api/discard") {
      sendJson(res, 200, { ok: true, ...(await quarantineFolders(body)) });
      return;
    }
    if (pathname === "/api/restore") {
      sendJson(res, 200, { ok: true, ...(await restoreLatest(body.rootPath)) });
      return;
    }
    throw httpError(404, "Not found.");
  }

  return Object.freeze({ handle });
}

function allowedRoots() {
  return String(process.env.SGA_NEXUS_ALLOWED_ROOTS || "").split(";").map(value => value.trim()).filter(Boolean).map(value => path.resolve(value));
}

async function validateRoot(input) {
  if (!input) throw httpError(400, "Server folder path is required.");
  const resolved = path.resolve(String(input));
  const roots = allowedRoots();
  if (!roots.length) throw httpError(503, "No approved roots are configured. Set SGA_NEXUS_ALLOWED_ROOTS before using Full Local Mode.");
  if (!roots.some(root => isInside(root, resolved))) throw httpError(403, "That folder is outside the approved server roots.");
  const stats = await fsp.stat(resolved).catch(() => null);
  if (!stats?.isDirectory()) throw httpError(404, "Server folder was not found or is not a directory.");
  return resolved;
}

async function scanRoot(root, settings, job) {
  const startedAt = Date.now();
  const directories = new Map();
  let scannedFolders = 0;
  const visit = async (diskPath, relativePath = "") => {
    if (job.cancelled) throw httpError(499, "Scan canceled.");
    const folderStats = await fsp.stat(diskPath);
    const record = { relativePath, files: [], children: [], lastModified: folderStats.mtimeMs };
    directories.set(relativePath, record);
    scannedFolders += 1;
    const entries = await fsp.readdir(diskPath, { withFileTypes: true });
    for (const entry of entries) {
      if (job.cancelled) throw httpError(499, "Scan canceled.");
      if (!relativePath && entry.name === QUARANTINE_FOLDER) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const child = relativePath ? path.join(relativePath, entry.name) : entry.name;
        record.children.push(child);
        await visit(path.join(diskPath, entry.name), child);
      } else if (entry.isFile()) {
        record.files.push(entry.name);
      }
    }
  };
  await visit(root);
  const memo = new Map();
  const statsFor = relativePath => {
    if (memo.has(relativePath)) return memo.get(relativePath);
    const record = directories.get(relativePath);
    let files = 0;
    let usable = 0;
    for (const name of record.files) {
      files += 1;
      const lower = name.toLowerCase();
      if (!SYSTEM_FILES.has(lower) && !lower.startsWith("._")) usable += 1;
    }
    for (const child of record.children) {
      const childStats = statsFor(child);
      files += childStats.files;
      usable += childStats.usable;
    }
    const result = { files, usable };
    memo.set(relativePath, result);
    return result;
  };
  const protectedWords = (Array.isArray(settings.protectedRules)
    ? settings.protectedRules
    : String(settings.protectedRules || "").split(/\r?\n|,/)
  ).map(value => String(value).trim().toLowerCase()).filter(Boolean);
  const strict = (settings.emptyDefinition || settings.emptyMode) === "strict";
  const ageDays = Number(settings.ageFilter || 0);
  const cutoff = ageDays > 0 ? Date.now() - (ageDays * 24 * 60 * 60 * 1000) : 0;
  const rows = [];
  for (const [relativePath, record] of directories) {
    if (!relativePath) continue;
    const stats = statsFor(relativePath);
    if (!(strict ? stats.files === 0 : stats.usable === 0)) continue;
    if (cutoff && record.lastModified > cutoff) continue;
    const displayPath = path.join(root, relativePath);
    const protectedWord = protectedWords.find(word => displayPath.toLowerCase().includes(word));
    const parent = relativePath.split(/[\\/]/)[0];
    rows.push({
      path: displayPath,
      relativePath,
      parent,
      lastModified: record.lastModified,
      status: protectedWord ? "protected" : "ready",
      reason: protectedWord ? `Protected by “${protectedWord}”` : (record.children.length ? "Empty folder chain" : (stats.files ? "Only ignored system files" : "Completely empty"))
    });
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const parentFolders = [...new Set([...directories.keys()].filter(Boolean).map(relativePath => relativePath.split(/[\\/]/)[0]))].map(name => {
    const prefix = `${name}${path.sep}`;
    const folderCount = [...directories.keys()].filter(relativePath => relativePath === name || relativePath.startsWith(prefix)).length;
    const parentRows = rows.filter(row => row.parent === name);
    return {
      name,
      folderCount,
      emptyCount: parentRows.length,
      protectedCount: parentRows.filter(row => row.status === "protected").length
    };
  });
  const protectedFolders = rows.filter(row => row.status === "protected").length;
  return {
    rootPath: root,
    sourceLabel: "Full Local Mode",
    mainFolderName: path.basename(root),
    hasWriteAccess: true,
    scannedFolders,
    parentFolders,
    rows,
    stats: {
      foldersScanned: scannedFolders,
      emptyFolderRows: rows.length,
      emptyFoldersFound: rows.length - protectedFolders,
      protectedFolders,
      elapsedMs: Date.now() - startedAt
    }
  };
}

async function quarantineFolders(body) {
  if (!body.approval) throw httpError(400, "Review approval is required.");
  if (body.quarantine === false) throw httpError(400, "Permanent deletion is disabled. Quarantine is required.");
  const root = await validateRoot(body.rootPath);
  const selected = compressRelativePaths(body.relativePaths || []);
  if (!selected.length) throw httpError(400, "No folders were selected.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runPath = path.join(root, QUARANTINE_FOLDER, stamp);
  await fsp.mkdir(runPath, { recursive: true });
  const processed = [];
  const failures = [];
  const manifest = [];
  for (const relativePath of selected) {
    try {
      const source = resolveInside(root, relativePath);
      const strict = (body.settings?.emptyDefinition || body.settings?.emptyMode) === "strict";
      if (!await isEmptyTree(source, strict)) throw new Error("Folder is no longer empty.");
      const target = path.join(runPath, relativePath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rename(source, target);
      const displayPath = path.join(root, relativePath);
      processed.push({ path: displayPath, relativePath });
      manifest.push({ relativePath });
    } catch (error) {
      failures.push({ path: path.join(root, relativePath), relativePath, message: error.message });
    }
  }
  await fsp.writeFile(path.join(runPath, "manifest.json"), JSON.stringify({ root, createdAt: new Date().toISOString(), entries: manifest }, null, 2));
  return { processed, failures, quarantinePath: runPath, message: `${processed.length} folder(s) moved to quarantine; ${failures.length} failed.` };
}

async function restoreLatest(input) {
  const root = await validateRoot(input);
  const quarantineRoot = path.join(root, QUARANTINE_FOLDER);
  const runs = (await fsp.readdir(quarantineRoot, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().reverse();
  if (!runs.length) throw httpError(404, "No quarantine run was found for this server path.");
  const runPath = path.join(quarantineRoot, runs[0]);
  const manifest = JSON.parse(await fsp.readFile(path.join(runPath, "manifest.json"), "utf8"));
  const restored = [];
  const failures = [];
  for (const entry of [...manifest.entries].sort((a, b) => a.relativePath.split(/[\\/]/).length - b.relativePath.split(/[\\/]/).length)) {
    try {
      const source = resolveInside(runPath, entry.relativePath);
      const target = resolveInside(root, entry.relativePath);
      if (fs.existsSync(target)) throw new Error("Original path already exists.");
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rename(source, target);
      restored.push({ path: target, relativePath: entry.relativePath });
    } catch (error) {
      failures.push({ relativePath: entry.relativePath, message: error.message });
    }
  }
  return { restored, failures, quarantinePath: runPath, message: `${restored.length} folder(s) restored; ${failures.length} failed.` };
}

async function isEmptyTree(folder, strict) {
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) return false;
    if (entry.isDirectory()) {
      if (!await isEmptyTree(path.join(folder, entry.name), strict)) return false;
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (strict || (!SYSTEM_FILES.has(lower) && !lower.startsWith("._"))) return false;
    }
  }
  return true;
}

function compressRelativePaths(values) {
  const safe = [...new Set(values.map(value => String(value || "").trim()).filter(Boolean).map(value => path.normalize(value)))].filter(value => !path.isAbsolute(value) && !value.startsWith(".."));
  safe.sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length);
  return safe.filter(value => !safe.some(parent => parent !== value && isInside(parent, value)));
}

function resolveInside(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (!isInside(root, resolved) || resolved === path.resolve(root)) throw httpError(403, "Unsafe folder path.");
  return resolved;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function authorize(req) {
  const required = process.env.SGA_NEXUS_API_KEY;
  if (required && req.headers["x-sga-nexus-key"] !== required) throw httpError(401, "Invalid backend key.");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(httpError(413, "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(httpError(400, "Invalid JSON request body.")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  if (res.headersSent) return;
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = { createFolderDiscarderService, QUARANTINE_FOLDER };
