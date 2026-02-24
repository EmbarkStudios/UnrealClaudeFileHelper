/**
 * Count net brace depth change in a line, ignoring braces inside strings and
 * single-line comments (// ...).
 *
 * Known limitation: block comments (/* ... *​/) are NOT handled — a brace
 * inside a block comment will still be counted.  In practice this rarely
 * causes issues because the parsers already skip lines that start with
 * comment tokens, and multi-line block comments with braces are uncommon.
 */
export function countBraces(line) {
  let delta = 0;
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
    } else if (ch === '/' && line[i + 1] === '/') {
      break; // rest is comment
    } else if (ch === '{') {
      delta++;
    } else if (ch === '}') {
      delta--;
    }
  }
  return delta;
}
