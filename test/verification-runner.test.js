const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  discoverVerificationPlan,
  runVerificationPlan
} = require('../src/verification-runner');

function createProject(scripts = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'future-workbench-verification-'));
  if (scripts) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts }, null, 2));
  }
  return root;
}

test('只从 package.json 识别受支持且可向用户展示的检查命令', () => {
  const root = createProject({
    check: 'node --check index.js',
    test: 'node --test',
    deploy: 'echo 不应自动执行'
  });
  const plan = discoverVerificationPlan(root);

  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.required, true);
  assert.deepEqual(plan.commands.map((item) => item.id), ['npm:check', 'npm:test']);
  assert.deepEqual(plan.commands.map((item) => item.script), ['node --check index.js', 'node --test']);
  assert.equal(plan.commands.some((item) => item.id === 'npm:deploy'), false);
  assert.match(plan.hash, /^[0-9a-f]{64}$/);
  assert.equal(discoverVerificationPlan(root).hash, plan.hash, '相同项目状态应生成稳定指纹');
});

test('没有受支持脚本时明确返回未配置，而不是伪装成验证通过', () => {
  const root = createProject({ build: 'echo build' });
  const plan = discoverVerificationPlan(root);

  assert.equal(plan.required, false);
  assert.equal(plan.commands.length, 0);
  assert.equal(plan.reason, 'NO_SUPPORTED_CHECKS');
});

test('自动发现 Python、Rust 与 Go 的受限标准测试入口', () => {
  const root = createProject(null);
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
  fs.writeFileSync(path.join(root, 'Cargo.lock'), '# lock\n');
  fs.writeFileSync(path.join(root, 'go.mod'), 'module fixture\n');
  const plan = discoverVerificationPlan(root);
  assert.deepEqual(plan.commands.map((item) => item.id), ['python:pytest', 'rust:cargo-test', 'go:test']);
  assert.deepEqual(plan.commands.map((item) => item.displayCommand), ['python3 -m pytest', 'cargo test --locked', 'go test ./...']);
});

test('确定性检查保存真实退出码、耗时和脱敏后的输出摘要', async () => {
  const root = createProject({
    check: 'node -e "console.log(\'OPENAI_API_KEY=secret-value\'); console.log(\'检查完成\')"',
    test: 'node -e "process.exit(0)"'
  });
  const plan = discoverVerificationPlan(root);
  const result = await runVerificationPlan(root, plan, { timeoutMs: 5_000, maxOutputChars: 8_000 });

  assert.equal(result.status, 'passed');
  assert.equal(result.passed, true);
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands.every((item) => item.exitCode === 0 && item.status === 'passed'), true);
  assert.match(result.commands[0].output, /OPENAI_API_KEY=\[已隐藏\]/);
  assert.doesNotMatch(result.commands[0].output, /secret-value/);
});

test('任何检查非零退出时整体失败，并保留其他检查证据', async () => {
  const root = createProject({
    check: 'node -e "console.error(\'语法检查失败\'); process.exit(2)"',
    test: 'node -e "console.log(\'测试仍执行\')"'
  });
  const result = await runVerificationPlan(root, discoverVerificationPlan(root), { timeoutMs: 5_000 });

  assert.equal(result.status, 'failed');
  assert.equal(result.passed, false);
  assert.equal(result.commands[0].exitCode, 2);
  assert.equal(result.commands[1].exitCode, 0);
});

test('检查超时会终止并标记失败', async () => {
  const root = createProject({ check: 'node -e "setTimeout(() => {}, 5000)"' });
  const result = await runVerificationPlan(root, discoverVerificationPlan(root), { timeoutMs: 100 });

  assert.equal(result.status, 'failed');
  assert.equal(result.passed, false);
  assert.equal(result.commands[0].status, 'timed_out');
});

test('AI 修改了用户批准的检查脚本后拒绝执行新脚本', async () => {
  const root = createProject({ check: 'node -e "console.log(\'原检查\')"' });
  const approvedPlan = discoverVerificationPlan(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    private: true,
    scripts: { check: 'node -e "console.log(\'已被替换\')"' }
  }, null, 2));

  const result = await runVerificationPlan(root, approvedPlan, { timeoutMs: 5_000 });
  assert.equal(result.status, 'blocked');
  assert.equal(result.passed, false);
  assert.equal(result.error.code, 'VERIFICATION_PLAN_CHANGED');
  assert.equal(result.commands.length, 0);
});

test('AI 不改命令但偷换测试文件时拒绝执行', async () => {
  const root = createProject({ test: 'node --test' });
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test', 'safe.test.js'), "require('node:test')('safe', () => {});\n");
  const approvedPlan = discoverVerificationPlan(root);
  fs.writeFileSync(path.join(root, 'test', 'safe.test.js'), "require('node:test')('changed', () => {});\n");

  const result = await runVerificationPlan(root, approvedPlan, { timeoutMs: 5_000 });
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'VERIFICATION_PLAN_CHANGED');
  assert.equal(result.commands.length, 0);
});

test('验证脚本在系统沙箱内不能读取用户目录或联网', async () => {
  const root = createProject({
    check: `node -e "require('fs').readFileSync('${path.join(os.homedir(), '.ssh', 'id_rsa')}')"`
  });
  const result = await runVerificationPlan(root, discoverVerificationPlan(root), { timeoutMs: 5_000 });

  assert.equal(result.status, 'failed');
  assert.equal(result.passed, false);
  assert.notEqual(result.commands[0].exitCode, 0);
});
