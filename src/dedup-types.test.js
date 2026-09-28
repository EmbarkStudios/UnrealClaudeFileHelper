// Regression test for FLEET-335: dedupTypes must not collapse UNRELATED types
// that merely share a name.
//
// The collapse exists for one job: pair a type's header declaration with its
// .cpp definition, preferring the header and recording the .cpp as
// `implementationPath`. Keyed on `name:kind` alone it also merged types from
// different projects and different languages, which is a silent wrong answer
// twice over — the losing definition disappeared with no hint, and a losing
// .cpp was reported as the winner's implementation, asserting a relationship
// that does not exist.
//
// Measured on framework 2026-09-27 before the fix: `find_type EParseState`
// answered with Engine/Core's enum and claimed it was implemented in
// SharedPlugins/Marketplace/DungeonArchitect/.../DAMkJsonSyntaxHighlighter.cpp.
// Three unrelated enums, one row, one invented fact. On a tree carrying a second
// game, the same collapse hid an AngelScript class behind a same-named C++ class
// (scoreEntry's `.h` bias decided it).

import { test } from 'node:test';
import assert from 'node:assert';
import { dedupTypes } from './service/scoring.js';

test('a header and its .cpp in the SAME project still merge, cpp as implementationPath', () => {
  const out = dedupTypes([
    { name: 'AController', kind: 'class', parent: 'AActor', line: 40,
      path: '/t/Engine/Source/Runtime/Engine/Classes/GameFramework/Controller.h',
      project: 'Engine', language: 'cpp' },
    { name: 'AController', kind: 'class', parent: null, line: 169,
      path: '/t/Engine/Source/Runtime/Engine/Private/PlayerState.cpp',
      project: 'Engine', language: 'cpp' }
  ]);

  assert.strictEqual(out.length, 1, 'header + impl of one type is one row');
  assert.ok(out[0].path.endsWith('Controller.h'), 'the header wins');
  assert.ok(out[0].implementationPath?.endsWith('PlayerState.cpp'), 'the .cpp is recorded');
});

test('unrelated same-named types in DIFFERENT projects all survive', () => {
  const out = dedupTypes([
    { name: 'EParseState', kind: 'enum', line: 106,
      path: '/t/Engine/Source/Runtime/Core/Public/Misc/ExpressionParserTypes.h',
      project: 'Engine', language: 'cpp' },
    { name: 'EParseState', kind: 'enum', line: 20,
      path: '/t/Engine/Plugins/Something/Private/Parser.cpp',
      project: 'EnginePlugins', language: 'cpp' },
    { name: 'EParseState', kind: 'enum', line: 31,
      path: '/t/SharedPlugins/Marketplace/DungeonArchitect/Source/DungeonArchitectEditor/Private/Core/Editors/DungeonMarkov/DAMkJsonSyntaxHighlighter.cpp',
      project: 'SharedPlugins', language: 'cpp' }
  ]);

  assert.strictEqual(out.length, 3, 'three projects, three definitions, three rows');
  for (const r of out) {
    assert.strictEqual(r.implementationPath, undefined,
      'no cross-project row may be claimed as another row\'s implementation');
  }
});

test('a C++ class and a same-named AngelScript class both survive', () => {
  const out = dedupTypes([
    { name: 'AGymGameMode', kind: 'class', parent: 'AGameModeBase', line: 9,
      path: '/t/Derpmore/Source/Derpmore/GymGameMode.h', project: 'Derpmore', language: 'cpp' },
    { name: 'AGymGameMode', kind: 'class', parent: 'ABraveGameplayGameMode', line: 129,
      path: '/t/Reference/Script/QuestGym/GymGameMode.as', project: 'Reference-Script',
      language: 'angelscript' }
  ]);

  assert.strictEqual(out.length, 2, 'two languages, two games, two rows');
  const as = out.find(r => r.language === 'angelscript');
  assert.ok(as, 'the AngelScript definition must not vanish behind the .h bias');
  assert.strictEqual(as.parent, 'ABraveGameplayGameMode');
});

test('two file-local enums of the same name in one project are two rows, with no invented implementation', () => {
  // Measured on framework: Engine's EParseState (a .h in Core) was answered with
  // a TraceLog Control.cpp as its implementationPath. An enum has no out-of-line
  // definition, so a same-named .cpp enum is a different enum.
  const out = dedupTypes([
    { name: 'EParseState', kind: 'enum', line: 106,
      path: '/t/Engine/Source/Runtime/Core/Public/Misc/ExpressionParserTypes.h',
      project: 'Engine', language: 'cpp' },
    { name: 'EParseState', kind: 'enum', line: 22,
      path: '/t/Engine/Source/Runtime/TraceLog/Private/Trace/Control.cpp',
      project: 'Engine', language: 'cpp' }
  ]);

  assert.strictEqual(out.length, 2, 'two unrelated enums, two rows');
  for (const r of out) {
    assert.strictEqual(r.implementationPath, undefined, 'an enum has no implementation to claim');
  }
});

test('two .cpp definitions of a same-named class in one project do not merge', () => {
  const out = dedupTypes([
    { name: 'FHelper', kind: 'class', line: 10, path: '/t/P/Source/A/Private/One.cpp',
      project: 'P', language: 'cpp' },
    { name: 'FHelper', kind: 'class', line: 40, path: '/t/P/Source/B/Private/Two.cpp',
      project: 'P', language: 'cpp' }
  ]);
  assert.strictEqual(out.length, 2, 'both are definitions; neither implements the other');
  assert.ok(out.every(r => r.implementationPath === undefined));
});
