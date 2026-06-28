'use strict';

// Lightweight file logger shared across the main process. Writes to
// <repo>/logs/stardetect.log so backend faults, IPC errors and renderer
// errors are all visible in one place for debugging.

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'stardetect.log');

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

function ts() { return new Date().toISOString(); }

function write(level, scope, msg) {
  const line = `${ts()} [${level}] [${scope}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  if (level === 'ERROR') process.stderr.write(line); else process.stdout.write(line);
}

module.exports = {
  LOG_FILE,
  info: (scope, msg) => write('INFO', scope, msg),
  warn: (scope, msg) => write('WARN', scope, msg),
  error: (scope, msg) => write('ERROR', scope, msg),
  clear: () => { try { fs.writeFileSync(LOG_FILE, `--- session ${ts()} ---\n`); } catch (_) {} },
};
