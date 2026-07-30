"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

const REVIEW_BIN = "Review_Bin";
const API_PREFIX = "/api/backup-discarder";
const MAX_SCANNED_FILES = 100000;

function createBackupDiscarderService() {
  const session = {
    serverRootPath: "",
    serverRootRealPath: "",
    mainFolderPath: "",
    activeScanId: "",
    currentScan: null,
    movedFiles: new Map()
  };
  const routes = new Set([
    `${API_PREFIX}/status`,
    `${API_PREFIX}/select-folder`,
    `${API_PREFIX}/choose-folder`,
    `${API_PREFIX}/resolve-main-folder`,
    `${API_PREFIX}/select-main-folder`,
    `${API_PREFIX}/move-to-review-bin`,
    `${API_PREFIX}/recover-from-review-bin`,
    `${API_PREFIX}/delete-permanently`
  ]);

  function handle(req, res) {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (!routes.has(requestUrl.pathname)) return false;
    run(req, res, requestUrl.pathname).catch(error => {
      sendJson(res, error.statusCode || 400, { ok: false, error: error.message });
    });
    return true;
  }

  async function run(req, res, pathname) {
    if (pathname === `${API_PREFIX}/status`) {
      if (req.method !== "GET") throw httpError(405, "Method not allowed.");
      sendJson(res, 200, {
        ok: true,
        rootPath: session.serverRootPath,
        serverRootPath: session.serverRootPath,
        mainFolderRelativePath: activeMainFolderRelativePath(),
        reviewBin: session.mainFolderPath ? path.join(session.mainFolderPath, REVIEW_BIN) : ""
      });
      return;
    }

    if (req.method !== "POST") throw httpError(405, "Method not allowed.");
    const body = await readJson(req);

    if (pathname === `${API_PREFIX}/select-folder`) {
      setServerRoot(body.serverRootPath || body.rootPath, "Selected server root");
      sendJson(res, 200, rootResponse());
      return;
    }

    if (pathname === `${API_PREFIX}/choose-folder`) {
      const selected = await chooseFolderWithWindowsDialog(
        "Choose a broad trusted root. Main Folders selected later must be inside this folder."
      );
      setServerRoot(selected, "Selected server root from picker");
      sendJson(res, 200, rootResponse());
      return;
    }

    if (pathname === `${API_PREFIX}/resolve-main-folder`) {
      sendJson(res, 200, await resolveMainFolderScan(body));
      return;
    }

    if (pathname === `${API_PREFIX}/select-main-folder`) {
      sendJson(res, 200, await selectMainFolderCandidate(body));
      return;
    }

    const context = createOperationContext(body);

    if (pathname === `${API_PREFIX}/move-to-review-bin`) {
      sendJson(res, 200, {
        ok: true,
        results: await processFiles(body.files, filePath => moveOneToReviewBin(context, filePath), "Move")
      });
      return;
    }

    if (pathname === `${API_PREFIX}/recover-from-review-bin`) {
      sendJson(res, 200, {
        ok: true,
        results: await processFiles(body.files, filePath => recoverOneFromReviewBin(context, filePath), "Recover")
      });
      return;
    }

    if (pathname === `${API_PREFIX}/delete-permanently`) {
      sendJson(res, 200, {
        ok: true,
        results: await processFiles(body.files, filePath => recycleOneFromReviewBin(context, filePath), "Recycle")
      });
      return;
    }

    throw httpError(404, "API endpoint not found.");
  }

  function rootResponse() {
    return {
      ok: true,
      rootPath: session.serverRootPath,
      serverRootPath: session.serverRootPath
    };
  }

  function setServerRoot(rootPath, logPrefix) {
    session.serverRootPath = normalizeDirectory(
      rootPath,
      "A server root folder path is required.",
      "Server root folder does not exist or is not a folder."
    );
    session.serverRootRealPath = fs.realpathSync.native(session.serverRootPath);
    clearActiveMainFolder();
    session.movedFiles = new Map();
    log(`${logPrefix}: ${session.serverRootPath}`);
  }

  function clearActiveMainFolder() {
    session.mainFolderPath = "";
    session.activeScanId = "";
    session.currentScan = null;
  }

  function assertServerRootConfigured() {
    if (!session.serverRootPath) throw new Error("No Local Server root folder is configured.");
  }

  async function resolveMainFolderScan(body) {
    assertServerRootConfigured();
    const descriptor = createScanDescriptor(body);
    const candidates = await findMatchingMainFolders(descriptor);
    const scanId = crypto.randomUUID();
    session.currentScan = { scanId, descriptor, candidates };
    session.mainFolderPath = "";
    session.activeScanId = "";

    if (!candidates.length) {
      return {
        ok: true,
        matchStatus: "none",
        scanId,
        candidates: [],
        error: "The selected folder could not be located inside the connected Local Server root. Confirm that the folder is stored under the connected root."
      };
    }

    if (candidates.length === 1) {
      activateMainFolder(scanId, candidates[0]);
      return {
        ok: true,
        matchStatus: "matched",
        scanId,
        mainFolderRelativePath: candidates[0].relativePath,
        candidates: []
      };
    }

    return {
      ok: true,
      matchStatus: "multiple",
      scanId,
      candidates: candidates.map(candidate => candidate.relativePath)
    };
  }

  async function selectMainFolderCandidate(body) {
    assertServerRootConfigured();
    const scan = session.currentScan;
    if (!scan || typeof body.scanId !== "string" || body.scanId !== scan.scanId) {
      throw httpError(409, "The Main Folder scan is no longer active. Scan the folder again.");
    }
    const requested = normalizeCandidateSelection(body.mainFolderRelativePath);
    const candidate = scan.candidates.find(item => normalizedPathKey(item.relativePath) === normalizedPathKey(requested));
    if (!candidate) {
      throw httpError(403, "The selected Main Folder candidate was not returned by the server.");
    }
    if (!await candidateStillMatches(candidate, scan.descriptor)) {
      throw httpError(409, "The selected Main Folder no longer matches the scanned browser folder.");
    }
    activateMainFolder(scan.scanId, candidate);
    return {
      ok: true,
      matchStatus: "matched",
      scanId: scan.scanId,
      mainFolderRelativePath: candidate.relativePath
    };
  }

  function activateMainFolder(scanId, candidate) {
    session.mainFolderPath = candidate.absolutePath;
    session.activeScanId = scanId;
  }

  function activeMainFolderRelativePath() {
    if (!session.serverRootPath || !session.mainFolderPath) return "";
    return path.relative(session.serverRootPath, session.mainFolderPath) || ".";
  }

  function createScanDescriptor(body) {
    const mainFolderName = normalizeMainFolderName(body.mainFolderName);
    if (!Array.isArray(body.scannedFiles) || !body.scannedFiles.length) {
      throw new Error("Scanned folder file paths are required.");
    }
    if (body.scannedFiles.length > MAX_SCANNED_FILES) {
      throw httpError(413, `Scanned folder exceeds the ${MAX_SCANNED_FILES}-file matching limit.`);
    }

    const filesByPath = new Map();
    for (const item of body.scannedFiles) {
      const inputPath = typeof item === "string" ? item : item?.relativePath;
      const parts = safeRelativeParts(inputPath, "Scanned file");
      if (parts[0]?.toLowerCase() === mainFolderName.toLowerCase()) parts.shift();
      if (!parts.length || isIgnoredApplicationPath(parts)) continue;
      const relativePath = path.join(...parts);
      const key = normalizedPathKey(relativePath);
      const rawSize = typeof item === "object" ? Number(item.size) : NaN;
      filesByPath.set(key, {
        relativePath,
        size: Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : null
      });
    }
    const files = [...filesByPath.values()];
    if (!files.length) throw new Error("No usable scanned file paths were supplied for Main Folder matching.");
    return { mainFolderName, files };
  }

  function normalizeMainFolderName(value) {
    const parts = safeRelativeParts(value, "Main Folder name");
    if (parts.length !== 1 || isIgnoredApplicationName(parts[0])) {
      throw new Error("Unsafe Main Folder name rejected.");
    }
    return parts[0];
  }

  async function findMatchingMainFolders(descriptor) {
    const candidates = [];
    const root = session.serverRootPath;

    const visit = async directoryPath => {
      if (!await isSafeDirectoryInsideRoot(directoryPath)) return;
      if (path.basename(directoryPath).toLowerCase() === descriptor.mainFolderName.toLowerCase() &&
          await folderMatchesDescriptor(directoryPath, descriptor)) {
        candidates.push({
          absolutePath: directoryPath,
          relativePath: path.relative(root, directoryPath) || "."
        });
      }

      const entries = await fsp.readdir(directoryPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || isIgnoredApplicationName(entry.name)) continue;
        const childPath = path.resolve(directoryPath, entry.name);
        if (!isInside(root, childPath)) continue;
        await visit(childPath);
      }
    };

    await visit(root);
    candidates.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: "base", numeric: true }));
    return candidates;
  }

  async function isSafeDirectoryInsideRoot(directoryPath) {
    if (!isInside(session.serverRootPath, directoryPath)) return false;
    const stats = await fsp.lstat(directoryPath).catch(() => null);
    if (!stats?.isDirectory() || stats.isSymbolicLink()) return false;
    const realPath = await fsp.realpath(directoryPath).catch(() => "");
    return Boolean(realPath) && isInside(session.serverRootRealPath, realPath);
  }

  async function folderMatchesDescriptor(candidatePath, descriptor) {
    for (const file of descriptor.files) {
      const filePath = path.resolve(candidatePath, file.relativePath);
      if (!isInside(candidatePath, filePath) || !isInside(session.serverRootPath, filePath)) return false;
      const stats = await fsp.lstat(filePath).catch(() => null);
      if (!stats?.isFile() || stats.isSymbolicLink()) return false;
      if (file.size !== null && stats.size !== file.size) return false;
      const realPath = await fsp.realpath(filePath).catch(() => "");
      if (!realPath || !isInside(session.serverRootRealPath, realPath)) return false;
    }
    return true;
  }

  async function candidateStillMatches(candidate, descriptor) {
    return await isSafeDirectoryInsideRoot(candidate.absolutePath) &&
      await folderMatchesDescriptor(candidate.absolutePath, descriptor);
  }

  function normalizeCandidateSelection(inputPath) {
    if (inputPath === ".") return ".";
    return safeRelativeInput(inputPath, "Main Folder candidate");
  }

  function createOperationContext(body) {
    assertServerRootConfigured();
    if (Object.hasOwn(body, "mainFolderPath")) {
      throw httpError(403, "Direct browser-supplied Main Folder paths are not accepted.");
    }
    if (!session.mainFolderPath || !session.activeScanId ||
        typeof body.scanId !== "string" || body.scanId !== session.activeScanId) {
      throw httpError(409, "The scanned Main Folder has not been safely matched inside the Local Server root.");
    }
    const mainFolderPath = session.mainFolderPath;
    return {
      mainFolderPath,
      reviewBinPath: path.resolve(mainFolderPath, REVIEW_BIN)
    };
  }

  async function processFiles(filesInput, action, actionLabel) {
    const files = Array.isArray(filesInput) ? filesInput : [];
    const results = [];
    for (const filePath of files) {
      try {
        results.push({ ok: true, path: filePath, ...(await action(filePath)) });
      } catch (error) {
        results.push({ ok: false, path: filePath, error: error.message });
        log(`${actionLabel} failed for ${filePath}: ${error.message}`);
      }
    }
    return results;
  }

  async function moveOneToReviewBin(context, inputPath) {
    const relativePath = fileRelativePath(context.mainFolderPath, inputPath);
    const source = sourcePathFor(context, relativePath);
    assertSafeOperationFile(source, context.mainFolderPath, "Source file does not exist.");
    const destination = uniqueDestination(reviewBinPathFor(context, relativePath));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await fs.promises.rename(source, destination);
    session.movedFiles.set(trackingKey(context.mainFolderPath, relativePath), destination);
    log(`Moved to Review_Bin: ${source} -> ${destination}`);
    return { movedTo: destination };
  }

  async function recoverOneFromReviewBin(context, inputPath) {
    const relativePath = fileRelativePath(context.mainFolderPath, inputPath);
    const key = trackingKey(context.mainFolderPath, relativePath);
    const source = reviewSourceFor(context, relativePath, key);
    assertSafeOperationFile(source, context.reviewBinPath, "Review_Bin file does not exist.");
    const destination = uniqueDestination(sourcePathFor(context, relativePath));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await fs.promises.rename(source, destination);
    session.movedFiles.delete(key);
    log(`Recovered from Review_Bin: ${source} -> ${destination}`);
    return { recoveredTo: destination };
  }

  async function recycleOneFromReviewBin(context, inputPath) {
    const relativePath = fileRelativePath(context.mainFolderPath, inputPath);
    const key = trackingKey(context.mainFolderPath, relativePath);
    const source = reviewSourceFor(context, relativePath, key);
    assertSafeOperationFile(source, context.reviewBinPath, "Review_Bin file does not exist.");
    await sendFileToRecycleBin(source);
    session.movedFiles.delete(key);
    log(`Moved Review_Bin file to Recycle Bin: ${source}`);
    return { recycledFrom: source };
  }

  function fileRelativePath(mainFolderPath, inputPath) {
    const parts = safeRelativeParts(inputPath, "File");
    if (parts[0]?.toLowerCase() === path.basename(mainFolderPath).toLowerCase()) parts.shift();
    if (!parts.length) throw new Error("File path points to the selected Main Folder, not a file.");
    if (isIgnoredApplicationPath(parts)) throw new Error("Application-managed file path rejected.");
    const relativePath = path.join(...parts);
    const resolved = path.resolve(mainFolderPath, relativePath);
    if (!isInside(mainFolderPath, resolved) || resolved === path.resolve(mainFolderPath)) {
      throw new Error("File path outside the selected Main Folder was rejected.");
    }
    return relativePath;
  }

  function sourcePathFor(context, relativePath) {
    const resolved = path.resolve(context.mainFolderPath, relativePath);
    assertInside(context.mainFolderPath, resolved, "File path outside the selected Main Folder was rejected.");
    assertInside(session.serverRootPath, resolved, "File path outside the Local Server root was rejected.");
    return resolved;
  }

  function reviewBinPathFor(context, relativePath) {
    const resolved = path.resolve(context.reviewBinPath, relativePath);
    assertInside(context.reviewBinPath, resolved, "Path outside Review_Bin was rejected.");
    assertInside(context.mainFolderPath, resolved, "Review_Bin must remain inside the selected Main Folder.");
    assertInside(session.serverRootPath, resolved, "Review_Bin must remain inside the Local Server root.");
    return resolved;
  }

  function reviewSourceFor(context, relativePath, key) {
    const tracked = session.movedFiles.get(key);
    if (tracked) {
      const resolved = path.resolve(tracked);
      assertInside(context.reviewBinPath, resolved, "Path outside Review_Bin was rejected.");
      return resolved;
    }
    return reviewBinPathFor(context, relativePath);
  }

  return Object.freeze({ handle });
}

function isIgnoredApplicationPath(parts) {
  return parts.some(isIgnoredApplicationName);
}

function isIgnoredApplicationName(name) {
  const lower = String(name || "").toLowerCase();
  return lower === REVIEW_BIN.toLowerCase() ||
    lower === "sga_file_nexus_quarantine" ||
    lower.startsWith(".sga-file-nexus-");
}

function safeRelativeInput(inputPath, label) {
  return safeRelativeParts(inputPath, label).join(path.sep);
}

function safeRelativeParts(inputPath, label) {
  if (typeof inputPath !== "string" || !inputPath.trim()) {
    throw new Error(`${label} path is required.`);
  }
  const value = inputPath.trim();
  if (path.isAbsolute(value) || /^[a-zA-Z]:/.test(value) || /^(?:\\\\|\/\/)/.test(value)) {
    throw new Error(`Absolute browser-supplied ${label.toLowerCase()} paths are not accepted.`);
  }
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.some(part => part === "..")) {
    throw new Error(`Unsafe ${label.toLowerCase()} path rejected.`);
  }
  return parts.filter(part => part !== ".");
}

function assertInside(root, candidate, message) {
  if (!isInside(root, candidate) || path.resolve(root) === path.resolve(candidate)) {
    throw new Error(message);
  }
}

function chooseFolderWithWindowsDialog(description) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("The local folder picker is only available on Windows."));
      return;
    }
    const description64 = Buffer.from(description, "utf8").toString("base64");
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `$description = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${description64}'))`,
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = $description",
      "$dialog.ShowNewFolderButton = $false",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }"
    ].join("; ");
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: false }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message || "Folder picker could not be opened."));
        return;
      }
      const selected = stdout.trim();
      if (!selected) {
        reject(new Error("Folder selection was cancelled."));
        return;
      }
      resolve(selected);
    });
  });
}

function sendFileToRecycleBin(filePath) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("Windows Recycle Bin is only available on Windows."));
      return;
    }
    const filePath64 = Buffer.from(filePath, "utf8").toString("base64");
    const script = [
      `$target = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${filePath64}'))`,
      "Add-Type -AssemblyName Microsoft.VisualBasic",
      "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)"
    ].join("; ");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFile("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message || "File could not be moved to Recycle Bin."));
        return;
      }
      resolve();
    });
  });
}

function normalizeDirectory(inputPath, requiredMessage, missingMessage) {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new Error(requiredMessage);
  const resolved = path.resolve(inputPath.trim());
  const stats = safeStat(resolved);
  if (!stats?.isDirectory()) throw new Error(missingMessage);
  return resolved;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function assertSafeOperationFile(filePath, containmentRoot, missingMessage) {
  let stats;
  let realPath;
  let realContainmentRoot;
  try {
    stats = fs.lstatSync(filePath);
    realPath = fs.realpathSync.native(filePath);
    realContainmentRoot = fs.realpathSync.native(containmentRoot);
  } catch {
    throw new Error(missingMessage);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(missingMessage);
  if (!isInside(realContainmentRoot, realPath)) {
    throw new Error("File path escaped its validated folder through a symbolic link or junction.");
  }
}

function uniqueDestination(destination) {
  if (!fs.existsSync(destination)) return destination;
  const directory = path.dirname(destination);
  const extension = path.extname(destination);
  const base = path.basename(destination, extension);
  let index = 2;
  let candidate = path.join(directory, `${base}_${index}${extension}`);
  while (fs.existsSync(candidate)) {
    index += 1;
    candidate = path.join(directory, `${base}_${index}${extension}`);
  }
  return candidate;
}

function trackingKey(mainFolderPath, relativePath) {
  return `${normalizedPathKey(path.resolve(mainFolderPath))}\0${normalizedPathKey(relativePath)}`;
}

function normalizedPathKey(value) {
  return path.normalize(String(value || "")).toLowerCase();
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function log(message) {
  console.log(`[${new Date().toISOString()}] [Backup Discarder] ${message}`);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        reject(httpError(413, "Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(httpError(400, "Invalid JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  if (res.headersSent) return;
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = { createBackupDiscarderService, REVIEW_BIN };
