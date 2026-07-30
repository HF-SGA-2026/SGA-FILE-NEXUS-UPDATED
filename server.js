const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const JSZip = require("./website-deploy/vendor/jszip.min.js");
const { createFolderDiscarderService } = require("./backend/folder-discarder-service");
const { createBackupDiscarderService } = require("./backend/backup-discarder-service");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "website-deploy");
const SCANS = new Map();
const EXPORTS = new Map();
const folderDiscarderService = createFolderDiscarderService();
const backupDiscarderService = createBackupDiscarderService();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm"
};

function send(res, statusCode, headers, body = "") {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendJson(res, statusCode, data) {
  send(res, statusCode, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify(data));
}

function resolvePublicPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const requestedPath = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  return filePath;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/status") {
    sendJson(res, 200, { ok: true, app: "SGA FILE NEXUS", serverExport: true });
    return;
  }

  if (req.method === "POST" && req.url === "/api/export-zip") {
    handleServerExport(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/scan-folder") {
    handleScanFolder(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/export-server-folder") {
    handleServerFolderExport(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/prepare-server-folder-export") {
    handlePrepareServerFolderExport(req, res);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/download-server-folder-export/")) {
    handleDownloadServerFolderExport(req, res);
    return;
  }

  if (folderDiscarderService.handle(req, res)) {
    return;
  }

  if (backupDiscarderService.handle(req, res)) {
    return;
  }

  if (!["GET", "HEAD"].includes(req.method)) {
    send(res, 405, { Allow: "GET, HEAD" }, "Method not allowed");
    return;
  }

  const filePath = resolvePublicPath(req.url || "/");
  if (!filePath) {
    send(res, 403, { "Content-Type": "text/plain; charset=utf-8" }, "Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    const finalPath = !statError && stats.isDirectory()
      ? path.join(filePath, "index.html")
      : filePath;

    fs.readFile(finalPath, (readError, data) => {
      if (readError) {
        send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
        return;
      }

      const extension = path.extname(finalPath).toLowerCase();
      send(res, 200, {
        "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
        "Cache-Control": "no-store"
      }, req.method === "HEAD" ? "" : data);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SGA FILE NEXUS server running at http://${HOST}:${PORT}/`);
});

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getMultipartBoundary(contentType = "") {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2]) : "";
}

function parseContentDisposition(value = "") {
  const result = {};
  value.split(";").forEach(part => {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey || !rawValue.length) return;
    result[rawKey.toLowerCase()] = rawValue.join("=").replace(/^"|"$/g, "");
  });
  return result;
}

function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(boundaryBuffer);

  while (cursor !== -1) {
    const next = buffer.indexOf(boundaryBuffer, cursor + boundaryBuffer.length);
    if (next === -1) break;

    let start = cursor + boundaryBuffer.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;

    let end = next;
    if (buffer[end - 2] === 13 && buffer[end - 1] === 10) end -= 2;

    const part = buffer.subarray(start, end);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString("utf8");
      const content = part.subarray(headerEnd + 4);
      const headers = {};
      headerText.split("\r\n").forEach(line => {
        const index = line.indexOf(":");
        if (index === -1) return;
        headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
      });
      const disposition = parseContentDisposition(headers["content-disposition"]);
      parts.push({ headers, disposition, content });
    }

    cursor = next;
  }

  return parts;
}

function sanitizeZipName(fileName) {
  const safeName = String(fileName || "SGA_File_Nexus_Export.zip").replace(/[\\/:*?"<>|]+/g, "_");
  return safeName.toLowerCase().endsWith(".zip") ? safeName : `${safeName}.zip`;
}

function streamZip(res, zip, zipName) {
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${sanitizeZipName(zipName)}"`,
    "Cache-Control": "no-store"
  });
  zip.generateNodeStream({
    type: "nodebuffer",
    compression: "STORE",
    streamFiles: true,
    platform: "UNIX"
  }).pipe(res);
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  return JSON.parse(body.toString("utf8") || "{}");
}

function normalizeRelativePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
}

function isSystemFileName(name) {
  const lower = String(name || "").toLowerCase();
  return lower === ".ds_store" || lower === "thumbs.db" || lower === "desktop.ini" || lower.startsWith("._");
}

async function hashDiskFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function walkFolder(rootPath, currentPath, mainFolderName, files, folderPaths) {
  const entries = await fsp.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentPath, entry.name);
    const relativeFromRoot = path.relative(rootPath, absolutePath).split(path.sep).join("/");
    const appPath = normalizeRelativePath(path.posix.join(mainFolderName, relativeFromRoot));

    if (entry.isDirectory()) {
      folderPaths.add(appPath);
      await walkFolder(rootPath, absolutePath, mainFolderName, files, folderPaths);
      continue;
    }

    if (!entry.isFile()) continue;

    const stats = await fsp.stat(absolutePath);
    const hash = isSystemFileName(entry.name) ? "" : await hashDiskFile(absolutePath);
    files.push({
      path: appPath,
      diskPath: absolutePath,
      name: entry.name,
      size: stats.size,
      lastModified: stats.mtimeMs,
      hash
    });
  }
}

async function handleScanFolder(req, res) {
  try {
    const { folderPath } = await readJsonBody(req);
    const rootPath = path.resolve(String(folderPath || "").trim());
    const stats = await fsp.stat(rootPath);

    if (!stats.isDirectory()) {
      sendJson(res, 400, { error: "That path is not a folder." });
      return;
    }

    const mainFolderName = path.basename(rootPath);
    const files = [];
    const folderPaths = new Set([mainFolderName]);
    await walkFolder(rootPath, rootPath, mainFolderName, files, folderPaths);

    const scanId = crypto.randomUUID();
    SCANS.set(scanId, {
      rootPath,
      mainFolderName,
      files: new Map(files.map(file => [file.path, file]))
    });

    sendJson(res, 200, {
      scanId,
      rootPath,
      mainFolderName,
      files: files.map(({ diskPath, ...file }) => file),
      folderPaths: [...folderPaths]
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleServerFolderExport(req, res) {
  try {
    const manifest = await readJsonBody(req);
    const scan = SCANS.get(manifest.scanId);
    if (!scan) {
      sendJson(res, 404, { error: "Server scan was not found. Scan the folder again." });
      return;
    }

    const zip = new JSZip();
    for (const folderPath of manifest.emptyFolders || []) {
      zip.folder(folderPath);
    }

    for (const entry of manifest.files || []) {
      const source = scan.files.get(entry.originalPath);
      if (!source || !entry.outputPath) continue;
      const data = await fsp.readFile(source.diskPath);
      zip.file(entry.outputPath, data, {
        binary: true,
        compression: "STORE",
        date: source.lastModified ? new Date(source.lastModified) : undefined
      });
    }

    streamZip(res, zip, manifest.zipName);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handlePrepareServerFolderExport(req, res) {
  try {
    const manifest = await readJsonBody(req);
    if (!SCANS.has(manifest.scanId)) {
      sendJson(res, 404, { error: "Server scan was not found. Scan the folder again." });
      return;
    }

    const exportId = crypto.randomUUID();
    EXPORTS.set(exportId, manifest);
    sendJson(res, 200, {
      exportId,
      zipName: sanitizeZipName(manifest.zipName),
      downloadUrl: `/api/download-server-folder-export/${exportId}`
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleDownloadServerFolderExport(req, res) {
  try {
    const exportId = req.url.split("/").pop();
    const manifest = EXPORTS.get(exportId);
    if (!manifest) {
      sendJson(res, 404, { error: "Prepared export was not found. Export the ZIP again." });
      return;
    }

    const scan = SCANS.get(manifest.scanId);
    if (!scan) {
      sendJson(res, 404, { error: "Server scan was not found. Scan the folder again." });
      return;
    }

    const zip = new JSZip();
    for (const folderPath of manifest.emptyFolders || []) {
      zip.folder(folderPath);
    }

    for (const entry of manifest.files || []) {
      const source = scan.files.get(entry.originalPath);
      if (!source || !entry.outputPath) continue;
      zip.file(entry.outputPath, fs.createReadStream(source.diskPath), {
        binary: true,
        compression: "STORE",
        date: source.lastModified ? new Date(source.lastModified) : undefined
      });
    }

    streamZip(res, zip, manifest.zipName);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleServerExport(req, res) {
  try {
    const boundary = getMultipartBoundary(req.headers["content-type"] || "");
    if (!boundary) {
      sendJson(res, 400, { error: "Missing multipart boundary." });
      return;
    }

    const body = await readRequestBody(req);
    const parts = parseMultipart(body, boundary);
    const manifestPart = parts.find(part => part.disposition.name === "manifest");
    if (!manifestPart) {
      sendJson(res, 400, { error: "Missing export manifest." });
      return;
    }

    const manifest = JSON.parse(manifestPart.content.toString("utf8"));
    const fileEntries = new Map((manifest.files || []).map(entry => [entry.originalPath, entry]));
    const zip = new JSZip();

    for (const folderPath of manifest.emptyFolders || []) {
      zip.folder(folderPath);
    }

    for (const part of parts) {
      const name = part.disposition.name || "";
      if (!name.startsWith("file:")) continue;
      const originalPath = decodeURIComponent(name.slice(5));
      const entry = fileEntries.get(originalPath);
      if (!entry || !entry.outputPath) continue;
      zip.file(entry.outputPath, part.content, {
        binary: true,
        compression: "STORE",
        date: entry.lastModified ? new Date(entry.lastModified) : undefined
      });
    }

    streamZip(res, zip, manifest.zipName);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}
