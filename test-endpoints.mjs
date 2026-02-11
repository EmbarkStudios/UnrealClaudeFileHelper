#!/usr/bin/env node
/**
 * Test suite for issue #35 endpoints and issue #36-40 fixes:
 * - S1: contextLines on find-type and find-member
 * - S2: includeSignatures on find-member
 * - S3: explain-type compound endpoint
 * - S5: MCP tool analytics endpoints
 * - S6: batch query endpoint
 * - #36: batch contextLines/includeSignatures forwarding
 * - #37: batch path cleaning
 * - #39: explain-type split member limits
 * - #40: findTypeByName header preference
 */

const BASE = 'http://localhost:3847';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  FAIL: ${message}`);
  }
}

async function fetchJSON(path) {
  const resp = await fetch(`${BASE}${path}`);
  return { status: resp.status, data: await resp.json() };
}

async function postJSON(path, body) {
  const resp = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: resp.status, data: await resp.json() };
}

async function deleteJSON(path) {
  const resp = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  return { status: resp.status, data: await resp.json() };
}

// ===== S1: contextLines on find-type =====

async function testFindTypeContextLines() {
  console.log('\n--- S1: contextLines on find-type ---');

  // Without contextLines — should NOT have context field
  const { data: noCtx } = await fetchJSON('/find-type?name=AActor');
  assert(noCtx.results && noCtx.results.length > 0, 'find-type returns results for AActor');
  assert(!noCtx.results[0].context, 'No context field when contextLines not set');

  // With contextLines=5
  const { data: withCtx } = await fetchJSON('/find-type?name=AActor&contextLines=5');
  assert(withCtx.results && withCtx.results.length > 0, 'find-type with contextLines returns results');

  if (withCtx.results.length > 0) {
    const first = withCtx.results[0];
    const hasContext = first.context && Array.isArray(first.context.lines);
    assert(hasContext, 'Result has context.lines array');
    if (hasContext) {
      assert(first.context.lines.length > 0, `Context has ${first.context.lines.length} lines`);
      assert(typeof first.context.startLine === 'number', `Context has startLine: ${first.context.startLine}`);
      assert(first.context.lines.length <= 11, `Context lines <= 2*5+1=11 (got ${first.context.lines.length})`);
    }
  }

  // With contextLines=0 — should be same as no contextLines
  const { data: zeroCtx } = await fetchJSON('/find-type?name=AActor&contextLines=0');
  assert(zeroCtx.results && !zeroCtx.results[0]?.context, 'contextLines=0 produces no context');
}

// ===== S1: contextLines on find-member =====

async function testFindMemberContextLines() {
  console.log('\n--- S1: contextLines on find-member ---');

  // Without contextLines
  const { data: noCtx } = await fetchJSON('/find-member?name=BeginPlay');
  assert(noCtx.results && noCtx.results.length > 0, 'find-member returns results for BeginPlay');
  assert(!noCtx.results[0].context, 'No context field when contextLines not set');
  assert(!noCtx.results[0].signature, 'No signature field when includeSignatures not set');

  // With contextLines=3
  const { data: withCtx } = await fetchJSON('/find-member?name=BeginPlay&contextLines=3');
  assert(withCtx.results && withCtx.results.length > 0, 'find-member with contextLines returns results');

  if (withCtx.results.length > 0) {
    const first = withCtx.results[0];
    const hasContext = first.context && Array.isArray(first.context.lines);
    assert(hasContext, 'Member result has context.lines array');
    if (hasContext) {
      assert(first.context.lines.length > 0, `Context has ${first.context.lines.length} lines`);
      assert(first.context.lines.length <= 7, `Context lines <= 2*3+1=7 (got ${first.context.lines.length})`);
    }
  }
}

// ===== S2: includeSignatures on find-member =====

async function testFindMemberSignatures() {
  console.log('\n--- S2: includeSignatures on find-member ---');

  const { data } = await fetchJSON('/find-member?name=BeginPlay&includeSignatures=true');
  assert(data.results && data.results.length > 0, 'find-member with includeSignatures returns results');

  if (data.results.length > 0) {
    const withSig = data.results.filter(r => r.signature);
    assert(withSig.length > 0, `${withSig.length}/${data.results.length} results have signature`);
    if (withSig.length > 0) {
      assert(typeof withSig[0].signature === 'string', `Signature is a string: "${withSig[0].signature.slice(0, 80)}"`);
      assert(withSig[0].signature.length > 0, 'Signature is non-empty');
    }
  }

  // Signatures should not appear when includeSignatures is not set
  const { data: noSig } = await fetchJSON('/find-member?name=BeginPlay');
  if (noSig.results.length > 0) {
    assert(!noSig.results[0].signature, 'No signature when includeSignatures not set');
  }
}

// ===== S3: explain-type endpoint =====

async function testExplainType() {
  console.log('\n--- S3: explain-type compound endpoint ---');

  const { data, status } = await fetchJSON('/explain-type?name=AActor');
  assert(status === 200, `explain-type returns 200 (got ${status})`);
  assert(data.type !== null, 'explain-type returns a type object');

  if (data.type) {
    assert(typeof data.type.name === 'string', `Type has name: ${data.type.name}`);
    assert(typeof data.type.kind === 'string', `Type has kind: ${data.type.kind}`);
    assert(typeof data.type.path === 'string', 'Type has path');
  }

  assert(data.members !== undefined, 'explain-type includes members');
  if (data.members) {
    assert(Array.isArray(data.members.functions), 'members.functions is array');
    assert(Array.isArray(data.members.properties), 'members.properties is array');
    assert(typeof data.members.count === 'number', `members.count is number: ${data.members.count}`);
    assert(data.members.count > 0, `AActor should have members (got ${data.members.count})`);
    // Members should have signatures (explain-type attaches them by default)
    if (data.members.functions.length > 0) {
      assert(data.members.functions.length > 0, `AActor has ${data.members.functions.length} functions`);
      const withSig = data.members.functions.filter(f => f.signature);
      assert(withSig.length > 0, `${withSig.length} functions have signatures`);
    }
  }

  assert(data.children !== undefined, 'explain-type includes children');
  if (data.children) {
    assert(Array.isArray(data.children.results), 'children.results is array');
  }

  assert(typeof data.queryTimeMs === 'number', `queryTimeMs: ${data.queryTimeMs}ms`);
  assert(data.queryTimeMs < 500, `Query time under 500ms (got ${data.queryTimeMs}ms)`);

  // With contextLines
  const { data: withCtx } = await fetchJSON('/explain-type?name=AActor&contextLines=3');
  if (withCtx.type && withCtx.type.context) {
    assert(Array.isArray(withCtx.type.context.lines), 'explain-type with contextLines includes context on type');
  }

  // Without members/children
  const { data: noExtra } = await fetchJSON('/explain-type?name=AActor&includeMembers=false&includeChildren=false');
  assert(noExtra.type !== null, 'explain-type without members/children returns type');
  assert(noExtra.members === undefined, 'No members when includeMembers=false');
  assert(noExtra.children === undefined, 'No children when includeChildren=false');

  // Nonexistent type
  const { data: notFound } = await fetchJSON('/explain-type?name=NonExistentTypeXYZ123');
  assert(notFound.type === null, 'explain-type returns null type for nonexistent');
  assert(notFound.hints && notFound.hints.length > 0, 'explain-type returns hints for nonexistent');
}

// ===== S5: MCP Tool Analytics =====

async function testMcpToolAnalytics() {
  console.log('\n--- S5: MCP Tool Analytics ---');

  // Clear analytics first
  const { data: cleared } = await deleteJSON('/mcp-tool-analytics?all=true');
  assert(typeof cleared.deleted === 'number', `Cleared analytics: ${cleared.deleted}`);

  // POST a tool call
  const { data: posted, status: postStatus } = await postJSON('/internal/mcp-tool-call', {
    tool: 'unreal_find_type',
    args: '{"name":"AActor"}',
    durationMs: 42.5,
    resultSize: 1234,
    sessionId: 'test-session-001'
  });
  assert(postStatus === 200, `POST mcp-tool-call returns 200 (got ${postStatus})`);
  assert(posted.ok === true, 'POST returns ok: true');

  // POST another tool call
  await postJSON('/internal/mcp-tool-call', {
    tool: 'unreal_find_member',
    args: '{"name":"BeginPlay"}',
    durationMs: 15.3,
    resultSize: 5678,
    sessionId: 'test-session-001'
  });

  // POST a call from a different session
  await postJSON('/internal/mcp-tool-call', {
    tool: 'unreal_find_type',
    args: '{"name":"UWidget"}',
    durationMs: 8.2,
    resultSize: 900,
    sessionId: 'test-session-002'
  });

  // GET summary
  const { data: summary } = await fetchJSON('/mcp-tool-analytics?summary=true');
  assert(summary.total >= 3, `Total calls >= 3 (got ${summary.total})`);
  assert(Array.isArray(summary.byTool), 'Summary has byTool array');
  assert(summary.byTool.length >= 2, `At least 2 unique tools (got ${summary.byTool.length})`);
  assert(Array.isArray(summary.recent), 'Summary has recent array');
  assert(summary.recent.length >= 3, `At least 3 recent calls (got ${summary.recent.length})`);
  assert(Array.isArray(summary.bySessions), 'Summary has bySessions array');
  assert(summary.bySessions.length >= 2, `At least 2 sessions (got ${summary.bySessions.length})`);

  // GET filtered by tool name
  const { data: filtered } = await fetchJSON('/mcp-tool-analytics?toolName=unreal_find_type');
  assert(filtered.calls && filtered.calls.length >= 2, `Filtered by tool_name: ${filtered.calls?.length} calls`);

  // GET filtered by session
  const { data: bySession } = await fetchJSON('/mcp-tool-analytics?sessionId=test-session-001');
  assert(bySession.calls && bySession.calls.length >= 2, `Filtered by session: ${bySession.calls?.length} calls`);

  // Validation: missing tool name
  const { status: badStatus } = await postJSON('/internal/mcp-tool-call', {});
  assert(badStatus === 400, `Missing tool returns 400 (got ${badStatus})`);
}

// ===== S6: Batch Query Endpoint =====

async function testBatchEndpoint() {
  console.log('\n--- S6: Batch Query Endpoint ---');

  const { data, status } = await postJSON('/batch', {
    queries: [
      { method: 'findTypeByName', args: ['AActor', {}] },
      { method: 'findMember', args: ['BeginPlay', { maxResults: 5 }] },
      { method: 'findFileByName', args: ['Actor', { maxResults: 3 }] }
    ]
  });

  assert(status === 200, `Batch returns 200 (got ${status})`);
  assert(Array.isArray(data.results), 'Batch response has results array');
  assert(data.results.length === 3, `3 results for 3 queries (got ${data.results.length})`);
  assert(typeof data.totalTimeMs === 'number', `totalTimeMs: ${data.totalTimeMs}ms`);

  // Check individual results
  if (data.results.length >= 3) {
    assert(data.results[0].result && Array.isArray(data.results[0].result), 'Query 1 (findTypeByName) returns array');
    assert(data.results[1].result && Array.isArray(data.results[1].result), 'Query 2 (findMember) returns array');
    assert(data.results[2].result && Array.isArray(data.results[2].result), 'Query 3 (findFileByName) returns array');
  }

  // Test with invalid method
  const { data: withInvalid } = await postJSON('/batch', {
    queries: [
      { method: 'findTypeByName', args: ['AActor', {}] },
      { method: 'invalidMethod', args: [] }
    ]
  });
  assert(withInvalid.results.length === 2, 'Batch handles mix of valid/invalid');
  assert(withInvalid.results[1].error, 'Invalid method returns error in result');

  // Test max queries limit
  const tooMany = Array.from({ length: 11 }, () => ({ method: 'findTypeByName', args: ['A', {}] }));
  const { status: limitStatus } = await postJSON('/batch', { queries: tooMany });
  assert(limitStatus === 400, `>10 queries returns 400 (got ${limitStatus})`);

  // Test empty queries
  const { status: emptyStatus } = await postJSON('/batch', { queries: [] });
  assert(emptyStatus === 400, `Empty queries returns 400 (got ${emptyStatus})`);
}

// ===== #40: findTypeByName header preference =====

async function testHeaderPreference() {
  console.log('\n--- #40: findTypeByName header preference ---');

  // C++ types should prefer .h over .cpp
  const { data } = await fetchJSON('/find-type?name=AActor&language=cpp');
  assert(data.results && data.results.length > 0, 'find-type returns results for AActor (cpp)');
  if (data.results.length > 0) {
    const first = data.results[0];
    const isHeader = /\.(h|hpp|hxx)$/i.test(first.path);
    assert(isHeader, `First result is header file: ${first.path}`);
  }

  // If there are multiple results, headers should come before .cpp
  if (data.results.length > 1) {
    let headersDone = false;
    let sortedCorrectly = true;
    for (const r of data.results) {
      const isH = /\.(h|hpp|hxx)$/i.test(r.path);
      if (headersDone && isH) { sortedCorrectly = false; break; }
      if (!isH) headersDone = true;
    }
    assert(sortedCorrectly, 'Headers sorted before implementation files');
  }
}

// ===== #39: explain-type split member limits =====

async function testSplitMemberLimits() {
  console.log('\n--- #39: explain-type split member limits ---');

  // Default limits (30/30)
  const { data } = await fetchJSON('/explain-type?name=AActor');
  assert(data.members !== undefined, 'explain-type includes members');
  if (data.members) {
    assert(Array.isArray(data.members.functions), 'members.functions is array');
    assert(Array.isArray(data.members.properties), 'members.properties is array');
    assert(data.members.truncated !== undefined, 'members has truncated info');
    const hasBoth = data.members.functions.length > 0 && data.members.properties.length > 0;
    assert(hasBoth, `Has both functions (${data.members.functions.length}) and properties (${data.members.properties.length})`);
  }

  // With small function limit — should still get properties
  const { data: smallFunc } = await fetchJSON('/explain-type?name=AActor&maxFunctions=2&maxProperties=2');
  if (smallFunc.members) {
    assert(smallFunc.members.functions.length <= 2, `maxFunctions=2 respected (got ${smallFunc.members.functions.length})`);
    assert(smallFunc.members.properties.length <= 2, `maxProperties=2 respected (got ${smallFunc.members.properties.length})`);
  }

  // With large function limit but small property limit — functions should not be starved
  const { data: bigFunc } = await fetchJSON('/explain-type?name=AActor&maxFunctions=100&maxProperties=1');
  if (bigFunc.members) {
    assert(bigFunc.members.functions.length > 1, `Functions not starved when maxProperties=1 (got ${bigFunc.members.functions.length})`);
    assert(bigFunc.members.properties.length <= 1, `maxProperties=1 respected (got ${bigFunc.members.properties.length})`);
  }
}

// ===== #37: batch endpoint path cleaning =====

async function testBatchPathCleaning() {
  console.log('\n--- #37: Batch endpoint path cleaning ---');

  const { data } = await postJSON('/batch', {
    queries: [
      { method: 'findTypeByName', args: ['AActor', { maxResults: 1 }] },
      { method: 'findMember', args: ['BeginPlay', { maxResults: 1 }] }
    ]
  });

  if (data.results && data.results.length >= 2) {
    // Check first query result (findTypeByName)
    const typeResult = data.results[0].result;
    if (typeResult && typeResult.length > 0) {
      const path = typeResult[0].path;
      assert(!path.includes('\\'), `Batch findTypeByName path has no backslashes: ${path}`);
      assert(!path.match(/^[A-Z]:/), `Batch findTypeByName path is not absolute Windows: ${path}`);
    }

    // Check second query result (findMember)
    const memberResult = data.results[1].result;
    if (memberResult && memberResult.length > 0) {
      const path = memberResult[0].path;
      assert(!path.includes('\\'), `Batch findMember path has no backslashes: ${path}`);
      assert(!path.match(/^[A-Z]:/), `Batch findMember path is not absolute Windows: ${path}`);
    }
  }
}

// ===== #36: batch endpoint context/signatures forwarding =====

async function testBatchContextSignatures() {
  console.log('\n--- #36: Batch endpoint context/signatures forwarding ---');

  // Test contextLines forwarded for findMember
  const { data: ctxData } = await postJSON('/batch', {
    queries: [
      { method: 'findMember', args: ['BeginPlay', { maxResults: 1, contextLines: 3 }] }
    ]
  });

  if (ctxData.results && ctxData.results[0]?.result?.length > 0) {
    const member = ctxData.results[0].result[0];
    const hasCtx = member.context && Array.isArray(member.context.lines);
    assert(hasCtx, 'Batch findMember with contextLines has context');
    if (hasCtx) {
      assert(member.context.lines.length > 0, `Batch context has ${member.context.lines.length} lines`);
      assert(member.context.lines.length <= 7, `Batch context <= 2*3+1=7 lines`);
    }
  }

  // Test includeSignatures forwarded for findMember
  const { data: sigData } = await postJSON('/batch', {
    queries: [
      { method: 'findMember', args: ['BeginPlay', { maxResults: 3, includeSignatures: true }] }
    ]
  });

  if (sigData.results && sigData.results[0]?.result?.length > 0) {
    const withSig = sigData.results[0].result.filter(r => r.signature);
    assert(withSig.length > 0, `Batch findMember with includeSignatures: ${withSig.length} have signatures`);
    if (withSig.length > 0) {
      assert(typeof withSig[0].signature === 'string', 'Batch signature is string');
    }
  }

  // Test contextLines forwarded for findTypeByName
  const { data: typeCtx } = await postJSON('/batch', {
    queries: [
      { method: 'findTypeByName', args: ['AActor', { maxResults: 1, contextLines: 3 }] }
    ]
  });

  if (typeCtx.results && typeCtx.results[0]?.result?.length > 0) {
    const type = typeCtx.results[0].result[0];
    const hasCtx = type.context && Array.isArray(type.context.lines);
    assert(hasCtx, 'Batch findTypeByName with contextLines has context');
  }

  // Without contextLines/signatures — should NOT have them
  const { data: noOpts } = await postJSON('/batch', {
    queries: [
      { method: 'findMember', args: ['BeginPlay', { maxResults: 1 }] }
    ]
  });

  if (noOpts.results && noOpts.results[0]?.result?.length > 0) {
    const member = noOpts.results[0].result[0];
    assert(!member.context, 'Batch without contextLines has no context');
    assert(!member.signature, 'Batch without includeSignatures has no signature');
  }
}

// ===== Run all tests =====

async function main() {
  console.log('Testing issue #35 endpoints + #36-40 fixes...\n');

  // Health check
  try {
    const { data } = await fetchJSON('/health');
    console.log(`Service: ${data.status}, memory index: ${data.memoryIndex.loaded ? 'loaded' : 'NOT loaded'}`);
    if (!data.memoryIndex.loaded) {
      console.error('Memory index not loaded — some tests may fail');
    }
  } catch (err) {
    console.error(`Cannot connect to service: ${err.message}`);
    process.exit(1);
  }

  await testFindTypeContextLines();
  await testFindMemberContextLines();
  await testFindMemberSignatures();
  await testExplainType();
  await testMcpToolAnalytics();
  await testBatchEndpoint();

  // Issue #36-40 fixes
  await testHeaderPreference();
  await testSplitMemberLimits();
  await testBatchPathCleaning();
  await testBatchContextSignatures();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(`\nFailed tests:`);
    failures.forEach(f => console.log(`  - ${f}`));
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main();
