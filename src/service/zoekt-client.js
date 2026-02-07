const LANGUAGE_EXTENSIONS = {
  angelscript: '\\.as$',
  cpp: '\\.(cpp|h|hpp|cc|inl)$',
  config: '\\.(ini|json|uplugin|uproject)$'
};

const EXTENSION_TO_LANGUAGE = {
  '.as': 'angelscript',
  '.cpp': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.inl': 'cpp',
  '.ini': 'config', '.json': 'config', '.uplugin': 'config', '.uproject': 'config'
};

export class ZoektClient {
  constructor(port, options = {}) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.timeoutMs = options.timeoutMs || 10000;
  }

  async search(pattern, options = {}) {
    const { project, language, caseSensitive = true, maxResults = 50, contextLines = 2 } = options;

    const query = this._buildQuery(pattern, { project, language, caseSensitive });

    const body = {
      Q: query,
      Opts: {
        MaxDocDisplayCount: maxResults,
        NumContextLines: contextLines,
        TotalMaxMatchCount: maxResults * 10,
        ChunkMatches: false
      }
    };

    const startMs = performance.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let resp;
    try {
      resp = await fetch(`${this.baseUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Zoekt search timed out after ${this.timeoutMs}ms`);
      }
      throw new Error(`Zoekt search failed: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Zoekt returned ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    const durationMs = performance.now() - startMs;

    return this._mapResponse(data, durationMs);
  }

  _buildQuery(pattern, { project, language, caseSensitive }) {
    const parts = [];

    // Case sensitivity
    if (!caseSensitive) {
      parts.push('case:no');
    }

    // Language filter via file extension
    if (language && language !== 'all' && LANGUAGE_EXTENSIONS[language]) {
      parts.push(`file:${LANGUAGE_EXTENSIONS[language]}`);
    }

    // Project filter via path prefix
    if (project) {
      // Project name appears as a path component in the mirror directory
      parts.push(`file:${project}/`);
    }

    // The search pattern itself — use regex if it contains regex metacharacters
    if (this._hasRegexMeta(pattern)) {
      parts.push(`regex:${pattern}`);
    } else {
      parts.push(pattern);
    }

    return parts.join(' ');
  }

  _hasRegexMeta(pattern) {
    // Check for unescaped regex metacharacters
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] === '\\') {
        i++; // skip escaped char
        continue;
      }
      if ('.+*?^${}()|[]'.includes(pattern[i])) return true;
    }
    return false;
  }

  // Decode Go []byte fields (serialized as base64 strings in JSON)
  _decodeBytes(val) {
    if (!val) return '';
    return Buffer.from(val, 'base64').toString('utf-8');
  }

  _mapResponse(data, durationMs) {
    const results = [];
    let totalMatches = 0;
    let matchedFiles = 0;

    const files = data.Result?.Files || data.Files || [];
    const stats = data.Result?.Stats || data.Stats || {};

    for (const file of files) {
      const filePath = file.FileName || '';
      const fileProject = this._inferProject(filePath);
      const fileLanguage = this._inferLanguage(filePath);
      matchedFiles++;

      const lineMatches = file.LineMatches || [];
      for (const lm of lineMatches) {
        totalMatches++;

        const result = {
          file: filePath,
          project: fileProject,
          language: fileLanguage,
          line: (lm.LineNumber || 0) + 1, // Zoekt uses 0-based line numbers
          match: this._decodeBytes(lm.Line).trimEnd()
        };

        // Context lines (Before/After are []byte → single base64 string containing multiple lines)
        if (lm.Before || lm.After) {
          result.context = [];
          if (lm.Before) {
            const lines = this._decodeBytes(lm.Before).split(/\r?\n/);
            for (const line of lines) {
              if (line || result.context.length > 0) result.context.push(line.trimEnd());
            }
          }
          if (lm.After) {
            const lines = this._decodeBytes(lm.After).split(/\r?\n/);
            for (const line of lines) {
              result.context.push(line.trimEnd());
            }
          }
          // Remove trailing empty lines
          while (result.context.length > 0 && result.context[result.context.length - 1] === '') {
            result.context.pop();
          }
        }

        results.push(result);
      }

      // ChunkMatches fallback (if Zoekt returns chunks instead of line matches)
      const chunkMatches = file.ChunkMatches || [];
      for (const cm of chunkMatches) {
        const content = this._decodeBytes(cm.Content);
        const lines = content.split('\n');
        const startLine = cm.ContentStart?.LineNumber || 0;

        for (const range of (cm.Ranges || [])) {
          totalMatches++;
          const lineIdx = (range.Start?.LineNumber || 0) - startLine;
          const matchLine = lines[lineIdx] || '';

          results.push({
            file: filePath,
            project: fileProject,
            language: fileLanguage,
            line: (range.Start?.LineNumber || 0) + 1,
            match: matchLine.trimEnd()
          });
        }
      }
    }

    return {
      results,
      totalMatches: stats.MatchCount || totalMatches,
      matchedFiles: stats.FileCount || matchedFiles,
      filesSearched: stats.FilesConsidered || 0,
      searchEngine: 'zoekt',
      zoektDurationMs: Math.round(durationMs)
    };
  }

  _inferProject(filePath) {
    // First path segment is the project name in the mirror directory
    const firstSlash = filePath.indexOf('/');
    if (firstSlash > 0) {
      return filePath.slice(0, firstSlash);
    }
    return '';
  }

  _inferLanguage(filePath) {
    const dot = filePath.lastIndexOf('.');
    if (dot >= 0) {
      const ext = filePath.slice(dot).toLowerCase();
      return EXTENSION_TO_LANGUAGE[ext] || 'unknown';
    }
    return 'unknown';
  }
}
