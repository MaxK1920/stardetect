'use strict';

// Bridges Electron <-> the Python backend CLI.
// Spawns `python backend/cli.py <cmd> ...`, parses newline-delimited JSON
// messages from stdout, forwards progress, and resolves with the result.

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const log = require('./logger');

const BACKEND_DIR = path.join(__dirname, '..', 'backend');
const CLI = path.join(BACKEND_DIR, 'cli.py');

function pythonCmd() {
  return process.env.STARDETECT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

// Run a backend command. argv is the list after cli.py (e.g. ['detect','--video',...]).
// onProgress receives {value, msg}. Resolves with the `result.data` payload.
function runBackend(argv, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    log.info('backend', `spawn: ${pythonCmd()} cli.py ${argv.join(' ')}`);
    const proc = spawn(pythonCmd(), [CLI, ...argv], { cwd: path.join(__dirname, '..') });
    let result = null;
    let errorMsg = null;
    let stderrTail = '';

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'progress') onProgress({ value: msg.value, msg: msg.msg });
      else if (msg.type === 'result') result = msg.data;
      else if (msg.type === 'error') { errorMsg = msg.message + (msg.trace ? '\n' + msg.trace : ''); }
    });

    proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-3000); });
    proc.on('error', (err) => {
      log.error('backend', `failed to start python: ${err.message}`);
      reject(new Error(`Failed to start Python (${pythonCmd()}): ${err.message}`));
    });
    proc.on('close', (code) => {
      if (errorMsg) { log.error('backend', `cmd '${argv[0]}' error: ${errorMsg}`); return reject(new Error(errorMsg)); }
      if (code !== 0 && !result) {
        log.error('backend', `cmd '${argv[0]}' exit ${code}. stderr:\n${stderrTail}`);
        return reject(new Error(`Backend exited ${code}.\n${stderrTail}`));
      }
      if (stderrTail.trim()) log.warn('backend', `cmd '${argv[0]}' stderr:\n${stderrTail.slice(-800)}`);
      log.info('backend', `cmd '${argv[0]}' ok`);
      resolve(result || {});
    });

    // Allow cancellation
    runBackend._active = runBackend._active || new Set();
    runBackend._active.add(proc);
    proc.on('close', () => runBackend._active.delete(proc));
  });
}

function killAll() {
  (runBackend._active || new Set()).forEach((p) => { try { p.kill(); } catch (_) {} });
}

module.exports = { runBackend, killAll, BACKEND_DIR, pythonCmd };
