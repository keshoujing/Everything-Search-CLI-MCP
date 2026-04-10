# everything-search-cli-mcp

An MCP server that wraps [es.exe](https://www.voidtools.com/es/) (Everything Search CLI) to give Claude near-instant indexed file search on Windows. Communicates with the [Everything](https://www.voidtools.com/) desktop app over IPC.

> es.exe © voidtools, MIT License

---

## Prerequisites

- Windows (x64, x86, or ARM64)
- [Everything](https://www.voidtools.com/) desktop app installed and running

---

## Setup

### 1. es.exe binaries

`es.exe` binaries for all architectures are pre-bundled in the `bin/` directory — no download needed for most users.

| File | Architecture |
|------|-------------|
| `bin/es-x64.exe` | x64 (most PCs) |
| `bin/es-x86.exe` | 32-bit |
| `bin/es-arm64.exe` | ARM64 |

Only the binary matching your system's architecture is used at runtime. To use a newer version, download the latest `es.exe` from [voidtools](https://www.voidtools.com/es/) and replace the corresponding file in `bin/`.

### 2. Build

```bash
npm install
npm run build
```

### 3. Configure Claude Desktop

Install globally via npm:

```bash
npm install -g everything-search-cli-mcp
```

Then add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "everything": {
      "command": "everything-search-cli-mcp"
    }
  }
}
```

Or if running from source:

```json
{
  "mcpServers": {
    "everything": {
      "command": "node",
      "args": ["C:/path/to/everything-search-cli-mcp/dist/index.js"]
    }
  }
}
```

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
