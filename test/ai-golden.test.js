const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseArtifact, verificationDecision } = require('../src/ai-contract');

test('版本化 AI 黄金样例持续约束结构与“无证据不能通过”原则', () => {
  const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ai-contract-golden.v1.json'), 'utf8'));
  assert.equal(dataset.version, 1);
  for (const item of dataset.cases) {
    if (item.type === 'verification') {
      const parsed = parseArtifact(JSON.stringify(item.artifact), item.type);
      assert.equal(verificationDecision(parsed).passed, item.accepted, item.id);
      continue;
    }
    if (item.accepted) assert.doesNotThrow(() => parseArtifact(JSON.stringify(item.artifact), item.type), item.id);
    else assert.throws(() => parseArtifact(JSON.stringify(item.artifact), item.type), undefined, item.id);
  }
});
