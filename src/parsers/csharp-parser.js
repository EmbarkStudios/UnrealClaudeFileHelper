import { readFile } from 'fs/promises';

export async function parseCSharpFile(filePath) {
  const content = await readFile(filePath, 'utf-8');
  return parseCSharpContent(content, filePath);
}

export function parseCSharpContent(content, filePath = '') {
  const result = {
    path: filePath,
    classes: [],
    structs: [],
    enums: [],
    delegates: [],
    members: []
  };

  const lines = content.split('\n');

  let currentType = null;
  let braceDepth = 0;
  let typeStartDepth = 0;
  let inEnum = false;
  let pendingAttributes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed === '' || trimmed.startsWith('//')) {
      continue;
    }

    // Skip multi-line comments (basic handling)
    if (trimmed.startsWith('/*')) {
      // Find end of block comment
      let j = i;
      while (j < lines.length && !lines[j].includes('*/')) j++;
      i = j;
      continue;
    }

    // Collect attributes
    const attrMatch = trimmed.match(/^\[([^\]]+)\]/);
    if (attrMatch && !trimmed.match(/^\[.*\]\s*(public|private|protected|internal|static|abstract|sealed|partial|class|struct|enum|interface|delegate|void|int|string|bool|float|double|long|byte|short|char|decimal|object)/)) {
      pendingAttributes.push(attrMatch[1].replace(/\(.*\)/, '').trim());
      const braceDelta = countBraces(line);
      braceDepth += braceDelta;
      continue;
    }
    // Attribute on same line as declaration — extract it
    const inlineAttrMatch = trimmed.match(/^\[([^\]]+)\]\s+/);
    if (inlineAttrMatch) {
      pendingAttributes.push(inlineAttrMatch[1].replace(/\(.*\)/, '').trim());
    }

    const braceDelta = countBraces(line);

    // File-scoped namespace: namespace X.Y;
    const fileScopedNs = trimmed.match(/^\s*namespace\s+([\w.]+)\s*;/);
    if (fileScopedNs) {
      braceDepth += braceDelta;
      pendingAttributes = [];
      continue;
    }

    // Block namespace: namespace X.Y { }
    const blockNs = trimmed.match(/^\s*namespace\s+([\w.]+)/);
    if (blockNs && !fileScopedNs) {
      braceDepth += braceDelta;
      pendingAttributes = [];
      continue;
    }

    // Top-level type declarations (when not inside a type body)
    if (!currentType) {
      // Delegate declaration
      const delegateMatch = trimmed.match(/^\s*(?:public\s+|private\s+|protected\s+|internal\s+)*delegate\s+\S+\s+(\w+)\s*[<(]/);
      if (delegateMatch) {
        result.delegates.push({
          name: delegateMatch[1],
          line: lineNum,
          kind: 'delegate'
        });
        braceDepth += braceDelta;
        pendingAttributes = [];
        continue;
      }

      // Class/Interface declaration
      const classMatch = trimmed.match(/^\s*(?:\[.*?\]\s+)?(?:(?:public|private|protected|internal|static|abstract|sealed|partial|new)\s+)*(?:class|interface)\s+(\w+)(?:<[^>]*>)?(?:\s*:\s*(.+?))?(?:\s*(?:where\b.*)?)?$/);
      if (!classMatch) {
        // Also try with opening brace on same line
        const classMatch2 = trimmed.match(/^\s*(?:\[.*?\]\s+)?(?:(?:public|private|protected|internal|static|abstract|sealed|partial|new)\s+)*(?:class|interface)\s+(\w+)(?:<[^>]*>)?(?:\s*:\s*(.+?))?(?:\s*(?:where\b.*)?)?\s*\{/);
        if (classMatch2) {
          processClassDecl(classMatch2, trimmed, lineNum);
          braceDepth += braceDelta;
          continue;
        }
      }
      if (classMatch) {
        processClassDecl(classMatch, trimmed, lineNum);
        braceDepth += braceDelta;
        continue;
      }

      // Struct declaration
      const structMatch = trimmed.match(/^\s*(?:\[.*?\]\s+)?(?:(?:public|private|protected|internal|static|partial|readonly|ref)\s+)*struct\s+(\w+)(?:<[^>]*>)?(?:\s*:\s*(.+?))?/);
      if (structMatch) {
        const structName = structMatch[1];
        const parentStr = structMatch[2] || null;
        const parent = parentStr ? parentStr.split(',')[0].trim().replace(/<.*>/, '') : null;
        const structInfo = {
          name: structName,
          parent,
          line: lineNum,
          reflected: false,
          specifiers: pendingAttributes.length > 0 ? [...pendingAttributes] : []
        };
        result.structs.push(structInfo);
        currentType = structInfo;
        typeStartDepth = braceDepth;
        inEnum = false;
        pendingAttributes = [];
        braceDepth += braceDelta;
        continue;
      }

      // Enum declaration
      const enumMatch = trimmed.match(/^\s*(?:\[.*?\]\s+)?(?:(?:public|private|protected|internal)\s+)*enum\s+(\w+)/);
      if (enumMatch) {
        const enumName = enumMatch[1];
        const enumInfo = {
          name: enumName,
          line: lineNum,
          reflected: false,
          specifiers: pendingAttributes.length > 0 ? [...pendingAttributes] : []
        };
        result.enums.push(enumInfo);
        currentType = enumInfo;
        typeStartDepth = braceDepth;
        inEnum = true;
        pendingAttributes = [];
        braceDepth += braceDelta;
        continue;
      }

      braceDepth += braceDelta;
      pendingAttributes = [];
      continue;
    }

    // Inside a type body — parse members
    if (currentType && braceDepth > typeStartDepth) {
      if (inEnum) {
        // Parse enum values
        if (trimmed !== '{' && trimmed !== '}' && trimmed !== '};' &&
            !trimmed.startsWith('//') && !trimmed.startsWith('[')) {
          const enumValueMatch = trimmed.match(/^(\w+)\s*(?:[,=}]|$)/);
          if (enumValueMatch) {
            result.members.push({
              name: enumValueMatch[1],
              memberKind: 'enum_value',
              line: lineNum,
              isStatic: false,
              specifiers: null,
              ownerName: currentType.name
            });
          }
        }
      } else {
        // Inside class/struct body

        // Skip braces, usings, preprocessor
        if (trimmed === '{' || trimmed === '}' || trimmed === '};' ||
            trimmed.startsWith('//') || trimmed.startsWith('#') ||
            trimmed.startsWith('using ')) {
          braceDepth += braceDelta;
          if (currentType && braceDepth <= typeStartDepth) {
            currentType = null;
            inEnum = false;
            pendingAttributes = [];
          }
          continue;
        }

        // Only parse at first level inside type
        if (braceDepth === typeStartDepth + 1) {
          // Collect member-level attributes
          const memberAttrMatch = trimmed.match(/^\[([^\]]+)\]$/);
          if (memberAttrMatch) {
            pendingAttributes.push(memberAttrMatch[1].replace(/\(.*\)/, '').trim());
            braceDepth += braceDelta;
            continue;
          }

          // Constructor: ClassName(params)
          const ctorMatch = trimmed.match(/^\s*(?:(?:public|private|protected|internal|static)\s+)*(\w+)\s*\(([^)]*)\)/);
          if (ctorMatch && ctorMatch[1] === currentType.name) {
            result.members.push({
              name: ctorMatch[1],
              memberKind: 'function',
              line: lineNum,
              isStatic: /\bstatic\b/.test(trimmed),
              specifiers: pendingAttributes.length > 0 ? pendingAttributes.join(', ') : '',
              ownerName: currentType.name
            });
            pendingAttributes = [];
            braceDepth += braceDelta;
            if (currentType && braceDepth <= typeStartDepth) {
              currentType = null;
              inEnum = false;
            }
            continue;
          }

          // Method: [modifiers] ReturnType Name(params) or ReturnType Name<T>(params)
          const methodMatch = trimmed.match(/^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|new|extern|partial|unsafe)\s+)*(\S+)\s+(\w+)\s*(?:<[^>]*>)?\s*\(/);
          if (methodMatch && !trimmed.startsWith('if') && !trimmed.startsWith('for') &&
              !trimmed.startsWith('while') && !trimmed.startsWith('switch') &&
              !trimmed.startsWith('return') && !trimmed.startsWith('var ') &&
              methodMatch[2] !== currentType.name) {
            result.members.push({
              name: methodMatch[2],
              memberKind: 'function',
              line: lineNum,
              isStatic: /\bstatic\b/.test(trimmed),
              specifiers: pendingAttributes.length > 0 ? pendingAttributes.join(', ') : (/\bvirtual\b/.test(trimmed) ? 'virtual' : (/\boverride\b/.test(trimmed) ? 'override' : '')),
              ownerName: currentType.name
            });
            pendingAttributes = [];
            braceDepth += braceDelta;
            if (currentType && braceDepth <= typeStartDepth) {
              currentType = null;
              inEnum = false;
            }
            continue;
          }

          // Property: Type Name { get; set; } or Type Name => expr;
          const propMatch = trimmed.match(/^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|new|readonly)\s+)*(\S+)\s+(\w+)\s*(?:\{|\s*=>)/);
          if (propMatch && propMatch[2] !== currentType.name &&
              !trimmed.startsWith('if') && !trimmed.startsWith('for') &&
              !trimmed.startsWith('while') && !trimmed.startsWith('return') &&
              !trimmed.startsWith('var ') && !trimmed.match(/^\s*(?:get|set)\s*[{;]/)) {
            // Verify it's not a method (would have parens before {)
            const beforeBrace = trimmed.match(/(\w+)\s*(?:<[^>]*>)?\s*\(/);
            if (!beforeBrace || beforeBrace[1] !== propMatch[2]) {
              result.members.push({
                name: propMatch[2],
                memberKind: 'property',
                line: lineNum,
                isStatic: /\bstatic\b/.test(trimmed),
                specifiers: pendingAttributes.length > 0 ? pendingAttributes.join(', ') : '',
                ownerName: currentType.name
              });
              pendingAttributes = [];
              braceDepth += braceDelta;
              if (currentType && braceDepth <= typeStartDepth) {
                currentType = null;
                inEnum = false;
              }
              continue;
            }
          }

          // Field: Type Name = value; or Type Name;
          const fieldMatch = trimmed.match(/^\s*(?:(?:public|private|protected|internal|static|readonly|const|volatile|new)\s+)*(\S+)\s+(\w+)\s*(?:[=;])/);
          if (fieldMatch && fieldMatch[2] !== currentType.name &&
              !trimmed.startsWith('if') && !trimmed.startsWith('for') &&
              !trimmed.startsWith('while') && !trimmed.startsWith('return') &&
              !trimmed.startsWith('var ') && !trimmed.startsWith('using ')) {
            result.members.push({
              name: fieldMatch[2],
              memberKind: 'property',
              line: lineNum,
              isStatic: /\bstatic\b/.test(trimmed) || /\bconst\b/.test(trimmed),
              specifiers: pendingAttributes.length > 0 ? pendingAttributes.join(', ') : '',
              ownerName: currentType.name
            });
            pendingAttributes = [];
            braceDepth += braceDelta;
            if (currentType && braceDepth <= typeStartDepth) {
              currentType = null;
              inEnum = false;
            }
            continue;
          }

          pendingAttributes = [];
        }
      }
    }

    braceDepth += braceDelta;

    // Check if we've exited the current type
    if (currentType && braceDepth <= typeStartDepth) {
      currentType = null;
      inEnum = false;
      pendingAttributes = [];
    }
  }

  return result;

  function processClassDecl(match, trimmed, lineNum) {
    const className = match[1];
    const parentStr = match[2] || null;
    const isInterface = /\binterface\b/.test(trimmed);

    // Extract parent: first non-interface parent from the inheritance list
    let parent = null;
    if (parentStr) {
      const parents = parentStr.split(',').map(p => p.trim().replace(/<.*>/, ''));
      for (const p of parents) {
        // Skip interface parents (start with I and have uppercase second char)
        if (p.length > 1 && p[0] === 'I' && p[1] === p[1].toUpperCase() && p[1] !== p[1].toLowerCase()) {
          if (!isInterface) continue; // skip interface parents for classes
        }
        parent = p;
        break;
      }
    }

    const classInfo = {
      name: className,
      parent,
      line: lineNum,
      reflected: false,
      kind: isInterface ? 'interface' : 'class',
      specifiers: pendingAttributes.length > 0 ? [...pendingAttributes] : []
    };
    result.classes.push(classInfo);
    currentType = classInfo;
    typeStartDepth = braceDepth;
    inEnum = false;
    pendingAttributes = [];
  }
}

function countBraces(line) {
  let delta = 0;
  let inString = false;
  let stringChar = '';
  let isVerbatim = false;
  let inBlockComment = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    // Inside block comment — look for */
    if (inBlockComment) {
      if (ch === '*' && i + 1 < line.length && line[i + 1] === '/') {
        inBlockComment = false;
        i++; // skip /
      }
      continue;
    }

    if (inString) {
      if (isVerbatim) {
        // Verbatim string @"..." — "" escapes a quote, no backslash escaping
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            i++; // skip escaped quote
            continue;
          }
          inString = false;
          isVerbatim = false;
        }
        continue;
      }
      if (ch === '\\') { i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    // Verbatim string: @"..." (also handles @$"..." combination)
    if (ch === '@' && i + 1 < line.length && line[i + 1] === '"') {
      inString = true;
      isVerbatim = true;
      stringChar = '"';
      i++; // skip the quote
    // Interpolated string: $"..." — treat as regular string (braces inside are ignored)
    } else if (ch === '$' && i + 1 < line.length && line[i + 1] === '"') {
      inString = true;
      isVerbatim = false;
      stringChar = '"';
      i++; // skip the quote
    } else if (ch === '"' || ch === '\'') {
      inString = true;
      stringChar = ch;
    } else if (ch === '/' && i + 1 < line.length && line[i + 1] === '/') {
      break; // line comment — rest of line is ignored
    } else if (ch === '/' && i + 1 < line.length && line[i + 1] === '*') {
      inBlockComment = true;
      i++; // skip *
    } else if (ch === '{') {
      delta++;
    } else if (ch === '}') {
      delta--;
    }
  }
  return delta;
}
