const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const config = require('./config');

const PLAN_VERSION = 2;
const SUPPORTED_NPM_SCRIPTS = Object.freeze(['check', 'test']);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_INTEGRITY_FILES = 2_000;
const MAX_INTEGRITY_FILE_BYTES = 2 * 1024 * 1024;
const VERIFICATION_ROOTS = Object.freeze([
  'test', 'tests', '__tests__',
  'package-lock.json', 'npm-shrinkwrap.json',
  'pyproject.toml', 'pytest.ini', 'tox.ini', 'requirements.txt', 'uv.lock',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum',
  'node-test.config.js', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs',
  'vitest.config.js', 'vitest.config.cjs', 'vitest.config.mjs'
]);

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileDigest(filePath) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_INTEGRITY_FILE_BYTES) {
    throw new Error('VERIFICATION_INTEGRITY_UNREADABLE');
  }
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function collectIntegrityFiles(workspacePath, scripts = {}) {
  const candidates = new Set(['package.json', ...VERIFICATION_ROOTS]);
  for (const script of Object.values(scripts)) {
    if (typeof script !== 'string') continue;
    for (const token of script.match(/[A-Za-z0-9_./-]+\.(?:c?js|mjs|json|ts|tsx)/g) || []) {
      if (!path.isAbsolute(token) && !token.split('/').includes('..')) candidates.add(token.replace(/^\.\//, ''));
    }
  }

  const files = [];
  const visit = (relativePath) => {
    if (files.length >= MAX_INTEGRITY_FILES) throw new Error('VERIFICATION_INTEGRITY_TOO_LARGE');
    const absolutePath = path.join(workspacePath, relativePath);
    if (!fs.existsSync(absolutePath)) return;
    const stats = fs.lstatSync(absolutePath);
    if (stats.isSymbolicLink()) throw new Error('VERIFICATION_INTEGRITY_UNREADABLE');
    if (stats.isDirectory()) {
      for (const name of fs.readdirSync(absolutePath).sort()) visit(path.join(relativePath, name));
      return;
    }
    if (!stats.isFile()) return;
    files.push({ path: relativePath.split(path.sep).join('/'), bytes: stats.size, sha256: fileDigest(absolutePath) });
  };
  for (const candidate of [...candidates].sort()) visit(candidate);
  return files;
}

function discoverIntegrity(workspacePath, scripts) {
  try {
    const files = collectIntegrityFiles(workspacePath, scripts);
    return { algorithm: 'sha256', files, digest: stableHash(files), error: null };
  } catch (error) {
    return { algorithm: 'sha256', files: [], digest: null, error: error.message || 'VERIFICATION_INTEGRITY_UNREADABLE' };
  }
}

function readPackageScripts(workspacePath) {
  const manifestPath = path.join(workspacePath, 'package.json');
  if (!fs.existsSync(manifestPath)) return { manifestPath, scripts: null, error: null };
  const stats = fs.statSync(manifestPath);
  if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) {
    return { manifestPath, scripts: null, error: 'PACKAGE_MANIFEST_UNREADABLE' };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const scripts = manifest && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts)
      ? manifest.scripts
      : {};
    return { manifestPath, scripts, error: null };
  } catch (_) {
    return { manifestPath, scripts: null, error: 'PACKAGE_MANIFEST_INVALID' };
  }
}

function discoverVerificationPlan(workspacePath) {
  const root = fs.realpathSync(workspacePath);
  const manifest = readPackageScripts(root);
  const commands = manifest.scripts
    ? SUPPORTED_NPM_SCRIPTS
      .filter((name) => typeof manifest.scripts[name] === 'string' && manifest.scripts[name].trim())
      .map((name) => ({
        id: `npm:${name}`,
        label: name === 'check' ? '代码检查' : '自动化测试',
        displayCommand: name === 'check' ? 'npm run check' : 'npm test',
        executable: 'npm',
        args: name === 'check' ? ['run', 'check'] : ['test'],
        scriptName: name,
        script: manifest.scripts[name].trim()
      }))
    : [];
  const has = (name) => fs.existsSync(path.join(root, name));
  const hasPythonTests = ['pyproject.toml', 'pytest.ini', 'tox.ini'].some(has)
    || ['test', 'tests'].some((directory) => {
      try { return fs.readdirSync(path.join(root, directory)).some((name) => name.endsWith('.py')); } catch (_) { return false; }
    });
  if (hasPythonTests) commands.push({
    id: 'python:pytest', label: 'Python 自动化测试', displayCommand: 'python3 -m pytest',
    executable: 'python3', args: ['-m', 'pytest'], scriptName: 'pytest', script: 'python3 -m pytest'
  });
  if (has('Cargo.toml')) commands.push({
    id: 'rust:cargo-test', label: 'Rust 自动化测试', displayCommand: has('Cargo.lock') ? 'cargo test --locked' : 'cargo test',
    executable: 'cargo', args: has('Cargo.lock') ? ['test', '--locked'] : ['test'], scriptName: 'cargo-test', script: has('Cargo.lock') ? 'cargo test --locked' : 'cargo test'
  });
  if (has('go.mod')) commands.push({
    id: 'go:test', label: 'Go 自动化测试', displayCommand: 'go test ./...',
    executable: 'go', args: ['test', './...'], scriptName: 'go-test', script: 'go test ./...'
  });
  const integrity = discoverIntegrity(root, manifest.scripts || {});
  const unsignedPlan = {
    schemaVersion: PLAN_VERSION,
    kind: 'deterministic_project_checks',
    manifest: 'project verification files',
    required: commands.length > 0,
    reason: commands.length > 0 ? (integrity.error || null) : (manifest.error || 'NO_SUPPORTED_CHECKS'),
    commands,
    integrity
  };
  return { ...unsignedPlan, hash: stableHash(unsignedPlan) };
}

function verificationEnvironment(source = process.env, tempPath = os.tmpdir()) {
  const env = {
    PATH: source.PATH || '',
    LANG: source.LANG || 'en_US.UTF-8',
    LC_ALL: source.LC_ALL || source.LANG || 'en_US.UTF-8',
    TMPDIR: tempPath,
    CI: '1',
    NO_COLOR: '1',
    NPM_CONFIG_USERCONFIG: os.devNull,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_cache: path.join(tempPath, 'npm-cache'),
    // 只执行用户看到的主脚本，不隐式运行 pre/post 生命周期脚本。
    npm_config_ignore_scripts: 'true'
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string' && value));
}

function escapeSandboxLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sandboxedCommand(workspacePath, command, tempPath) {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) {
    return { error: 'VERIFICATION_SANDBOX_UNAVAILABLE' };
  }
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    `(deny file-read* (subpath "${escapeSandboxLiteral(os.homedir())}"))`,
    `(allow file-read* (subpath "${escapeSandboxLiteral(workspacePath)}"))`,
    `(allow file-read* (subpath "${escapeSandboxLiteral(tempPath)}"))`,
    '(deny file-write*)',
    `(allow file-write* (subpath "${escapeSandboxLiteral(tempPath)}"))`
  ].join('\n');
  return {
    executable: '/usr/bin/sandbox-exec',
    args: ['-p', profile, command.executable, ...command.args],
    error: null
  };
}

function sandboxAvailable() {
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return false;
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'future-workbench-sandbox-probe-'));
  try {
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      `(deny file-read* (subpath "${escapeSandboxLiteral(os.homedir())}"))`,
      `(allow file-read* (subpath "${escapeSandboxLiteral(tempPath)}"))`,
      '(deny file-write*)',
      `(allow file-write* (subpath "${escapeSandboxLiteral(tempPath)}"))`
    ].join('\n');
    const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'], {
      cwd: tempPath, stdio: 'ignore', timeout: 2_000
    });
    return probe.status === 0;
  } catch (_) {
    return false;
  } finally {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
}

function sanitizeOutput(value, maxChars) {
  const clean = String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY))\s*=\s*([^\s]+)/g, '$1=[已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (clean.length <= maxChars) return clean.trim();
  return `…输出前部已截断…\n${clean.slice(-maxChars).trim()}`;
}

function terminateProcess(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch (_) {}
}

function runCommand(workspacePath, command, { timeoutMs, maxOutputChars, signal } = {}) {
  return new Promise((resolve) => {
    const startedAtMs = Date.now();
    let output = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceKillTimer = null;
    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'future-workbench-check-'));
    const sandbox = sandboxedCommand(workspacePath, command, tempPath);
    if (sandbox.error) {
      fs.rmSync(tempPath, { recursive: true, force: true });
      resolve({
        id: command.id, label: command.label, displayCommand: command.displayCommand,
        status: 'blocked', exitCode: null, durationMs: 0, output: '', error: sandbox.error
      });
      return;
    }
    const child = spawn(sandbox.executable, sandbox.args, {
      cwd: workspacePath,
      env: verificationEnvironment(process.env, tempPath),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const append = (chunk) => {
      output = `${output}${chunk.toString('utf8')}`;
      if (output.length > maxOutputChars * 2) output = output.slice(-maxOutputChars * 2);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const stop = () => {
      terminateProcess(child);
      forceKillTimer = setTimeout(() => {
        if (child.exitCode !== null) return;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch (_) {}
      }, 1_000);
      forceKillTimer.unref?.();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timer.unref?.();
    const onAbort = () => { cancelled = true; stop(); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode, startError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
      try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch (_) {}
      const durationMs = Date.now() - startedAtMs;
      const status = cancelled ? 'cancelled'
        : timedOut ? 'timed_out'
          : startError ? 'start_failed'
            : exitCode === 0 ? 'passed' : 'failed';
      resolve({
        id: command.id,
        label: command.label,
        displayCommand: command.displayCommand,
        status,
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        durationMs,
        output: sanitizeOutput(startError ? startError.message : output, maxOutputChars)
      });
    };
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
  });
}

function planMatchesWorkspace(workspacePath, approvedPlan) {
  if (!approvedPlan || approvedPlan.schemaVersion !== PLAN_VERSION || approvedPlan.hash !== stableHash({
    schemaVersion: approvedPlan.schemaVersion,
    kind: approvedPlan.kind,
    manifest: approvedPlan.manifest,
    required: approvedPlan.required,
    reason: approvedPlan.reason,
    commands: approvedPlan.commands,
    integrity: approvedPlan.integrity
  })) return false;
  const current = discoverVerificationPlan(workspacePath);
  return !current.integrity.error && current.hash === approvedPlan.hash;
}

async function runVerificationPlan(workspacePath, approvedPlan, options = {}) {
  const startedAt = new Date().toISOString();
  if (!approvedPlan?.required || !approvedPlan.commands?.length) {
    return {
      schemaVersion: PLAN_VERSION,
      planHash: approvedPlan?.hash || null,
      status: 'not_configured',
      passed: null,
      required: false,
      commands: [],
      startedAt,
      completedAt: new Date().toISOString()
    };
  }
  if (approvedPlan?.integrity?.error || !planMatchesWorkspace(workspacePath, approvedPlan)) {
    return {
      schemaVersion: PLAN_VERSION,
      planHash: approvedPlan.hash,
      status: 'blocked',
      passed: false,
      required: true,
      commands: [],
      error: {
        code: approvedPlan?.integrity?.error ? 'VERIFICATION_INTEGRITY_UNAVAILABLE' : 'VERIFICATION_PLAN_CHANGED',
        message: approvedPlan?.integrity?.error
          ? '无法为检查代码建立完整指纹；系统已停止验证'
          : '项目的检查脚本或验证材料在批准后发生变化；为避免执行未获批准的代码，系统已停止验证'
      },
      startedAt,
      completedAt: new Date().toISOString()
    };
  }

  const timeoutMs = Number(options.timeoutMs) || config.DETERMINISTIC_CHECK_TIMEOUT_MS;
  const maxOutputChars = Number(options.maxOutputChars) || config.DETERMINISTIC_CHECK_MAX_OUTPUT_CHARS;
  const commands = [];
  for (const command of approvedPlan.commands) {
    commands.push(await runCommand(workspacePath, command, { timeoutMs, maxOutputChars, signal: options.signal }));
    if (options.signal?.aborted) break;
  }
  const passed = commands.length === approvedPlan.commands.length && commands.every((item) => item.status === 'passed');
  return {
    schemaVersion: PLAN_VERSION,
    planHash: approvedPlan.hash,
    status: passed ? 'passed' : 'failed',
    passed,
    required: true,
    commands,
    startedAt,
    completedAt: new Date().toISOString()
  };
}

module.exports = {
  discoverVerificationPlan,
  runVerificationPlan,
  sanitizeOutput,
  verificationEnvironment,
  sandboxAvailable
};
