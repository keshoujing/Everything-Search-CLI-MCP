# everything-search-cli-mcp

An MCP server that wraps [es.exe](https://www.voidtools.com/es/) (Everything Search CLI) to give Claude near-instant indexed file search on Windows. Communicates with the [Everything](https://www.voidtools.com/) desktop app over IPC.

> es.exe © voidtools, MIT License

---

## Prerequisites

- Windows (x64, x86, or ARM64)
- [Everything](https://www.voidtools.com/) desktop app installed and running

---

## 🤖 AI Assistant Quick Install

> Copy the text block below and paste it to your AI assistant (Claude Code, Codex, Cursor, etc.) — it will install and register this MCP automatically.

```
You are an AI assistant. The user wants you to install the everything-search-cli-mcp MCP server.

First, ask the user: "Which AI tool are you using in list format, then install and change necessary file for user (e.g. Claude Code, Codex CLI, Cursor, VS Code, Claude Desktop)"

Then follow the steps below based on their answer:

--- If Claude Code, Codex CLI, or Cursor (has terminal access) ---

1. Install globally:
   npm install -g everything-search-cli-mcp

2. Register:
   - Claude Code:  claude mcp add everything-search -- everything-search-cli-mcp
   - Codex CLI:    codex mcp add everything-search -- everything-search-cli-mcp
   - Cursor:       add the JSON below to .cursor/mcp.json in the project root
   - VS Code:      add the JSON below to .vscode/mcp.json in the project root

   JSON format:
   {
     "mcpServers": {
       "everything-search": {
         "command": "everything-search-cli-mcp"
       }
     }
   }

3. Tell the user installation is complete and ask them to restart their AI tool.

--- If Claude Desktop ---

Claude Desktop does not support automatic installation. Tell the user to follow these manual steps:

1. Run in terminal:  npm install -g everything-search-cli-mcp
2. Open: %APPDATA%\Claude\claude_desktop_config.json
3. Add the following inside "mcpServers":
   "everything-search": {
     "command": "everything-search-cli-mcp"
   }
4. Restart Claude Desktop.

Note: This MCP is Windows-only and requires the Everything desktop app to be installed and running (https://www.voidtools.com/).
```

---

## Setup

**1. Install:**

```bash
npm install -g everything-search-cli-mcp
```

**2. Register in your AI tool's config:**

```json
{
  "mcpServers": {
    "everything-search": {
      "command": "everything-search-cli-mcp"
    }
  }
}
```

### es.exe binaries

`es.exe` is pre-bundled for all architectures — no separate download needed. To use a newer version, download the latest from [voidtools](https://www.voidtools.com/es/) and replace the corresponding file in `bin/`:

| File | Architecture |
|------|-------------|
| `bin/es-x64.exe` | x64 (most PCs) |
| `bin/es-x86.exe` | 32-bit |
| `bin/es-arm64.exe` | ARM64 |

---

## Tools

### `search`

Search for files and folders using Everything's indexed search engine.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Everything query syntax, e.g. `*.py`, `ext:pdf`, `size:>1mb` |
| `in_path` | string | — | Limit results to this folder path (recursive) |
| `parent` | string | — | Limit to direct children of this folder only (non-recursive) |
| `parent_path` | string | — | Search within the parent folder of a given path |
| `date_modified` | string | — | Filter by modification date (see date formats below) |
| `date_created` | string | — | Filter by creation date |
| `date_accessed` | string | — | Filter by last accessed date |
| `type` | `file\|folder\|both` | `both` | Filter by entry type |
| `sort_by` | `name\|path\|size\|modified\|created\|accessed` | `name` | Sort field |
| `ascending` | boolean | `true` | Sort direction |
| `limit` | number (1–1000) | `100` | Maximum results |
| `count_only` | boolean | `false` | Return only the total result count; ignores `limit`, `sort_by`, and `show_*` |
| `show_size` | boolean | `false` | Include file size in bytes |
| `show_date_modified` | boolean | `false` | Include date modified |
| `show_date_created` | boolean | `false` | Include date created |
| `show_date_accessed` | boolean | `false` | Include date last accessed |
| `case_sensitive` | boolean | `false` | Case-sensitive matching |
| `whole_word` | boolean | `false` | Match whole words only |
| `regex` | boolean | `false` | Treat query as regex |
| `match_path` | boolean | `false` | Match full path, not just filename |
| `instance` | string | — | Everything instance name (e.g. `1.5a`) |
| `extra_flags` | string | — | Raw es.exe flags to append |

**Date filter formats** (applies to `date_modified`, `date_created`, `date_accessed`):

| Format | Example |
|--------|---------|
| ISO date | `2026-04-09` |
| ISO range | `2026-04-01..2026-04-09` |
| Keyword | `today`, `yesterday`, `thisweek`, `thismonth`, `thisyear` |

**Returns:** JSON array of result objects:
```json
[
  {
    "path": "C:\\Users\\Alice\\Documents\\report.pdf",
    "size": 204800,
    "date_modified": "2024-03-15 14:22:01"
  }
]
```

### `get_info`

Returns version information and confirms which binary is in use.

```json
{
  "es_version": "es 1.1.0.27a",
  "everything_version": "1.4.1.1024",
  "es_path": "C:\\path\\to\\everything-mcp\\bin\\es-x64.exe"
}
```

---

## Everything Query Syntax

| Query | Finds |
|-------|-------|
| `*.py` | All Python files |
| `ext:pdf` | All PDF files |
| `size:>10mb` | Files larger than 10 MB |
| `dm:today` | Files modified today |
| `path:C:\Projects *.ts` | TypeScript files under C:\Projects |
| `"my document"` | Files containing the exact phrase |

Full syntax reference: https://www.voidtools.com/support/everything/searching/

---

## License

MIT
