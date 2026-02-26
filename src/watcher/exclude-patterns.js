function escapeRegexLiteral(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function buildExcludeRegex(pattern) {
  const normalizedPattern = String(pattern || '').trim().replace(/\\/g, '/');
  if (!normalizedPattern) return null;

  const escaped = escapeRegexLiteral(normalizedPattern);
  const wildcardPattern = escaped
    .replace(/\*\*/g, '___DOUBLE_STAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLE_STAR___/g, '.*');

  // Match on path-segment boundaries anywhere in the path.
  return new RegExp(`(^|.*/)${wildcardPattern}($|/.*)`);
}

export function compileExcludePatterns(excludePatterns = []) {
  const compiled = [];
  for (const pattern of excludePatterns) {
    const regex = buildExcludeRegex(pattern);
    if (regex) compiled.push(regex);
  }
  return compiled;
}

export function shouldExcludePath(filePath, compiledExcludePatterns = []) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/');
  for (const regex of compiledExcludePatterns) {
    if (regex.test(normalizedPath)) return true;
  }
  return false;
}
