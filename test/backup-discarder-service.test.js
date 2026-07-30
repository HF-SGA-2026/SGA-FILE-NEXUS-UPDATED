"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBackupDiscarderService } = require("../backend/backup-discarder-service");

async function withService(callback) {
  const service = createBackupDiscarderService();
  const server = http.createServer((req, res) => {
    if (!service.handle(req, res)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Not found" }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function request(port, method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: payload ? { "Content-Type": "application/json" } : {}
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} });
      });
    });
    req.on("error", reject);
    req.end(payload ? JSON.stringify(payload) : undefined);
  });
}

function createFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "sga-backup-discarder-"));
  const serverRootPath = path.join(fixture, "trusted-root");
  fs.mkdirSync(serverRootPath, { recursive: true });
  return { fixture, serverRootPath };
}

function createMainFolder(serverRootPath, relativePath, files) {
  const mainFolderPath = path.join(serverRootPath, relativePath);
  fs.mkdirSync(mainFolderPath, { recursive: true });
  for (const [relativeFilePath, contents] of Object.entries(files)) {
    const filePath = path.join(mainFolderPath, relativeFilePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return mainFolderPath;
}

function scanPayload(mainFolderName, files) {
  return {
    mainFolderName,
    scannedFiles: Object.entries(files).map(([relativePath, contents]) => ({
      relativePath: `${mainFolderName}/${relativePath.replaceAll("\\", "/")}`,
      size: Buffer.byteLength(contents)
    }))
  };
}

async function connectRoot(port, serverRootPath) {
  const response = await request(port, "POST", "/api/backup-discarder/select-folder", { serverRootPath });
  assert.equal(response.status, 200);
  assert.equal(response.body.serverRootPath, serverRootPath);
}

test("automatically matches one nested Main Folder, moves to its Review_Bin, and restores it", async () => {
  const fixture = createFixture();
  const files = {
    "nested/copy.txt": "copy",
    "drawings/archive/design.bak": "backup"
  };
  const relativeMainFolder = path.join("GitHub", "SGA-FILE-NEXUS", "Test Files");
  const mainFolderPath = createMainFolder(fixture.serverRootPath, relativeMainFolder, files);
  try {
    await withService(async port => {
      await connectRoot(port, fixture.serverRootPath);
      const match = await request(port, "POST", "/api/backup-discarder/resolve-main-folder", scanPayload("Test Files", files));
      assert.equal(match.status, 200);
      assert.equal(match.body.matchStatus, "matched");
      assert.equal(match.body.mainFolderRelativePath, relativeMainFolder);

      const operation = {
        scanId: match.body.scanId,
        files: ["Test Files/nested/copy.txt"]
      };
      const moved = await request(port, "POST", "/api/backup-discarder/move-to-review-bin", operation);
      assert.equal(moved.body.results[0].ok, true);
      assert.equal(fs.existsSync(path.join(mainFolderPath, "nested", "copy.txt")), false);
      assert.equal(fs.existsSync(path.join(mainFolderPath, "Review_Bin", "nested", "copy.txt")), true);

      const restored = await request(port, "POST", "/api/backup-discarder/recover-from-review-bin", operation);
      assert.equal(restored.body.results[0].ok, true);
      assert.equal(fs.existsSync(path.join(mainFolderPath, "nested", "copy.txt")), true);
      assert.equal(fs.existsSync(path.join(mainFolderPath, "Review_Bin", "nested", "copy.txt")), false);
    });
  } finally {
    fs.rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("returns safe relative candidates for duplicate matches and activates the user's candidate", async () => {
  const fixture = createFixture();
  const files = { "nested/copy.txt": "same" };
  const firstRelative = path.join("GitHub", "SGA-FILE-NEXUS", "Test Files");
  const secondRelative = path.join("Projects", "2026", "Test Files");
  const firstPath = createMainFolder(fixture.serverRootPath, firstRelative, files);
  const secondPath = createMainFolder(fixture.serverRootPath, secondRelative, files);
  try {
    await withService(async port => {
      await connectRoot(port, fixture.serverRootPath);
      const match = await request(port, "POST", "/api/backup-discarder/resolve-main-folder", scanPayload("Test Files", files));
      assert.equal(match.body.matchStatus, "multiple");
      assert.deepEqual(new Set(match.body.candidates), new Set([firstRelative, secondRelative]));
      assert.equal(match.body.candidates.every(candidate => !path.isAbsolute(candidate)), true);

      const arbitrary = await request(port, "POST", "/api/backup-discarder/select-main-folder", {
        scanId: match.body.scanId,
        mainFolderRelativePath: path.join("Unlisted", "Test Files")
      });
      assert.equal(arbitrary.status, 403);

      const selected = await request(port, "POST", "/api/backup-discarder/select-main-folder", {
        scanId: match.body.scanId,
        mainFolderRelativePath: secondRelative
      });
      assert.equal(selected.status, 200);
      assert.equal(selected.body.mainFolderRelativePath, secondRelative);

      const moved = await request(port, "POST", "/api/backup-discarder/move-to-review-bin", {
        scanId: match.body.scanId,
        files: ["Test Files/nested/copy.txt"]
      });
      assert.equal(moved.body.results[0].ok, true);
      assert.equal(fs.existsSync(path.join(firstPath, "nested", "copy.txt")), true);
      assert.equal(fs.existsSync(path.join(secondPath, "Review_Bin", "nested", "copy.txt")), true);
    });
  } finally {
    fs.rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("returns a clear no-match result and never searches outside the server root", async () => {
  const fixture = createFixture();
  const outsideRoot = path.join(fixture.fixture, "outside-root");
  const files = { "nested/copy.txt": "outside" };
  createMainFolder(outsideRoot, "Test Files", files);
  try {
    await withService(async port => {
      await connectRoot(port, fixture.serverRootPath);
      const response = await request(port, "POST", "/api/backup-discarder/resolve-main-folder", scanPayload("Test Files", files));
      assert.equal(response.status, 200);
      assert.equal(response.body.matchStatus, "none");
      assert.deepEqual(response.body.candidates, []);
      assert.match(response.body.error, /could not be located inside the connected Local Server root/);
    });
  } finally {
    fs.rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("rejects direct Main Folder paths, candidate traversal, and file traversal", async () => {
  const fixture = createFixture();
  const files = { "nested/copy.txt": "copy" };
  createMainFolder(fixture.serverRootPath, path.join("Projects", "Test Files"), files);
  try {
    await withService(async port => {
      await connectRoot(port, fixture.serverRootPath);

      const scanTraversal = await request(port, "POST", "/api/backup-discarder/resolve-main-folder", {
        mainFolderName: "Test Files",
        scannedFiles: [{ relativePath: "Test Files/../outside.txt", size: 1 }]
      });
      assert.equal(scanTraversal.status, 400);
      assert.match(scanTraversal.body.error, /Unsafe scanned file path rejected/);

      const match = await request(port, "POST", "/api/backup-discarder/resolve-main-folder", scanPayload("Test Files", files));
      const candidateTraversal = await request(port, "POST", "/api/backup-discarder/select-main-folder", {
        scanId: match.body.scanId,
        mainFolderRelativePath: "../outside"
      });
      assert.equal(candidateTraversal.status, 400);
      assert.match(candidateTraversal.body.error, /Unsafe main folder candidate path rejected/i);

      const directPath = await request(port, "POST", "/api/backup-discarder/move-to-review-bin", {
        scanId: match.body.scanId,
        mainFolderPath: path.join(fixture.serverRootPath, "Projects", "Test Files"),
        files: ["Test Files/nested/copy.txt"]
      });
      assert.equal(directPath.status, 403);
      assert.match(directPath.body.error, /Direct browser-supplied Main Folder paths/);

      const fileTraversal = await request(port, "POST", "/api/backup-discarder/move-to-review-bin", {
        scanId: match.body.scanId,
        files: ["../outside.txt"]
      });
      assert.equal(fileTraversal.body.results[0].ok, false);
      assert.match(fileTraversal.body.results[0].error, /Unsafe file path rejected/);
    });
  } finally {
    fs.rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("switches Main Folders without changing the connected server root", async () => {
  const fixture = createFixture();
  const firstFiles = { "first.txt": "first" };
  const secondFiles = { "second.txt": "second" };
  createMainFolder(fixture.serverRootPath, path.join("Clients", "First Project"), firstFiles);
  const secondPath = createMainFolder(fixture.serverRootPath, path.join("Clients", "Second Project"), secondFiles);
  try {
    await withService(async port => {
      await connectRoot(port, fixture.serverRootPath);
      const first = await request(port, "POST", "/api/backup-discarder/resolve-main-folder", scanPayload("First Project", firstFiles));
      assert.equal(first.body.matchStatus, "matched");

      const second = await request(port, "POST", "/api/backup-discarder/resolve-main-folder", scanPayload("Second Project", secondFiles));
      assert.equal(second.body.matchStatus, "matched");
      const moved = await request(port, "POST", "/api/backup-discarder/move-to-review-bin", {
        scanId: second.body.scanId,
        files: ["Second Project/second.txt"]
      });
      assert.equal(moved.body.results[0].ok, true);
      assert.equal(fs.existsSync(path.join(secondPath, "Review_Bin", "second.txt")), true);

      const status = await request(port, "GET", "/api/backup-discarder/status");
      assert.equal(status.body.serverRootPath, fixture.serverRootPath);
      assert.equal(status.body.mainFolderRelativePath, path.join("Clients", "Second Project"));
    });
  } finally {
    fs.rmSync(fixture.fixture, { recursive: true, force: true });
  }
});

test("normalizes UNC paths where platform-independent Windows path handling is testable", () => {
  const uncRoot = "\\\\FirmServer\\Documents";
  const uncMainFolder = "\\\\FirmServer\\Documents\\Projects\\2026\\Test Files";
  assert.equal(path.win32.isAbsolute(uncRoot), true);
  assert.equal(path.win32.relative(uncRoot, uncMainFolder), "Projects\\2026\\Test Files");
  assert.equal(path.win32.normalize("//FirmServer/Documents/Projects/2026/Test Files"), uncMainFolder);
});

test("does not expose a native Main Folder picker endpoint", async () => {
  await withService(async port => {
    const response = await request(port, "POST", "/api/backup-discarder/choose-main-folder", {});
    assert.equal(response.status, 404);
  });
});
