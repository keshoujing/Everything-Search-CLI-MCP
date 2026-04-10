#!/usr/bin/env node
// everything-mcp — MCP server wrapping es.exe (Everything Search CLI)
// es.exe © voidtools, MIT License — https://www.voidtools.com/es/

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { arch, homedir } from "node:os";
import { join, dirname, win32 as pathWin32 } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, appendFileSync } from "node:fs";
import { parse as csvParseSync } from "csv-parse/sync";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
type LogLevel = typeof LOG_LEVELS[number];

interface ResolvedConfig {
  log: {
    level: LogLevel;
    format: "json" | "text";
    destination: "stderr" | "file";
    filePath: string | null;
  };
  execution: {
    timeoutMs: number;
    maxBufferBytes: number;
    maxConcurrent: number;
  };
  validation: {
    queryMaxLength: number;
    allowedPathPrefixes: string[];
    blockedPathPatterns: string[];
    extraFlagsBlocklist: string[];
  };
  health: {
    checkOnStartup: boolean;
    startupTimeoutMs: number;
  };
}

const UserConfigSchema = z.object({
  log: z.object({
    level:       z.enum(LOG_LEVELS).optional(),
    format:      z.enum(["json", "text"] as const).optional(),
    destination: z.enum(["stderr", "file"] as const).optional(),
    filePath:    z.string().nullable().optional(),
  }).optional(),
  execution: z.object({
    timeoutMs:      z.number().int().min(1000).max(300_000).optional(),
    maxBufferBytes: z.number().int().min(1024).max(500 * 1024 * 1024).optional(),
    maxConcurrent:  z.number().int().min(1).max(100).optional(),
  }).optional(),
  validation: z.object({
    queryMaxLength:      z.number().int().min(1).max(10_000).optional(),
    allowedPathPrefixes: z.array(z.string()).optional(),
    blockedPathPatterns: z.array(z.string()).optional(),
    extraFlagsBlocklist: z.array(z.string()).optional(),
  }).optional(),
  health: z.object({
    checkOnStartup:   z.boolean().optional(),
    startupTimeoutMs: z.number().int().min(100).max(60_000).optional(),
  }).optional(),
});

type UserConfig = z.infer<typeof UserConfigSchema>;

const DEFAULTS: ResolvedConfig = {
  log:       { level: "info", format: "text", destination: "stderr", filePath: null },
  execution: { timeoutMs: 30_000, maxBufferBytes: 50 * 1024 * 1024, maxConcurrent: 5 },
  validation: { queryMaxLength: 2048, allowedPathPrefixes: [], blockedPathPatterns: [], extraFlagsBlocklist: [] },
  health:    { checkOnStartup: true, startupTimeoutMs: 10_000 },
};

function mergeConfig(base: ResolvedConfig, patch: UserConfig): ResolvedConfig {
  return {
    log: {
      level:       patch.log?.level       ?? base.log.level,
      format:      patch.log?.format      ?? base.log.format,
      destination: patch.log?.destination ?? base.log.destination,
      filePath:    patch.log?.filePath    ?? base.log.filePath,
    },
    execution: {
      timeoutMs:      patch.execution?.timeoutMs      ?? base.execution.timeoutMs,
      maxBufferBytes: patch.execution?.maxBufferBytes ?? base.execution.maxBufferBytes,
      maxConcurrent:  patch.execution?.maxConcurrent  ?? base.execution.maxConcurrent,
    },
    validation: {
      queryMaxLength:      patch.validation?.queryMaxLength      ?? base.validation.queryMaxLength,
      allowedPathPrefixes: patch.validation?.allowedPathPrefixes ?? base.validation.allowedPathPrefixes,
      blockedPathPatterns: patch.validation?.blockedPathPatterns ?? base.validation.blockedPathPatterns,
      extraFlagsBlocklist: patch.validation?.extraFlagsBlocklist ?? base.validation.extraFlagsBlocklist,
    },
    health: {
      checkOnStartup:   patch.health?.checkOnStartup   ?? base.health.checkOnStartup,
      startupTimeoutMs: patch.health?.startupTimeoutMs ?? base.health.startupTimeoutMs,
    },
  };
}

function tryLoadConfigFile(filePath: string): UserConfig | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const result = UserConfigSchema.safeParse(JSON.parse(raw));
    if (result.success) return result.data;
    process.stderr.write(
      `[everything-mcp] WARNING: Config "${filePath}" failed validation, using defaults:\n${result.error.message}\n`
    );
    return null;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(
        `[everything-mcp] WARNING: Cannot read config "${filePath}": ${e instanceof Error ? e.message : String(e)}\n`
      );
    }
    return null;
  }
}

function loadConfig(): ResolvedConfig {
  const projectLocal = join(__dirname, "..", "everything-mcp.config.json");
  const userHome     = join(process.env["APPDATA"] ?? homedir(), "everything-mcp", "config.json");
  let resolved = DEFAULTS;
  const local = tryLoadConfigFile(projectLocal);
  if (local) resolved = mergeConfig(resolved, local);
  const home  = tryLoadConfigFile(userHome);
  if (home)  resolved = mergeConfig(resolved, home);
  return resolved;
}

// Module-level singletons
const cfg = loadConfig();

// ─── Logger ───────────────────────────────────────────────────────────────────

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, silent: 4,
};

class Logger {
  private readonly minLevel: number;
  private readonly format: "json" | "text";
  private readonly dest: "stderr" | "file";
  private readonly filePath: string | null;

  constructor(lcfg: ResolvedConfig["log"]) {
    this.minLevel = LOG_LEVEL_ORDER[lcfg.level];
    this.format   = lcfg.format;
    this.dest     = lcfg.destination;
    this.filePath = lcfg.filePath;
  }

  private emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LOG_LEVEL_ORDER[level] < this.minLevel) return;
    const ts = new Date().toISOString();
    let line: string;
    if (this.format === "json") {
      line = JSON.stringify({ ts, level, msg, ...extra }) + "\n";
    } else {
      const ext = extra
        ? " " + Object.entries(extra).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")
        : "";
      line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}${ext}\n`;
    }
    if (this.dest === "file" && this.filePath) {
      try { appendFileSync(this.filePath, line, "utf8"); } catch { process.stderr.write(line); }
    } else {
      process.stderr.write(line);
    }
  }

  debug(msg: string, extra?: Record<string, unknown>): void { this.emit("debug", msg, extra); }
  info (msg: string, extra?: Record<string, unknown>): void { this.emit("info",  msg, extra); }
  warn (msg: string, extra?: Record<string, unknown>): void { this.emit("warn",  msg, extra); }
  error(msg: string, extra?: Record<string, unknown>): void { this.emit("error", msg, extra); }
}

const log = new Logger(cfg.log);

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  path: string;
  size?: number;
  date_modified?: string;
  date_created?: string;
  date_accessed?: string;
}

interface EsError extends Error {
  code: number | string;
  stderr?: string;
  killed?: boolean;
}

const SORT_FIELD_MAP: Record<string, string> = {
  name:     "name",
  path:     "path",
  size:     "size",
  modified: "date-modified",
  created:  "date-created",
  accessed: "date-accessed",
};

// ─── Error Classification ─────────────────────────────────────────────────────

type EsErrorCategory =
  | "es_internal"
  | "export_failed"
  | "unknown_flag"
  | "not_connected"
  | "timeout"
  | "validation"
  | "system"
  | "unknown";

class ClassifiedError extends Error {
  readonly category: EsErrorCategory;
  readonly exitCode?: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    category: EsErrorCategory,
    options?: { exitCode?: number; retryable?: boolean; details?: Record<string, unknown> }
  ) {
    super(message);
    this.name      = "ClassifiedError";
    this.category  = category;
    this.exitCode  = options?.exitCode;
    this.retryable = options?.retryable ?? false;
    this.details   = options?.details;
  }
}

function classifyExitCode(code: number, stderr: string): ClassifiedError {
  switch (code) {
    case 1: case 2: case 3:
      return new ClassifiedError(`es.exe internal error: ${code}`, "es_internal", { exitCode: code });
    case 5:
      return new ClassifiedError("Failed to create export file.", "export_failed", { exitCode: code });
    case 6:
      return new ClassifiedError(
        "Unknown flag passed to es.exe. This is a bug, please report it.",
        "unknown_flag", { exitCode: code }
      );
    case 8:
      return new ClassifiedError(
        "Everything is not running. Please start Everything desktop app first.",
        "not_connected", { exitCode: code, retryable: false }
      );
    default:
      return new ClassifiedError(
        `es.exe exited with code ${code}: ${stderr}`, "unknown", { exitCode: code }
      );
  }
}

function formatToolError(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  if (err instanceof ClassifiedError) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error:    err.category,
          message:  err.message,
          retryable: err.retryable,
          ...(err.exitCode !== undefined ? { exit_code: err.exitCode } : {}),
          ...err.details,
        }),
      }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: String(err instanceof Error ? err.message : err) }],
    isError: true,
  };
}

// ─── Semaphore ────────────────────────────────────────────────────────────────

class Semaphore {
  private available: number;
  private readonly max: number;
  private readonly queue: Array<() => void>;

  constructor(max: number) {
    this.max       = max;
    this.available = max;
    this.queue     = [];
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    if (this.queue.length >= this.max) {
      log.warn("Concurrency limit exceeded, request rejected", {
        max: this.max,
        queued: this.queue.length,
      });
      return Promise.reject(
        new ClassifiedError(
          "Too many concurrent searches — please retry shortly.",
          "system",
          { retryable: true }
        )
      );
    }
    return new Promise<void>(resolve => { this.queue.push(resolve); });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }
}

const sem = new Semaphore(cfg.execution.maxConcurrent);

// ─── Binary resolution ────────────────────────────────────────────────────────

function resolveEsBinary(): string {
  const a = arch();
  const name =
    a === "x64"   ? "es-x64.exe"   :
    a === "ia32"  ? "es-x86.exe"   :
    a === "arm64" ? "es-arm64.exe" :
    null;

  if (name === null) {
    throw new Error(`Unsupported architecture: ${a}. Only x64, ia32, arm64 are supported.`);
  }

  // dist/index.js → ../bin/<name>
  return join(__dirname, "..", "bin", name);
}

const ES_PATH = resolveEsBinary();

// ─── Core runner ─────────────────────────────────────────────────────────────

async function runEs(args: string[], timeoutMs?: number): Promise<string> {
  const timeout = timeoutMs ?? cfg.execution.timeoutMs;
  // acquire() may throw ClassifiedError if queue is full — propagates before try/finally
  await sem.acquire();
  const t0 = Date.now();
  log.debug("runEs start", { arg_count: args.length });
  try {
    const result = await execFileAsync(ES_PATH, args, {
      timeout,
      maxBuffer: cfg.execution.maxBufferBytes,
      windowsHide: true,
      encoding: "utf8",
    });
    log.debug("runEs complete", { duration_ms: Date.now() - t0 });
    return result.stdout;
  } catch (err: unknown) {
    const e = err as EsError;

    if (e.killed === true) {
      log.warn("runEs timed out", { duration_ms: Date.now() - t0, timeout_ms: timeout });
      throw new ClassifiedError(`es.exe timed out after ${timeout}ms`, "timeout", { retryable: true });
    }

    if (typeof e.code === "number") {
      // Code 9 = no results (triggered by -no-result-error flag) — return stdout
      // so parseCsvOutput yields [] instead of throwing.
      if (e.code === 9) return (e as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "";
      const classified = classifyExitCode(e.code, e.stderr ?? "");
      log.error("runEs failed", { category: classified.category, exit_code: e.code });
      throw classified;
    }

    log.error("runEs system error", { message: e.message });
    throw new ClassifiedError(`System error: ${e.message}`, "system", { retryable: false });
  } finally {
    sem.release();
  }
}

// ─── extra_flags splitter ─────────────────────────────────────────────────────

function splitFlags(raw: string): string[] {
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map(t =>
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
      ? t.slice(1, -1)
      : t
  );
}

// ─── Date normalizer ─────────────────────────────────────────────────────────

function normalizeDateQuery(query: string): string {
  // Normalize dm:/dc:/da: YYYY/MM/DD or YYYY-MM-DD to strict ISO YYYY-MM-DD
  return query.replace(
    /\b(dm|dc|da|datemodified|datecreated|dateaccessed):(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/gi,
    (_, prefix, year, month, day) =>
      `${prefix}:${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
  );
}

// ─── Input Safety Validation ──────────────────────────────────────────────────

// Flags that modify the Everything daemon, its database, or its process lifecycle.
// Matched case-insensitively against normalized tokens (leading dashes stripped).
const BUILTIN_FLAG_BLOCKLIST = new Set([
  // Process lifecycle
  "exit", "quit", "close-everything", "restart", "service-restart",
  // Service management
  "install-service", "uninstall-service",
  // Data mutation
  "reindex", "save-db", "delete-db", "empty-recycle-bin",
  // Config/history mutation
  "save-settings", "load-settings", "save-run-history", "clear-run-history",
]);

function normalizeFlag(token: string): string {
  return token.toLowerCase().replace(/^-+/, "");
}

function validatePath(field: string, rawPath: string): void {
  const normalized = pathWin32.normalize(rawPath);

  // UNC (\\server\share) and Win32 device paths (\\.\pipe) are never valid search paths
  if (normalized.startsWith("\\\\")) {
    throw new ClassifiedError(
      "UNC paths and device paths are not allowed",
      "validation",
      { details: { field, value_preview: rawPath.slice(0, 100) } }
    );
  }

  // Allowed-prefix whitelist (empty = no restriction)
  if (cfg.validation.allowedPathPrefixes.length > 0) {
    const lower = normalized.toLowerCase();
    const ok = cfg.validation.allowedPathPrefixes.some(
      p => lower.startsWith(pathWin32.normalize(p).toLowerCase())
    );
    if (!ok) {
      throw new ClassifiedError(
        "Path not in allowed directories",
        "validation",
        { details: { field, value_preview: rawPath.slice(0, 100) } }
      );
    }
  }

  // Blocked patterns
  for (const pattern of cfg.validation.blockedPathPatterns) {
    let matched = false;
    try {
      matched = new RegExp(pattern, "i").test(normalized);
    } catch {
      log.warn("Invalid regex in validation.blockedPathPatterns, skipping", { pattern });
      continue;
    }
    if (matched) {
      throw new ClassifiedError(
        "Path matches a blocked pattern",
        "validation",
        { details: { field, value_preview: rawPath.slice(0, 100) } }
      );
    }
  }
}

function validateSearchParams(p: SearchParams): void {
  // Query length and null-byte check
  if (p.query.length > cfg.validation.queryMaxLength) {
    throw new ClassifiedError(
      `Query exceeds maximum length of ${cfg.validation.queryMaxLength} characters`,
      "validation",
      { details: { field: "query", value_preview: p.query.slice(0, 100) } }
    );
  }
  if (p.query.includes("\0")) {
    throw new ClassifiedError(
      "Query contains null byte",
      "validation",
      { details: { field: "query", value_preview: "" } }
    );
  }

  // Path fields
  if (p.in_path)     validatePath("in_path",     p.in_path);
  if (p.parent)      validatePath("parent",      p.parent);
  if (p.parent_path) validatePath("parent_path", p.parent_path);

  // extra_flags — check each token against built-in and user-defined blocklists
  if (p.extra_flags) {
    const userBlocklist = new Set(cfg.validation.extraFlagsBlocklist.map(normalizeFlag));
    for (const token of splitFlags(p.extra_flags)) {
      const norm = normalizeFlag(token);
      if (BUILTIN_FLAG_BLOCKLIST.has(norm) || userBlocklist.has(norm)) {
        log.warn("Blocked flag in extra_flags rejected", { flag: token });
        throw new ClassifiedError(
          `Flag "${token}" is not allowed`,
          "validation",
          { details: { field: "extra_flags", value_preview: token.slice(0, 100) } }
        );
      }
    }
  }
}

// ─── Arg builder ─────────────────────────────────────────────────────────────

interface SearchParams {
  query: string;
  in_path?: string;
  parent?: string;
  parent_path?: string;
  date_modified?: string;
  date_created?: string;
  date_accessed?: string;
  type?: "file" | "folder" | "both";
  sort_by?: "name" | "path" | "size" | "modified" | "created" | "accessed";
  ascending?: boolean;
  limit?: number;
  count_only?: boolean;
  show_size?: boolean;
  show_date_modified?: boolean;
  show_date_created?: boolean;
  show_date_accessed?: boolean;
  case_sensitive?: boolean;
  whole_word?: boolean;
  regex?: boolean;
  match_path?: boolean;
  instance?: string;
  extra_flags?: string;
}

function buildSearchArgs(p: SearchParams): string[] {
  const args: string[] = [];

  // count_only uses a completely different output mode — no CSV, just a number
  if (p.count_only) {
    args.push("-get-result-count");
    args.push("-no-result-error");
  } else {
    // Always-present structured output flags
    args.push("-csv");
    args.push("-date-format", "1");
    args.push("-no-result-error");
  }

  // Query modifier flags
  if (p.case_sensitive) args.push("-i");
  if (p.whole_word)     args.push("-w");
  if (p.regex)          args.push("-r");
  if (p.match_path)     args.push("-p");

  // Type filter — /a-d and /ad conflict with dm:/dc:/da: date filters in es.exe;
  // skip the attribute flag when date filters are present (results stay correct
  // because date filters never match bare directories in practice).
  const hasDateFilter = !!(p.date_modified || p.date_created || p.date_accessed);
  if (!hasDateFilter) {
    if (p.type === "file")        args.push("/a-d");
    else if (p.type === "folder") args.push("/ad");
    // "both" → omit
  }

  // Path filters
  if (p.in_path)     args.push("-path",       p.in_path);
  if (p.parent)      args.push("-parent",      p.parent);
  if (p.parent_path) args.push("-parent-path", p.parent_path);

  // Sort (ignored for count_only but harmless)
  if (!p.count_only) {
    const sortField = SORT_FIELD_MAP[p.sort_by ?? "name"];
    args.push("-sort", sortField);
    args.push((p.ascending ?? true) ? "-sort-ascending" : "-sort-descending");

    // Result limit
    args.push("-n", String(p.limit ?? 100));

    // Optional column flags
    if (p.show_size)          args.push("-size");
    if (p.show_date_modified) args.push("-dm");
    if (p.show_date_created)  args.push("-dc");
    if (p.show_date_accessed) args.push("-da");
  }

  // Instance
  if (p.instance) args.push("-instance", p.instance);

  // Raw extra flags — appended last before the query
  if (p.extra_flags) args.push(...splitFlags(p.extra_flags));

  // Date filters + query normalization
  let effectiveQuery = p.query;
  if (p.date_modified) effectiveQuery = `dm:${p.date_modified} ${effectiveQuery}`.trim();
  if (p.date_created)  effectiveQuery = `dc:${p.date_created} ${effectiveQuery}`.trim();
  if (p.date_accessed) effectiveQuery = `da:${p.date_accessed} ${effectiveQuery}`.trim();
  effectiveQuery = normalizeDateQuery(effectiveQuery);
  args.push(effectiveQuery);

  return args;
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCsvOutput(csv: string): SearchResult[] {
  if (!csv.trim()) return [];

  const records = csvParseSync(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  return records.map(row => {
    const result: SearchResult = { path: row["Filename"] ?? "" };

    if ("Size" in row && row["Size"] !== "")
      result.size          = parseInt(row["Size"], 10);
    if ("Date Modified" in row && row["Date Modified"] !== "")
      result.date_modified = row["Date Modified"];
    if ("Date Created" in row && row["Date Created"] !== "")
      result.date_created  = row["Date Created"];
    if ("Date Accessed" in row && row["Date Accessed"] !== "")
      result.date_accessed = row["Date Accessed"];

    return result;
  });
}

// ─── Health Check ─────────────────────────────────────────────────────────────

type HealthStatus = "ok" | "degraded" | "unknown";
let healthStatus: HealthStatus = "unknown";

async function performHealthCheck(): Promise<void> {
  if (!cfg.health.checkOnStartup) return;
  try {
    const out = await runEs(["-version"], cfg.health.startupTimeoutMs);
    healthStatus = "ok";
    log.info("Health check passed", { es_version: out.trim() });
  } catch (err) {
    healthStatus = "degraded";
    log.error("Health check failed — Everything may not be running", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "everything-mcp",
  version: "1.0.0",
});

// Tool: search
server.tool(
  "search",
  "Search for files and folders using Everything's indexed search engine. " +
  "Supports Everything query syntax (e.g. \"*.py\", \"ext:pdf\", \"size:>1mb\"). " +
  "Returns an array of matching paths with optional metadata. " +
  "If search results appear outdated or incomplete, DO NOT attempt to trigger a reindex programmatically. " +
  "Instead, tell the user to run the following command in their terminal: es.exe -reindex",
  {
    query: z.string().describe(
      "Search query. Supports Everything syntax, e.g. \"*.py\", \"ext:pdf\", \"size:>1mb\""
    ),
    date_modified: z.string().optional().describe(
      "Filter by modification date. ISO date (2026-04-09), range (2026-04-01..2026-04-09), or keywords: today, yesterday, thisweek, thismonth, thisyear"
    ),
    date_created: z.string().optional().describe(
      "Filter by creation date. Same format as date_modified."
    ),
    date_accessed: z.string().optional().describe(
      "Filter by last accessed date. Same format as date_modified."
    ),
    in_path: z.string().optional().describe(
      "Limit results to this folder path (recursive)"
    ),
    parent: z.string().optional().describe(
      "Limit results to direct children of this folder only (non-recursive). " +
      "E.g. parent: \"C:\\\\Users\" returns files/folders directly inside C:\\Users but not deeper."
    ),
    parent_path: z.string().optional().describe(
      "Search for the parent of the given path. " +
      "E.g. parent_path: \"C:\\\\Users\\\\Alice\\\\file.txt\" returns items in C:\\Users\\Alice."
    ),
    type: z.enum(["file", "folder", "both"]).optional().default("both").describe(
      "Filter by entry type. Default: both"
    ),
    sort_by: z.enum(["name", "path", "size", "modified", "created", "accessed"])
      .optional().default("name").describe("Sort field. Default: name"),
    ascending: z.boolean().optional().default(true).describe(
      "Sort direction. Default: true (ascending)"
    ),
    limit: z.number().int().min(1).max(1000).optional().default(100).describe(
      "Maximum number of results, 1–1000. Default: 100"
    ),
    count_only: z.boolean().optional().default(false).describe(
      "Return only the total result count, not the file list. " +
      "Useful for quickly checking how many results a query yields. Ignores limit, sort, and show_* flags."
    ),
    show_size: z.boolean().optional().default(false).describe(
      "Include file size (bytes) in results"
    ),
    show_date_modified: z.boolean().optional().default(false).describe(
      "Include date modified in results"
    ),
    show_date_created: z.boolean().optional().default(false).describe(
      "Include date created in results"
    ),
    show_date_accessed: z.boolean().optional().default(false).describe(
      "Include date last accessed in results"
    ),
    case_sensitive: z.boolean().optional().default(false).describe(
      "Case-sensitive matching"
    ),
    whole_word: z.boolean().optional().default(false).describe(
      "Match whole words only"
    ),
    regex: z.boolean().optional().default(false).describe(
      "Treat query as a regular expression"
    ),
    match_path: z.boolean().optional().default(false).describe(
      "Match against full path instead of filename only"
    ),
    instance: z.string().optional().describe(
      "Everything instance name (e.g. \"1.5a\" for Everything 1.5 Alpha users)"
    ),
    extra_flags: z.string().optional().describe(
      "Raw es.exe flags to append, for advanced users"
    ),
  },
  async (params) => {
    try {
      const p = params as SearchParams;

      // Fast path when health check determined Everything is unreachable
      if (healthStatus === "degraded") {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error:    "not_connected",
            message:  "Everything is not running or unreachable. Please start the Everything desktop app.",
            retryable: false,
          }) }],
          isError: true,
        };
      }

      // Input safety validation (throws ClassifiedError on rejection)
      validateSearchParams(p);

      const args = buildSearchArgs(p);

      if (p.count_only) {
        const raw = await runEs(args);
        const count = parseInt(raw.trim(), 10);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ count: isNaN(count) ? 0 : count }),
          }],
        };
      }

      const csv = await runEs(args);
      const results = parseCsvOutput(csv);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(results, null, 2),
        }],
      };
    } catch (err) {
      return formatToolError(err);
    }
  }
);

// Tool: get_info
server.tool(
  "get_info",
  "Get version information about es.exe and the Everything search engine, " +
  "and confirm which binary is being used. " +
  "Also returns manual management commands that ONLY the user may run in their terminal. " +
  "DO NOT invoke these commands programmatically under any circumstances.",
  {},
  async () => {
    try {
      const [esOut, evOut] = await Promise.all([
        runEs(["-version"]),
        runEs(["-get-everything-version"]),
      ]);
      const info = {
        es_version:         esOut.trim(),
        everything_version: evOut.trim(),
        es_path:            ES_PATH,
        management_commands: {
          _notice:
            "These commands must be run by the USER in a terminal. " +
            "DO NOT call them programmatically or via any tool.",
          reindex:
            "es.exe -reindex   — force Everything to rebuild the file index from scratch. " +
            "Disruptive: Everything will be unresponsive for several minutes during the scan.",
          save_db:
            "es.exe -save-db   — flush the in-memory Everything database to disk immediately.",
        },
      };
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    } catch (err) {
      return formatToolError(err);
    }
  }
);

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("everything-mcp server started", { es_path: ES_PATH });
  // Non-blocking: health check runs after server is already accepting connections
  performHealthCheck().catch(err => {
    log.error("Unexpected error during health check", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
}

main().catch(err => {
  process.stderr.write(
    `[everything-mcp] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
