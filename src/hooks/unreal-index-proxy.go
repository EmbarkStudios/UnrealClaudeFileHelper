package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const serviceURL = "http://127.0.0.1:3847"
const timeout = 5 * time.Second

// ── Regex patterns ───────────────────────────────────────────

var (
	fileExtRe = regexp.MustCompile(`(?i)\.(as|cpp|h|hpp|cs|py|ini|json|xml|yaml|yml|toml|md|txt)$`)

	// Bash command detection
	lsRe   = regexp.MustCompile(`^\s*(ls|dir|tree)\b`)
	findRe = regexp.MustCompile(`^\s*find\b`)
	grepRe = regexp.MustCompile(`^\s*(grep|rg)\b`)
	catRe  = regexp.MustCompile(`^\s*(cat|head|tail)\b`)
	wcRe   = regexp.MustCompile(`^\s*wc\b`)

	// PowerShell commands (powershell -Command "..." or pwsh -c "...")
	powershellRe     = regexp.MustCompile(`(?i)^\s*(powershell|pwsh)\b`)
	getChildItemRe   = regexp.MustCompile(`(?i)Get-ChildItem|gci\b|ls\b`)
	selectStringRe   = regexp.MustCompile(`(?i)Select-String|sls\b`)
	getContentRe     = regexp.MustCompile(`(?i)Get-Content|gc\b|type\b`)
	psFilterRe       = regexp.MustCompile(`(?i)-Filter\s+['"]?([^'"\s]+)['"]?`)
	psPatternRe      = regexp.MustCompile(`(?i)-Pattern\s+['"]?([^'"\s]+)['"]?`)

	// Extract -name argument from find commands
	findNameRe = regexp.MustCompile(`-name\s+["']?([^"'\s]+)["']?`)

	// Extract pattern from grep/rg commands — handles quoted patterns with \| and spaces
	shellGrepPatternRe = regexp.MustCompile(`(?:grep|rg)\s+(?:-[a-zA-Z]+\s+(?:\d+\s+)?)*(?:"([^"]+)"|'([^']+)'|(\S+))`)

	// Smart Grep routing: type definitions
	classDefRe = regexp.MustCompile(`^(?:class|struct|enum)\s+(\w+)`)
	uePrefixRe = regexp.MustCompile(`^[UAFES][A-Z][a-zA-Z0-9_]+$`)

	// Smart Grep routing: member/function definitions
	funcDefRe = regexp.MustCompile(`^(?:void|int|float|bool|double|FVector|FString|FName|FText|TArray|TMap|TSubclassOf|UFUNCTION|UPROPERTY)\s+(\w+)`)
)

// ── Types ────────────────────────────────────────────────────

type HookInput struct {
	ToolName  string                 `json:"tool_name"`
	ToolInput map[string]interface{} `json:"tool_input"`
}

type HookOutput struct {
	HSO struct {
		Event    string `json:"hookEventName"`
		Decision string `json:"permissionDecision"`
		Reason   string `json:"permissionDecisionReason"`
	} `json:"hookSpecificOutput"`
}

type GrepResult struct {
	File    string   `json:"file"`
	Line    int      `json:"line"`
	Match   string   `json:"match"`
	Context []string `json:"context"`
}

type GrepResponse struct {
	Results      []GrepResult `json:"results"`
	TotalMatches int          `json:"totalMatches"`
	Truncated    bool         `json:"truncated"`
	Error        string       `json:"error"`
}

type FindFileResult struct {
	File string `json:"file"`
}

type FindFileResponse struct {
	Results []FindFileResult `json:"results"`
	Error   string           `json:"error"`
}

type FindTypeResult struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Project string `json:"project"`
	Path    string `json:"path"`
	Line    int    `json:"line"`
}

type FindTypeResponse struct {
	Results []FindTypeResult `json:"results"`
	Error   string           `json:"error"`
}

type FindMemberResult struct {
	Name      string `json:"name"`
	OwnerName string `json:"ownerName"`
	Kind      string `json:"memberKind"`
	Path      string `json:"path"`
	Line      int    `json:"line"`
}

type FindMemberResponse struct {
	Results []FindMemberResult `json:"results"`
	Error   string             `json:"error"`
}

// ── Helpers ──────────────────────────────────────────────────

func allow() { os.Exit(0) }

func deny(reason string) {
	out := HookOutput{}
	out.HSO.Event = "PreToolUse"
	out.HSO.Decision = "deny"
	out.HSO.Reason = reason
	data, _ := json.Marshal(out)
	os.Stdout.Write(data)
	os.Exit(0)
}

func str(m map[string]interface{}, k string) string {
	if v, ok := m[k]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func num(m map[string]interface{}, k string) float64 {
	if v, ok := m[k]; ok {
		if f, ok := v.(float64); ok {
			return f
		}
	}
	return 0
}

func flagVal(m map[string]interface{}, k string) bool {
	if v, ok := m[k]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return false
}

func inferLang(glob, typ string) string {
	src := glob
	if src == "" {
		src = typ
	}
	switch {
	case strings.Contains(src, ".as") || typ == "as":
		return "angelscript"
	case strings.Contains(src, ".cpp") || strings.Contains(src, ".h") || strings.Contains(src, ".hpp") || typ == "cpp":
		return "cpp"
	case strings.Contains(src, ".ini") || strings.Contains(src, ".cfg"):
		return "config"
	}
	return ""
}

func fetchJSON(u string, target interface{}) bool {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(u)
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
		}
		return false
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false
	}
	return json.Unmarshal(body, target) == nil
}

// ── Indexed path bypass ─────────────────────────────────────

var indexedPrefixes []string

func init() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	configPath := filepath.Join(filepath.Dir(exe), "unreal-index-paths.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return
	}
	var cfg struct {
		IndexedPrefixes []string `json:"indexedPrefixes"`
	}
	if json.Unmarshal(data, &cfg) == nil {
		for _, p := range cfg.IndexedPrefixes {
			indexedPrefixes = append(indexedPrefixes, normalizePath(p))
		}
	}
}

// normalizePath lowercases, converts backslashes to forward slashes,
// strips trailing slashes, and converts Git Bash /d/... to d:/...
func normalizePath(p string) string {
	s := strings.ToLower(strings.ReplaceAll(p, "\\", "/"))
	s = strings.TrimRight(s, "/")
	// Git Bash: /d/path → d:/path
	if len(s) >= 3 && s[0] == '/' && s[2] == '/' && s[1] >= 'a' && s[1] <= 'z' {
		s = string(s[1]) + ":" + s[2:]
	}
	return s
}

// isInsideIndex returns true if the path is empty, unresolvable, or overlaps
// with any indexed project directory. Returns false only when the path is
// clearly outside all indexed directories (allowing native tools through).
func isInsideIndex(path string) bool {
	if path == "" || len(indexedPrefixes) == 0 {
		return true
	}
	norm := normalizePath(path)
	for _, prefix := range indexedPrefixes {
		if strings.HasPrefix(norm, prefix) || strings.HasPrefix(prefix, norm) {
			return true
		}
	}
	return false
}

// extractShellTargetPath tries to extract the target directory from a shell command.
func extractShellTargetPath(cmd string) string {
	parts := strings.Fields(cmd)
	if len(parts) < 2 {
		return ""
	}
	// For grep/rg: last non-flag argument that looks like a path
	if grepRe.MatchString(cmd) {
		for i := len(parts) - 1; i >= 1; i-- {
			arg := parts[i]
			if strings.HasPrefix(arg, "-") || strings.HasPrefix(arg, "'") || strings.HasPrefix(arg, "\"") {
				continue
			}
			if strings.ContainsAny(arg, "/\\") || (len(arg) >= 3 && arg[1] == ':') {
				return arg
			}
		}
	}
	// For find: first non-flag argument after "find"
	if findRe.MatchString(cmd) {
		for i := 1; i < len(parts); i++ {
			if strings.HasPrefix(parts[i], "-") {
				break
			}
			if strings.ContainsAny(parts[i], "/\\") || parts[i] == "." || (len(parts[i]) >= 3 && parts[i][1] == ':') {
				return parts[i]
			}
		}
	}
	// For ls: first non-flag argument
	if lsRe.MatchString(cmd) {
		for i := 1; i < len(parts); i++ {
			if strings.HasPrefix(parts[i], "-") {
				continue
			}
			return parts[i]
		}
	}
	return ""
}

// ── Smart routing: try find-type ─────────────────────────────

func tryFindType(name string) string {
	p := url.Values{}
	p.Set("name", name)
	p.Set("maxResults", "20")

	var data FindTypeResponse
	if !fetchJSON(serviceURL+"/find-type?"+p.Encode(), &data) || data.Error != "" || len(data.Results) == 0 {
		return ""
	}

	var lines []string
	for _, r := range data.Results {
		lines = append(lines, fmt.Sprintf("%s:%d: %s %s (%s)", r.Path, r.Line, r.Kind, r.Name, r.Project))
	}
	return fmt.Sprintf(
		"[unreal-index] Smart-routed to /find-type for \"%s\":\n\n%s\n\n"+
			"Precise type definition results from index.",
		name, strings.Join(lines, "\n"))
}

// ── Smart routing: try find-member ───────────────────────────

func tryFindMember(name string) string {
	p := url.Values{}
	p.Set("name", name)
	p.Set("maxResults", "20")

	var data FindMemberResponse
	if !fetchJSON(serviceURL+"/find-member?"+p.Encode(), &data) || data.Error != "" || len(data.Results) == 0 {
		return ""
	}

	var lines []string
	for _, r := range data.Results {
		owner := r.OwnerName
		if owner == "" {
			owner = "(global)"
		}
		lines = append(lines, fmt.Sprintf("%s:%d: %s %s::%s", r.Path, r.Line, r.Kind, owner, r.Name))
	}
	return fmt.Sprintf(
		"[unreal-index] Smart-routed to /find-member for \"%s\":\n\n%s\n\n"+
			"Precise member definition results from index.",
		name, strings.Join(lines, "\n"))
}

// ── Grep handler (with smart routing) ────────────────────────

func handleGrep(ti map[string]interface{}) {
	pattern := str(ti, "pattern")
	path := str(ti, "path")
	outputMode := str(ti, "output_mode")
	glob := str(ti, "glob")
	typ := str(ti, "type")

	if fileExtRe.MatchString(path) || len(pattern) < 2 {
		allow()
	}

	// Bypass: target path is outside all indexed project directories
	if !isInsideIndex(path) {
		allow()
	}

	// Smart routing: detect type definition patterns
	if m := classDefRe.FindStringSubmatch(pattern); m != nil {
		if result := tryFindType(m[1]); result != "" {
			deny(result)
		}
	}

	// Smart routing: detect UE-prefixed type names (UAimComponent, FVector, etc.)
	if uePrefixRe.MatchString(pattern) {
		if result := tryFindType(pattern); result != "" {
			deny(result)
		}
	}

	// Smart routing: detect function definition patterns
	if m := funcDefRe.FindStringSubmatch(pattern); m != nil {
		if result := tryFindMember(m[1]); result != "" {
			deny(result)
		}
	}

	// Fall through to regular grep
	maxRes := int(num(ti, "head_limit"))
	if maxRes == 0 {
		maxRes = 30
	}

	p := url.Values{}
	p.Set("pattern", pattern)
	p.Set("maxResults", fmt.Sprintf("%d", maxRes))
	p.Set("grouped", "false")
	p.Set("symbols", "false")
	if flagVal(ti, "-i") {
		p.Set("caseSensitive", "false")
	}
	ctx := num(ti, "-C")
	if ctx == 0 {
		ctx = num(ti, "context")
	}
	if ctx > 0 {
		p.Set("contextLines", fmt.Sprintf("%d", int(ctx)))
	}
	if lang := inferLang(glob, typ); lang != "" {
		p.Set("language", lang)
	}

	var data GrepResponse
	if !fetchJSON(serviceURL+"/grep?"+p.Encode(), &data) || data.Error != "" || len(data.Results) == 0 {
		allow()
	}

	mode := outputMode
	if mode == "" {
		mode = "files_with_matches"
	}

	var formatted string
	switch mode {
	case "files_with_matches":
		seen := map[string]bool{}
		var files []string
		for _, r := range data.Results {
			if !seen[r.File] {
				seen[r.File] = true
				files = append(files, r.File)
			}
		}
		formatted = strings.Join(files, "\n")
	case "count":
		counts := map[string]int{}
		var order []string
		for _, r := range data.Results {
			if counts[r.File] == 0 {
				order = append(order, r.File)
			}
			counts[r.File]++
		}
		var lines []string
		for _, f := range order {
			lines = append(lines, fmt.Sprintf("%s: %d", f, counts[f]))
		}
		formatted = strings.Join(lines, "\n")
	default:
		var lines []string
		for _, r := range data.Results {
			ln := fmt.Sprintf("%s:%d: %s", r.File, r.Line, r.Match)
			for _, c := range r.Context {
				ln += "\n  " + c
			}
			lines = append(lines, ln)
		}
		formatted = strings.Join(lines, "\n")
	}

	trunc := ""
	if data.Truncated {
		trunc = fmt.Sprintf(" (%d of %d)", len(data.Results), data.TotalMatches)
	}

	deny(fmt.Sprintf(
		"[unreal-index] Grep intercepted — indexed results for \"%s\"%s:\n\n%s\n\n"+
			"Results from pre-built index. To search a specific file use Read. "+
			"To search outside the indexed project, ask the user to allow direct Grep.",
		pattern, trunc, formatted))
}

// ── Glob handler ─────────────────────────────────────────────

func handleGlob(ti map[string]interface{}) {
	pattern := str(ti, "pattern")
	path := str(ti, "path")

	// Determine the effective search directory from path or glob pattern prefix
	searchDir := path
	if searchDir == "" {
		if idx := strings.IndexAny(pattern, "*?"); idx > 0 {
			prefix := pattern[:idx]
			if lastSep := strings.LastIndexAny(prefix, "/\\"); lastSep >= 0 {
				searchDir = prefix[:lastSep]
			}
		}
	}
	if !isInsideIndex(searchDir) {
		allow()
	}

	basename := pattern
	if idx := strings.LastIndexAny(basename, "/\\"); idx >= 0 {
		basename = basename[idx+1:]
	}
	cleaned := strings.NewReplacer("*", "", "?", "").Replace(basename)
	if idx := strings.LastIndex(cleaned, "."); idx >= 0 {
		cleaned = cleaned[:idx]
	}
	if len(cleaned) < 3 {
		allow()
	}

	p := url.Values{}
	p.Set("filename", cleaned)
	p.Set("maxResults", "30")

	var data FindFileResponse
	if !fetchJSON(serviceURL+"/find-file?"+p.Encode(), &data) || data.Error != "" || len(data.Results) == 0 {
		allow()
	}

	var files []string
	for _, r := range data.Results {
		files = append(files, r.File)
	}

	deny(fmt.Sprintf(
		"[unreal-index] Glob intercepted — indexed results for \"%s\":\n\n%s\n\n"+
			"Results from pre-built index. "+
			"To search outside the indexed project, ask the user to allow direct Glob.",
		pattern, strings.Join(files, "\n")))
}

// ── Bash handler ─────────────────────────────────────────────

func handleBash(ti map[string]interface{}) {
	cmd := str(ti, "command")
	if cmd == "" {
		allow()
	}

	// Trim leading whitespace for matching
	trimmed := strings.TrimSpace(cmd)

	// Bypass: if the command targets a path outside the indexed projects, allow through
	if shellPath := extractShellTargetPath(trimmed); shellPath != "" && !isInsideIndex(shellPath) {
		allow()
	}

	// A. Directory listing: ls, dir, tree → block, redirect to Glob
	if lsRe.MatchString(trimmed) {
		deny(
			"[unreal-index] Directory listing commands (ls, dir, tree) are blocked.\n\n" +
				"Use Glob to find files by pattern (e.g., Glob with pattern \"**/*.as\") " +
				"or Read to view a specific file. " +
				"Glob is intercepted by unreal-index for fast indexed results.")
	}

	// B. Find commands → extract -name and proxy to /find-file, or block
	if findRe.MatchString(trimmed) {
		if m := findNameRe.FindStringSubmatch(trimmed); m != nil {
			// Extract filename, strip glob chars
			name := strings.NewReplacer("*", "", "?", "").Replace(m[1])
			if idx := strings.LastIndex(name, "."); idx >= 0 {
				name = name[:idx]
			}
			if len(name) >= 3 {
				p := url.Values{}
				p.Set("filename", name)
				p.Set("maxResults", "30")

				var data FindFileResponse
				if fetchJSON(serviceURL+"/find-file?"+p.Encode(), &data) && data.Error == "" && len(data.Results) > 0 {
					var files []string
					for _, r := range data.Results {
						files = append(files, r.File)
					}
					deny(fmt.Sprintf(
						"[unreal-index] find command intercepted — indexed results for \"%s\":\n\n%s\n\n"+
							"Results from pre-built index. Use Glob for file searches.",
						name, strings.Join(files, "\n")))
				}
			}
		}
		// No -name or no results — still block the find command
		deny(
			"[unreal-index] find commands are blocked.\n\n" +
				"Use Glob to find files by pattern (intercepted by unreal-index for fast results) " +
				"or Read to view specific files.")
	}

	// C. Shell grep/rg → extract pattern and proxy to /grep
	if grepRe.MatchString(trimmed) {
		if m := shellGrepPatternRe.FindStringSubmatch(trimmed); m != nil {
			// Pick the matched group: m[1]=double-quoted, m[2]=single-quoted, m[3]=unquoted
			pattern := m[1]
			if pattern == "" {
				pattern = m[2]
			}
			if pattern == "" {
				pattern = m[3]
			}
			// Convert basic grep alternation \| to regex |
			pattern = strings.ReplaceAll(pattern, `\|`, "|")
			// Strip other basic grep escapes: \( \) \+ \?
			for _, esc := range []string{`\(`, `\)`, `\+`, `\?`} {
				pattern = strings.ReplaceAll(pattern, esc, esc[1:])
			}

			if len(pattern) >= 2 {
				p := url.Values{}
				p.Set("pattern", pattern)
				p.Set("maxResults", "30")
				p.Set("grouped", "false")
				p.Set("symbols", "false")

				var data GrepResponse
				if fetchJSON(serviceURL+"/grep?"+p.Encode(), &data) && data.Error == "" && len(data.Results) > 0 {
					var lines []string
					for _, r := range data.Results {
						lines = append(lines, fmt.Sprintf("%s:%d: %s", r.File, r.Line, r.Match))
					}
					trunc := ""
					if data.Truncated {
						trunc = fmt.Sprintf(" (%d of %d)", len(data.Results), data.TotalMatches)
					}
					deny(fmt.Sprintf(
						"[unreal-index] grep/rg intercepted — indexed results for \"%s\"%s:\n\n%s\n\n"+
							"Results from pre-built index. Use the Grep tool instead of shell grep.",
						pattern, trunc, strings.Join(lines, "\n")))
				}
			}
		}
		// No extractable pattern or no results — still block
		deny(
			"[unreal-index] Shell grep/rg commands are blocked.\n\n" +
				"Use the Grep tool instead (intercepted by unreal-index for fast indexed results).")
	}

	// D. File read commands: cat, head, tail → block, redirect to Read tool
	if catRe.MatchString(trimmed) {
		deny(
			"[unreal-index] File read commands (cat, head, tail) are blocked.\n\n" +
				"Use the Read tool instead for better performance and proper file access. " +
				"Example: Read tool with file_path parameter.")
	}

	// E. Word count: wc → block, redirect to Read tool
	if wcRe.MatchString(trimmed) {
		deny(
			"[unreal-index] wc is blocked.\n\n" +
				"Use the Read tool instead — it displays line numbers (cat -n format), " +
				"so the last line number gives you the total line count.")
	}

	// F. PowerShell commands: Get-ChildItem, Select-String, Get-Content
	if powershellRe.MatchString(trimmed) {
		// Get-ChildItem / gci → file search, proxy to /find-file
		if getChildItemRe.MatchString(trimmed) {
			if m := psFilterRe.FindStringSubmatch(trimmed); m != nil {
				name := strings.NewReplacer("*", "", "?", "").Replace(m[1])
				if idx := strings.LastIndex(name, "."); idx >= 0 {
					name = name[:idx]
				}
				if len(name) >= 3 {
					p := url.Values{}
					p.Set("filename", name)
					p.Set("maxResults", "30")

					var data FindFileResponse
					if fetchJSON(serviceURL+"/find-file?"+p.Encode(), &data) && data.Error == "" && len(data.Results) > 0 {
						var files []string
						for _, r := range data.Results {
							files = append(files, r.File)
						}
						deny(fmt.Sprintf(
							"[unreal-index] PowerShell Get-ChildItem intercepted — indexed results for \"%s\":\n\n%s\n\n"+
								"Results from pre-built index. Use the Glob tool or unreal_find_file MCP tool instead of PowerShell.",
							name, strings.Join(files, "\n")))
					}
				}
			}
			deny(
				"[unreal-index] PowerShell Get-ChildItem/gci is blocked.\n\n" +
					"Use the Glob tool to find files by pattern (intercepted by unreal-index for fast results) " +
					"or the unreal_find_file MCP tool for direct indexed search.")
		}

		// Select-String / sls → grep equivalent, proxy to /grep
		if selectStringRe.MatchString(trimmed) {
			if m := psPatternRe.FindStringSubmatch(trimmed); m != nil && len(m[1]) >= 2 {
				p := url.Values{}
				p.Set("pattern", m[1])
				p.Set("maxResults", "30")
				p.Set("grouped", "false")
				p.Set("symbols", "false")

				var data GrepResponse
				if fetchJSON(serviceURL+"/grep?"+p.Encode(), &data) && data.Error == "" && len(data.Results) > 0 {
					var lines []string
					for _, r := range data.Results {
						lines = append(lines, fmt.Sprintf("%s:%d: %s", r.File, r.Line, r.Match))
					}
					deny(fmt.Sprintf(
						"[unreal-index] PowerShell Select-String intercepted — indexed results for \"%s\":\n\n%s\n\n"+
							"Results from pre-built index. Use the Grep tool or unreal_grep MCP tool instead of PowerShell.",
						m[1], strings.Join(lines, "\n")))
				}
			}
			deny(
				"[unreal-index] PowerShell Select-String/sls is blocked.\n\n" +
					"Use the Grep tool instead (intercepted by unreal-index for fast indexed results) " +
					"or the unreal_grep MCP tool for direct indexed search.")
		}

		// Get-Content / gc / type → block, redirect to Read
		if getContentRe.MatchString(trimmed) {
			deny(
				"[unreal-index] PowerShell Get-Content/gc is blocked.\n\n" +
					"Use the Read tool instead for better performance and proper file access.")
		}
	}

	// G. Everything else → allow
	allow()
}

// ── Main dispatch ────────────────────────────────────────────

func main() {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		allow()
	}

	var input HookInput
	if err := json.Unmarshal(data, &input); err != nil {
		allow()
	}

	switch input.ToolName {
	case "Grep":
		handleGrep(input.ToolInput)
	case "Glob":
		handleGlob(input.ToolInput)
	case "Bash":
		handleBash(input.ToolInput)
	default:
		allow()
	}
}
