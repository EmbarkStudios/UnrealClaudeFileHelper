// Regression test for FLEET-332: zoekt's LineMatch.LineNumber is ONE-BASED.
//
// _mapResponse used to add 1 to it (with a comment claiming zoekt was 0-based),
// so every unreal_grep hit reported one line too high and every file:line copied
// out of a grep pointed one line late - onto the `{` under a class, or a blank
// line under a declaration. Measured on framework 2026-09-27 against seven files
// in three fleet plugins and the engine, all off by exactly +1. The trigram
// fallback (grep-worker.js, `line: i + 1` over a 0-based array index) was always
// correct, so the two search engines disagreed by one on the same query.
//
// The fixture below is a real zoekt reply, trimmed: zoekt reported LineNumber 43
// for `class BOX3DSIM_API IB3DSnapshotable`, which is line 43 of
// SharedPlugins/Box3DSim/Source/Box3DSim/Public/B3DSnapshot.h on disk.

import { test } from 'node:test';
import assert from 'node:assert';
import { ZoektClient } from './service/zoekt-client.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('LineMatches line numbers pass through one-based, not shifted by one', () => {
  const client = new ZoektClient(6070);
  const reply = {
    Result: {
      Files: [
        {
          FileName: 'Box3DSim/Source/Box3DSim/Public/B3DSnapshot.h',
          Repository: 'SharedPlugins',
          LineMatches: [
            { LineNumber: 43, Line: b64('class BOX3DSIM_API IB3DSnapshotable\n') },
            { LineNumber: 49, Line: b64('\tvirtual void SimSerializeState(FArchive& Ar) = 0;\n') }
          ]
        }
      ],
      Stats: { MatchCount: 2, FileCount: 1 }
    }
  };

  const mapped = client._mapResponse(reply, 1);

  assert.strictEqual(mapped.results.length, 2);
  assert.strictEqual(mapped.results[0].line, 43, 'the class line must be 43, not 44');
  assert.strictEqual(mapped.results[1].line, 49, 'the member line must be 49, not 50');
  assert.strictEqual(
    mapped.results[0].file,
    'SharedPlugins/Box3DSim/Source/Box3DSim/Public/B3DSnapshot.h',
    'Repository must be prefixed onto FileName'
  );
});

test('ChunkMatches line numbers are one-based too, and the content index still resolves', () => {
  const client = new ZoektClient(6070);
  const chunk = 'class BOX3DSIM_API IB3DSnapshotable\n{\npublic:\n';
  const reply = {
    Result: {
      Files: [
        {
          FileName: 'Box3DSim/Source/Box3DSim/Public/B3DSnapshot.h',
          Repository: 'SharedPlugins',
          ChunkMatches: [
            {
              Content: b64(chunk),
              ContentStart: { LineNumber: 43 },
              Ranges: [{ Start: { LineNumber: 43 } }, { Start: { LineNumber: 45 } }]
            }
          ]
        }
      ],
      Stats: { MatchCount: 2, FileCount: 1 }
    }
  };

  const mapped = client._mapResponse(reply, 1);

  assert.strictEqual(mapped.results[0].line, 43);
  assert.strictEqual(mapped.results[0].match, 'class BOX3DSIM_API IB3DSnapshotable');
  assert.strictEqual(mapped.results[1].line, 45);
  assert.strictEqual(mapped.results[1].match, 'public:');
});
