// SHOUT's skill checker and JOSH's program/load compile through one path, so a skill that
// does not compile shows the same diagnostics in the skill list and in a failed run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SkillRegistry, catalogParams } from '../src/skills.mjs';
import { Run } from '../../../prototypes/owned/src/kernel.mjs';
import { shoutTools } from '../src/tools.mjs';

const sources = {
  undefined: `manifest {
  language: "0.1"
  entry: main
  capabilities: []
  tools: { required: [{ name: "workspace.read", version: ">=1.0.0, <2.0.0" }] }
}
export async fn main() returns String effects [tool.workspace.read@1] {
  let text = "\u{1F980}";
  match await tools.workspace.read.call({ path: missing_path }) {
    Ok(file) => file.content
    Err(_) => text
  }
}
`,
  type: `manifest { language: "0.1" entry: main capabilities: [] }
export fn main() returns Int { "not a number" }
`,
  boundary: `manifest { language: "0.1" entry: main capabilities: [] }
export fn main() returns fn(Int) returns Int { fn(x: Int) returns Int { x } }
`,
};

test('the skill checker and a failed program/load report identical diagnostics', async t => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'shout-diagnostics-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const registry = new SkillRegistry({ stateRoot });
  assert.ok(catalogParams().tools.length > 0);
  for (const [name, source] of Object.entries(sources)) {
    const checked = await registry.check(source);
    assert.equal(checked.ok, false, name);
    const run = new Run({ provider: { judge: async () => { throw new Error('no model'); } }, source, input: null,
      scratchRoot: stateRoot, tools: shoutTools, toolHandler: async () => { throw new Error('no tools'); } });
    void run.start();
    const outcome = await run.done;
    assert.equal(outcome.state, 'failed', name);
    assert.deepEqual(outcome.result.diagnostics, checked.diagnostics, name);
    for (const diagnostic of checked.diagnostics) {
      assert.equal(diagnostic.source, 'src/main.allen');
      assert.ok(diagnostic.line >= 1 && diagnostic.column >= 1);
    }
  }
  // start/end are UTF-8 byte offsets (the crab emoji is 4 bytes, 2 UTF-16 units); line/column
  // count code points, so they locate the text without byte arithmetic.
  const undefinedName = (await registry.check(sources.undefined)).diagnostics[0];
  assert.equal(Buffer.from(sources.undefined).subarray(undefinedName.start, undefinedName.end).toString(), 'missing_path');
  const line = sources.undefined.split('\n')[undefinedName.line - 1];
  assert.equal([...line].slice(undefinedName.column - 1, undefinedName.end_column - 1).join(''), 'missing_path');
});
