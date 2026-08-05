const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.SGA_DATA_FILE || path.join(__dirname, '..', 'data', 'data.json');
const DEMO_FILE = path.join(__dirname, '..', 'data', 'demo.json');
const BACKUP_DIR = process.env.SGA_BACKUP_DIR || path.join(path.dirname(DATA_FILE), 'backups');
const MAX_BACKUPS = 20;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function now() { return new Date().toISOString(); }

function migrateData(input) {
  const data = clone(input || {});
  data.version = Math.max(2, data.version || 1);
  data.projects = Array.isArray(data.projects) ? data.projects : [];
  data.issues = Array.isArray(data.issues) ? data.issues : [];
  data.imports = data.imports || { mechanical: null, electrical: null };
  data.settings = {
    maintainMasterExcel: false,
    masterDirectory: path.join(path.dirname(DATA_FILE), 'master'),
    masterFilename: 'SGA_MEP_Master.xlsx',
    lastMasterUpdate: null,
    lastMasterBackup: null,
    lastMasterError: null,
    ...(data.settings || {})
  };
  data.system = { lastSavedAt: null, lastBackupAt: null, ...(data.system || {}) };
  data.projects = data.projects.map(project => ({
    ...project,
    projectStatus: project.projectStatus || 'Completed',
    completionDate: project.completionDate || null,
    excludedFromAnalysis: Boolean(project.excludedFromAnalysis),
    audit: {
      createdAt: project.audit?.createdAt || project.createdAt || null,
      updatedAt: project.audit?.updatedAt || project.updatedAt || null,
      sourceType: project.audit?.sourceType || 'Spreadsheet import',
      enteredBy: project.audit?.enteredBy || null,
      origin: project.audit?.origin || 'import',
      ...(project.audit || {})
    },
    provenance: project.provenance || {}
  }));
  data.issues = data.issues.map(issue => ({
    severity: 'Warning', status: 'Unresolved', discipline: 'General', category: 'Other',
    createdAt: issue.dateRecorded || now(), updatedAt: issue.lastUpdated || issue.dateRecorded || now(),
    resolutionHistory: [], source: 'Application', ...issue
  }));
  return data;
}

function readData() {
  try { const data=migrateData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));data.system.lastSavedAt=data.system.lastSavedAt||fs.statSync(DATA_FILE).mtime.toISOString();data.system.lastBackupAt=data.system.lastBackupAt||listBackups()[0]?.createdAt||null;return data; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const demo = migrateData(JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8')));
    writeData(demo, { backup: false });
    return clone(demo);
  }
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function safeReason(reason) { return String(reason || 'snapshot').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40); }

function createBackup(reason = 'snapshot') {
  if (!fs.existsSync(DATA_FILE)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `SGA_MEP_Data_${timestamp()}_${safeReason(reason)}.json`;
  const target = path.join(BACKUP_DIR, name);
  fs.copyFileSync(DATA_FILE, target);
  pruneBackups();
  return { name, path: target, createdAt: fs.statSync(target).mtime.toISOString() };
}

function pruneBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return;
  const files = fs.readdirSync(BACKUP_DIR).filter(name => name.toLowerCase().endsWith('.json')).map(name => ({ name, path: path.join(BACKUP_DIR, name), time: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs })).sort((a, b) => b.time - a.time);
  files.slice(MAX_BACKUPS).forEach(file => fs.unlinkSync(file.path));
}

function writeData(data, options = {}) {
  const backup = options.backup !== false ? createBackup(options.reason || 'change') : null;
  data.system = { ...(data.system || {}), lastSavedAt: now(), lastBackupAt: backup?.createdAt || data.system?.lastBackupAt || null };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(migrateData(data), null, 2));
  fs.renameSync(temp, DATA_FILE);
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(name => name.toLowerCase().endsWith('.json')).map(name => {
    const stats = fs.statSync(path.join(BACKUP_DIR, name));
    return { name, createdAt: stats.mtime.toISOString(), size: stats.size };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function restoreBackup(name) {
  if (path.basename(name) !== name || !name.toLowerCase().endsWith('.json')) throw new Error('Invalid backup file.');
  const source = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(source)) throw new Error('Backup not found.');
  const restored = migrateData(JSON.parse(fs.readFileSync(source, 'utf8')));
  writeData(restored, { reason: 'before-restore' });
  return restored;
}

function resetToDemo() {
  const demo = migrateData(JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8')));
  writeData(demo, { reason: 'before-demo-reset' });
  return clone(demo);
}

module.exports = { DATA_FILE, BACKUP_DIR, MAX_BACKUPS, migrateData, readData, writeData, createBackup, listBackups, restoreBackup, resetToDemo };
