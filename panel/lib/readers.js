const fs = require('fs');
const path = require('path');

function readJSON(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function readJSONL(filePath, filterDate) {
  const results = [];
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (filterDate && obj.date !== filterDate) continue;
        results.push(obj);
      } catch { /* skip bad lines */ }
    }
  } catch { /* file not found */ }
  return results;
}

function readJSONLLast(filePath, n = 1) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    const fd = fs.openSync(filePath, 'r');
    const chunkSize = Math.min(stat.size, 8192 * n);
    const buffer = Buffer.alloc(chunkSize);
    fs.readSync(fd, buffer, 0, chunkSize, Math.max(0, stat.size - chunkSize));
    fs.closeSync(fd);

    const lines = buffer.toString('utf-8').split('\n').filter(l => l.trim());
    const results = [];
    for (const line of lines.slice(-n)) {
      try { results.push(JSON.parse(line.trim())); } catch { /* skip */ }
    }
    return results;
  } catch {
    return [];
  }
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function readFileTail(filePath, lines = 50) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const allLines = data.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function listDir(dirPath, extensions) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter(e => {
        if (!e.isFile()) return false;
        if (extensions) {
          const ext = path.extname(e.name).toLowerCase();
          return extensions.includes(ext);
        }
        return true;
      })
      .map(e => {
        const fullPath = path.join(dirPath, e.name);
        const stat = fs.statSync(fullPath);
        return {
          name: e.name,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}

function todayStr(offsetHours) {
  const now = new Date();
  // offsetHours: ex. -3 (BRT). Default -3 pra retrocompat.
  const off = typeof offsetHours === 'number' ? offsetHours : -3;
  const local = new Date(now.getTime() + off * 60 * 60 * 1000);
  return local.toISOString().split('T')[0];
}

module.exports = { readJSON, readJSONL, readJSONLLast, readFile, readFileTail, listDir, todayStr };
