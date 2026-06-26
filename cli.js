import dotenv from 'dotenv';
import readline from 'readline';
import { exec, execFile } from 'child_process';
import { readFile, writeFile as fsWriteFile, readdir, stat, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join, relative, dirname, basename } from 'path';
import { webSearch, fetchUrl } from './tools.js';

dotenv.config();

// ── Config ───────────────────────────────────────────────────────────────────
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY || '';
const CEREBRAS_MODEL   = process.env.CEREBRAS_MODEL   || 'llama-3.3-70b';
const CEREBRAS_URL     = 'https://api.cerebras.ai/v1/chat/completions';
const GROQ_API_KEY     = process.env.GROQ_API_KEY || '';
const GROQ_URL         = 'https://api.groq.com/openai/v1/chat/completions';
const OLLAMA_URL       = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL     = process.env.OLLAMA_MODEL || 'llama3.2:3b';

const OPENAI_BACKENDS = [
  CEREBRAS_API_KEY && { name: 'Cerebras', label: `Cerebras/${CEREBRAS_MODEL}`, url: CEREBRAS_URL, key: CEREBRAS_API_KEY, model: CEREBRAS_MODEL },
  GROQ_API_KEY     && { name: 'Groq',     label: `Groq/llama-4-scout`,         url: GROQ_URL,     key: GROQ_API_KEY,     model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
  GROQ_API_KEY     && { name: 'Groq-8b',  label: `Groq/llama-3.1-8b`,         url: GROQ_URL,     key: GROQ_API_KEY,     model: 'llama-3.1-8b-instant' },
].filter(Boolean);
const USE_OLLAMA_ONLY = OPENAI_BACKENDS.length === 0;

// ── State ────────────────────────────────────────────────────────────────────
let workdir        = process.env.ASSISTANT_WORKDIR || process.env.HOME || process.cwd();
const messages     = [];
let pendingApproval = null;
let busy           = false;
const queue        = [];

// ── ANSI ─────────────────────────────────────────────────────────────────────
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const ITALIC = '\x1b[3m';
const USER_BG = '\x1b[48;2;30;32;40m\x1b[38;2;200;210;230m';
const GREEN  = '\x1b[38;2;80;200;120m';
const RED    = '\x1b[38;2;220;80;80m';
const ORANGE = '\x1b[38;2;230;140;60m';
const BLUE   = '\x1b[38;2;100;160;240m';
const GRAY   = '\x1b[38;2;130;140;160m';
const WHITE  = '\x1b[38;2;220;225;240m';
const YELLOW = '\x1b[38;2;220;190;80m';
const RESET  = '\x1b[0m';
const BULLET = `${GREEN}●${RESET}`;
const TREE   = `${GRAY}└${RESET}`;
const BRANCH = `${GRAY}├${RESET}`;
const APPROVAL_PROMPT = `${BOLD}Allow? [y/N]${RESET} `;

function getPrompt() {
  const home    = process.env.HOME || '';
  const display = workdir.startsWith(home) ? '~' + workdir.slice(home.length) : workdir;
  return `${GRAY}${display}${RESET} ${GREEN}>${RESET} `;
}

// ── Tools ─────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function', function: {
      name: 'read_file',
      description: 'Read a file\'s contents. Always call this before editing a file. Supports offset and limit for large files.',
      parameters: { type: 'object', properties: {
        path:   { type: 'string', description: 'File path (relative to working dir or absolute)' },
        offset: { type: 'number', description: 'Start line, 1-indexed (optional)' },
        limit:  { type: 'number', description: 'Max lines to read (optional)' },
      }, required: ['path'] },
    },
  },
  {
    type: 'function', function: {
      name: 'write_file',
      description: 'Write or overwrite a file. Use for new files or complete rewrites. Prefer edit_file for partial changes.',
      parameters: { type: 'object', properties: {
        path:    { type: 'string' },
        content: { type: 'string' },
      }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function', function: {
      name: 'edit_file',
      description: 'Replace an exact string in a file. old_string must match exactly (whitespace, indentation). Read the file first to get exact content. old_string must be unique in the file.',
      parameters: { type: 'object', properties: {
        path:       { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to find and replace (must be unique in file)' },
        new_string: { type: 'string', description: 'Replacement text' },
      }, required: ['path', 'old_string', 'new_string'] },
    },
  },
  {
    type: 'function', function: {
      name: 'list_dir',
      description: 'List files and directories (tree view, 2 levels deep). Use to explore project structure.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'Directory path (default: working dir)' },
      }, required: [] },
    },
  },
  {
    type: 'function', function: {
      name: 'search_code',
      description: 'Search for text or regex patterns in files. Use to find definitions, usages, imports, or any text.',
      parameters: { type: 'object', properties: {
        pattern:   { type: 'string', description: 'Text or regex to search for' },
        path:      { type: 'string', description: 'Directory or file to search (default: working dir)' },
        file_glob: { type: 'string', description: 'File pattern e.g. "*.js" "*.py" (optional)' },
      }, required: ['pattern'] },
    },
  },
  {
    type: 'function', function: {
      name: 'web_search',
      description: 'Search the web for current info, documentation, APIs, news, prices. Use proactively for anything you\'re not certain about.',
      parameters: { type: 'object', properties: {
        query: { type: 'string' },
      }, required: ['query'] },
    },
  },
  {
    type: 'function', function: {
      name: 'fetch_url',
      description: 'Fetch the full text of a web page. Use after web_search to read a specific result.',
      parameters: { type: 'object', properties: {
        url: { type: 'string' },
      }, required: ['url'] },
    },
  },
  {
    type: 'function', function: {
      name: 'run_command',
      description: 'Run a shell command (requires user approval). Use for: running tests, building code, git operations, installing packages, etc.',
      parameters: { type: 'object', properties: {
        command:     { type: 'string' },
        description: { type: 'string', description: 'Plain-English explanation of what it does and why' },
      }, required: ['command', 'description'] },
    },
  },
];

// ── Dynamic system prompt ─────────────────────────────────────────────────────
function buildSystem() {
  const home    = process.env.HOME || '';
  const dispDir = workdir.startsWith(home) ? '~' + workdir.slice(home.length) : workdir;
  return `You are an expert software engineer and personal assistant running in the terminal.
Working directory: ${dispDir}  |  Today: ${new Date().toDateString()}

## Tools available
- read_file(path, offset?, limit?)       — read any file; ALWAYS call before editing
- write_file(path, content)              — create or fully overwrite a file
- edit_file(path, old_string, new_string)— precise replacement; safer than write_file for edits
- list_dir(path?)                        — explore directory structure
- search_code(pattern, path?, file_glob?)— grep-style search across files
- web_search(query)                      — current info, docs, APIs
- fetch_url(url)                         — read a full web page
- run_command(command, description)      — shell command (needs user approval)

## Coding workflow
1. list_dir / search_code to explore structure and find relevant files
2. read_file to understand the exact current content before any edit
3. edit_file for targeted changes (old_string must be unique and exactly match)
4. write_file only for new files or complete rewrites
5. run_command to test, build, run — iterate until it works

## Rules
- Never guess file content — always read_file first
- edit_file old_string must be unique; include enough context lines to make it unique
- If a task needs many files changed, do them one at a time
- For web questions or docs you're unsure about, use web_search
- Cite sources [Title](URL) in responses
- Code in fenced blocks with language tag
- Be direct and concise; show diffs/changes clearly`;
}

// ── Context (trimmed) ─────────────────────────────────────────────────────────
function buildContext() {
  const recent = messages.length > 20 ? messages.slice(-20) : messages;
  return [{ role: 'system', content: buildSystem() }, ...recent];
}

// ── Path helper ───────────────────────────────────────────────────────────────
function resolvePath(p) {
  if (!p) return workdir;
  if (p.startsWith('~')) p = p.replace('~', process.env.HOME || '');
  return resolve(workdir, p);
}

// ── Terminal helpers ──────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt(getPrompt());

function clearLine() {
  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

function renderCodeBlock(lang, code) {
  const lines = code.replace(/\n$/, '').split('\n');
  const numW  = String(lines.length).length;
  const shown = lines.slice(0, 40);
  const body  = shown.map((l, i) =>
    `  ${GRAY}${String(i + 1).padStart(numW)}${RESET}  ${WHITE}${l}${RESET}`
  ).join('\n');
  const trunc = lines.length > 40 ? `\n  ${GRAY}… ${lines.length - 40} more lines${RESET}` : '';
  return `${GRAY}${lang || 'code'}${RESET}\n${body}${trunc}`;
}

function renderReply(text) {
  const lines = text.split('\n');
  const out = [];
  let inCode = false, codeLang = '', codeBuf = [];

  for (const line of lines) {
    if (!inCode && line.startsWith('```')) {
      inCode = true; codeLang = line.slice(3).trim(); codeBuf = [];
      continue;
    }
    if (inCode && line.startsWith('```')) {
      out.push(renderCodeBlock(codeLang, codeBuf.join('\n')));
      inCode = false; codeBuf = [];
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    let l = line
      .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
      .replace(/\*([^*]+)\*/g,     `${ITALIC}$1${RESET}`)
      .replace(/`([^`]+)`/g,       `${ORANGE}$1${RESET}`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${BLUE}$1${RESET}${GRAY}(${DIM}$2${RESET}${GRAY})${RESET}`)
      .replace(/^#{1,3} (.+)$/, `${BOLD}${WHITE}$1${RESET}`)
      .replace(/^[-*] /,        `${GRAY}• ${RESET}`);
    out.push(l);
  }
  if (inCode && codeBuf.length) out.push(renderCodeBlock(codeLang, codeBuf.join('\n')));
  return out.join('\n');
}

// ── File operations ───────────────────────────────────────────────────────────
async function opReadFile(path, offset, limit) {
  const full = resolvePath(path);
  const raw  = await readFile(full, 'utf8');
  const allLines = raw.split('\n');
  const start    = offset ? Math.max(0, offset - 1) : 0;
  const lines    = limit ? allLines.slice(start, start + limit) : allLines.slice(start);
  const numW     = String(start + lines.length).length;
  // Return numbered lines to the AI so it knows exact line positions
  const numbered = lines.map((l, i) => `${String(start + i + 1).padStart(numW)} │ ${l}`).join('\n');
  return `${path} (${allLines.length} lines total)\n${numbered}`;
}

async function opWriteFile(path, content) {
  const full = resolvePath(path);
  await mkdir(dirname(full), { recursive: true });
  await fsWriteFile(full, content, 'utf8');
  return content.split('\n').length;
}

async function opEditFile(path, oldStr, newStr) {
  const full    = resolvePath(path);
  const content = await readFile(full, 'utf8');
  const count   = content.split(oldStr).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${path}. Read the file first to get exact content.`);
  if (count > 1)   throw new Error(`old_string appears ${count} times — make it more unique by including more surrounding lines.`);
  await fsWriteFile(full, content.replace(oldStr, newStr), 'utf8');
  return { oldLines: oldStr.split('\n').length, newLines: newStr.split('\n').length };
}

async function opListDir(path, depth = 0, prefix = '') {
  const full    = resolvePath(path || '');
  const entries = await readdir(full, { withFileTypes: true });
  const visible = entries
    .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__' && e.name !== 'target' && e.name !== 'dist')
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  let out = '';
  for (let i = 0; i < visible.length; i++) {
    const e      = visible[i];
    const isLast = i === visible.length - 1;
    const conn   = isLast ? '└─ ' : '├─ ';
    const child  = isLast ? '   ' : '│  ';
    out += `${prefix}${conn}${e.name}${e.isDirectory() ? '/' : ''}\n`;
    if (e.isDirectory() && depth < 1) {
      try { out += await opListDir(join(full, e.name), depth + 1, prefix + child); } catch {}
    }
  }
  return out;
}

function opSearchCode(pattern, path, fileGlob) {
  return new Promise(resolve => {
    const searchPath = resolvePath(path || '');
    const args = ['-r', '-n', '-m', '5', '--color=never', '--max-count=5'];
    if (fileGlob) args.push(`--include=${fileGlob}`);
    args.push('--', pattern, searchPath);
    execFile('grep', args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (_err, stdout) => {
      if (!stdout.trim()) { resolve('(no matches)'); return; }
      const lines = stdout.trim().split('\n').slice(0, 60);
      // Make paths relative to workdir
      const out = lines.map(l => l.replace(workdir + '/', '')).join('\n');
      resolve(out + (lines.length >= 60 ? '\n… (more results, narrow your search)' : ''));
    });
  });
}

// ── Tool execution ────────────────────────────────────────────────────────────
async function executeOneTool(name, args) {

  // ── Read-only tools (auto, no approval) ─────────────────────────────────────
  if (name === 'read_file') {
    const relPath = relative(workdir, resolvePath(args.path));
    process.stdout.write(`${BULLET} ${GRAY}Read${RESET}(${WHITE}${relPath}${RESET})\n`);
    const out = await opReadFile(args.path, args.offset, args.limit);
    const lc  = out.split('\n').length - 1;
    process.stdout.write(`  ${TREE} ${GRAY}${lc} lines${RESET}\n`);
    return out;
  }

  if (name === 'list_dir') {
    const relPath = args.path ? relative(workdir, resolvePath(args.path)) || '.' : '.';
    process.stdout.write(`${BULLET} ${GRAY}ListDir${RESET}(${WHITE}${relPath}${RESET})\n`);
    const tree = await opListDir(args.path);
    const lines = tree.trim().split('\n').length;
    process.stdout.write(`  ${TREE} ${GRAY}${lines} entries${RESET}\n`);
    return tree || '(empty)';
  }

  if (name === 'search_code') {
    process.stdout.write(`${BULLET} ${GRAY}Search${RESET}(${WHITE}${args.pattern}${RESET}${args.file_glob ? `  ${GRAY}${args.file_glob}${RESET}` : ''})\n`);
    const out = await opSearchCode(args.pattern, args.path, args.file_glob);
    const count = out === '(no matches)' ? 0 : out.split('\n').length;
    process.stdout.write(`  ${TREE} ${GRAY}${count || 'no'} match${count !== 1 ? 'es' : ''}${RESET}\n`);
    return out;
  }

  if (name === 'web_search') {
    process.stdout.write(`${BULLET} ${GRAY}WebSearch${RESET}(${WHITE}${args.query}${RESET})\n`);
    const results = await webSearch(args.query);
    process.stdout.write(`  ${TREE} ${GRAY}${results.length} results${RESET}\n`);
    return results.map((r, i) => `[${i+1}] **${r.title}**\nURL: ${r.url}\n${r.snippet}`).join('\n\n');
  }

  if (name === 'fetch_url') {
    const short = args.url.replace(/^https?:\/\//, '').slice(0, 60);
    process.stdout.write(`${BULLET} ${GRAY}Fetch${RESET}(${WHITE}${short}${RESET})\n`);
    const text = await fetchUrl(args.url);
    process.stdout.write(`  ${TREE} ${GRAY}${text.split('\n').length} lines${RESET}\n`);
    return text;
  }

  // ── Write tools (auto-approved, shown clearly) ───────────────────────────────
  if (name === 'write_file') {
    const relPath = relative(workdir, resolvePath(args.path)) || basename(args.path);
    const lc      = args.content.split('\n').length;
    process.stdout.write(`${BULLET} ${GREEN}Write${RESET}(${WHITE}${relPath}${RESET})\n`);
    await opWriteFile(args.path, args.content);
    process.stdout.write(`  ${TREE} ${GRAY}Wrote ${lc} lines${RESET}\n`);
    return `Wrote ${lc} lines to ${relPath}`;
  }

  if (name === 'edit_file') {
    const relPath  = relative(workdir, resolvePath(args.path)) || basename(args.path);
    const oldLines = args.old_string.split('\n');
    const newLines = args.new_string.split('\n');
    process.stdout.write(`${BULLET} ${ORANGE}Edit${RESET}(${WHITE}${relPath}${RESET})\n`);
    // Show mini-diff
    const maxShow = 3;
    oldLines.slice(0, maxShow).forEach(l => process.stdout.write(`  ${RED}- ${l}${RESET}\n`));
    if (oldLines.length > maxShow) process.stdout.write(`  ${RED}  … ${oldLines.length - maxShow} more${RESET}\n`);
    newLines.slice(0, maxShow).forEach(l => process.stdout.write(`  ${GREEN}+ ${l}${RESET}\n`));
    if (newLines.length > maxShow) process.stdout.write(`  ${GREEN}  … ${newLines.length - maxShow} more${RESET}\n`);
    const { oldLines: ol, newLines: nl } = await opEditFile(args.path, args.old_string, args.new_string);
    process.stdout.write(`  ${TREE} ${GRAY}-${ol} +${nl} lines${RESET}\n`);
    return `Edited ${relPath}: replaced ${ol} lines with ${nl} lines`;
  }

  // ── Shell command (always needs approval) ────────────────────────────────────
  if (name === 'run_command') {
    process.stdout.write(`${BULLET} ${ORANGE}Bash${RESET}(${WHITE}${args.command}${RESET})\n`);
    process.stdout.write(`  ${BRANCH} ${GRAY}${args.description || ''}${RESET}\n`);
    rl.setPrompt(APPROVAL_PROMPT);
    rl.prompt();
    const approved = await new Promise(resolve => { pendingApproval = { resolve }; });
    rl.setPrompt(getPrompt());
    if (!approved) {
      process.stdout.write(`  ${TREE} ${GRAY}Denied${RESET}\n`);
      return '[user denied the command]';
    }
    const output   = await runShell(args.command);
    const outLines = output.trim().split('\n');
    const shown    = outLines.slice(0, 30).join('\n');
    const extra    = outLines.length > 30 ? `\n  ${GRAY}… +${outLines.length - 30} lines${RESET}` : '';
    process.stdout.write(`  ${TREE} ${GRAY}${shown}${extra}${RESET}\n`);
    return output;
  }

  throw new Error(`Unknown tool: ${name}`);
}

// Run web/read tools in parallel; writes/commands must be sequential
async function executeTools(toolCalls) {
  const parallel   = toolCalls.filter(tc => ['web_search', 'fetch_url', 'read_file', 'list_dir', 'search_code'].includes(tc.name));
  const sequential = toolCalls.filter(tc => !['web_search', 'fetch_url', 'read_file', 'list_dir', 'search_code'].includes(tc.name));
  const results    = new Map();

  clearLine();
  await Promise.all(parallel.map(async tc => {
    try   { results.set(tc.id || tc.name, await executeOneTool(tc.name, tc.args)); }
    catch (e) {
      process.stdout.write(`  ${TREE} ${GRAY}${tc.name} failed: ${e.message}${RESET}\n`);
      results.set(tc.id || tc.name, `Error: ${e.message}`);
    }
  }));

  for (const tc of sequential) {
    try   { results.set(tc.id || tc.name, await executeOneTool(tc.name, tc.args)); }
    catch (e) {
      process.stdout.write(`  ${TREE} ${GRAY}${tc.name} failed: ${e.message}${RESET}\n`);
      results.set(tc.id || tc.name, `Error: ${e.message}`);
    }
  }

  return toolCalls.map(tc => ({
    role: 'tool',
    tool_call_id: tc.id || tc.name,
    content: results.get(tc.id || tc.name) ?? '',
  }));
}

function runShell(command) {
  return new Promise(resolve => {
    exec(command, { cwd: workdir, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const parts = [];
      if (stdout) parts.push(stdout.slice(0, 30000));
      if (stderr) parts.push(`stderr: ${stderr.slice(0, 5000)}`);
      if (err && !stdout && !stderr) parts.push(`error: ${err.message}`);
      parts.push(`exit: ${err ? (err.code ?? 1) : 0}`);
      resolve(parts.join('\n').trim());
    });
  });
}

// ── SSE stream parser ─────────────────────────────────────────────────────────
async function* sseLines(body) {
  const reader = body.getReader(); const decoder = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { const t = l.trim(); if (t.startsWith('data: ')) yield t.slice(6); }
  }
}

// ── OpenAI-compatible stream ──────────────────────────────────────────────────
async function* streamOpenAI(backend, msgs) {
  const res = await fetch(backend.url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${backend.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: backend.model, messages: msgs, stream: true, tools: TOOLS, tool_choice: 'auto', max_tokens: 8192 }),
  });
  if (!res.ok) {
    const body = await res.text();
    const err  = new Error(`${backend.name} ${res.status}: ${body}`);
    err.status = res.status;
    const m = body.match(/try again in ([0-9.]+)s/i);
    err.retryAfter = m ? Math.ceil(parseFloat(m[1])) : 10;
    throw err;
  }

  let content = ''; const tcMap = {};
  for await (const raw of sseLines(res.body)) {
    if (raw === '[DONE]') break;
    let data; try { data = JSON.parse(raw); } catch { continue; }
    const choice = data.choices?.[0]; if (!choice) continue;
    const delta  = choice.delta || {};
    if (delta.content) { content += delta.content; yield { type: 'token', text: delta.content }; }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!tcMap[tc.index]) tcMap[tc.index] = { id: '', name: '', args: '' };
        if (tc.id)                  tcMap[tc.index].id   = tc.id;
        if (tc.function?.name)      tcMap[tc.index].name += tc.function.name;
        if (tc.function?.arguments) tcMap[tc.index].args += tc.function.arguments;
      }
    }
    if (choice.finish_reason) {
      const toolCalls = Object.values(tcMap).map(tc => {
        let parsed; try { parsed = JSON.parse(tc.args); } catch { parsed = {}; }
        return { id: tc.id, name: tc.name, args: parsed };
      });
      yield { type: 'finish', content, toolCalls };
    }
  }
}

// ── Ollama stream ─────────────────────────────────────────────────────────────
async function* streamOllama(msgs) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages: msgs, stream: true, tools: TOOLS }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const reader = res.body.getReader(); const decoder = new TextDecoder();
  let buf = ''; let content = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let data; try { data = JSON.parse(line); } catch { continue; }
      if (data.message?.content) { content += data.message.content; yield { type: 'token', text: data.message.content }; }
      if (data.done) {
        const toolCalls = (data.message?.tool_calls || []).map(tc => ({
          id: tc.id || '', name: tc.function.name,
          args: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments,
        }));
        yield { type: 'finish', content, toolCalls };
      }
    }
  }
}

// ── Core turn ─────────────────────────────────────────────────────────────────
async function runTurn(backendIndex = 0) {
  const ctx = buildContext();
  clearLine();
  process.stdout.write(`${BULLET} ${GRAY}…${RESET}`);

  let stream;
  let usedBackend = null;

  if (!USE_OLLAMA_ONLY && backendIndex < OPENAI_BACKENDS.length) {
    usedBackend = OPENAI_BACKENDS[backendIndex];
    stream = streamOpenAI(usedBackend, ctx);
  } else {
    stream = streamOllama(ctx);
  }

  let firstToken = true;
  let fullContent = '';

  try {
    for await (const event of stream) {
      if (event.type === 'token') {
        if (firstToken) { clearLine(); process.stdout.write(`${BULLET} `); firstToken = false; }
        process.stdout.write(event.text);
        fullContent += event.text;
      }

      if (event.type === 'finish') {
        if (firstToken) {
          clearLine();
        } else {
          process.stdout.write('\n');
          if (fullContent.includes('```')) {
            const rendered = renderReply(fullContent);
            readline.moveCursor(process.stdout, 0, -(fullContent.split('\n').length + 1));
            readline.clearScreenDown(process.stdout);
            process.stdout.write(`${BULLET} ${rendered}\n`);
          }
        }

        messages.push({
          role: 'assistant', content: event.content || null,
          tool_calls: event.toolCalls.length ? event.toolCalls.map(tc => ({
            id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })) : undefined,
        });

        if (event.toolCalls.length > 0) {
          const toolResults = await executeTools(event.toolCalls);
          process.stdout.write('\n');
          messages.push(...toolResults);
          await runTurn(backendIndex);
          return;
        }

        process.stdout.write('\n');
        rl.setPrompt(getPrompt());
        rl.prompt();
      }
    }
  } catch (err) {
    clearLine();
    if (err.status === 429 && !USE_OLLAMA_ONLY && backendIndex + 1 < OPENAI_BACKENDS.length) {
      const next = OPENAI_BACKENDS[backendIndex + 1];
      process.stdout.write(`  ${TREE} ${YELLOW}${usedBackend?.name} rate-limited → ${next.name}${RESET}\n`);
      return runTurn(backendIndex + 1);
    }
    const hint = err.status === 429
      ? 'All backends rate-limited. Wait a moment and try again.'
      : USE_OLLAMA_ONLY
        ? `Could not reach Ollama at ${OLLAMA_URL}. Is it running?`
        : err.message;
    process.stdout.write(`${BULLET} ${GRAY}${hint}${RESET}\n\n`);
    rl.setPrompt(getPrompt());
    rl.prompt();
  }
}

// ── Input loop ────────────────────────────────────────────────────────────────
async function processQueue() {
  if (busy || queue.length === 0) return;
  busy = true;
  while (queue.length > 0) { queue.shift(); await runTurn(); }
  busy = false;
}

function printHelp() {
  process.stdout.write(`\n${BULLET} ${WHITE}Commands${RESET}\n`);
  process.stdout.write(`  ${BRANCH} ${ORANGE}/cd <path>${RESET}      ${GRAY}change working directory${RESET}\n`);
  process.stdout.write(`  ${BRANCH} ${ORANGE}/clear${RESET}          ${GRAY}clear conversation history${RESET}\n`);
  process.stdout.write(`  ${BRANCH} ${ORANGE}/wd${RESET}             ${GRAY}show current working directory${RESET}\n`);
  process.stdout.write(`  ${BRANCH} ${ORANGE}/help${RESET}           ${GRAY}show this help${RESET}\n`);
  process.stdout.write(`  ${TREE}  ${ORANGE}/exit${RESET}           ${GRAY}quit${RESET}\n\n`);
}

// ── Startup banner ────────────────────────────────────────────────────────────
const primaryLabel = OPENAI_BACKENDS[0]?.label ?? `Ollama/${OLLAMA_MODEL}`;
const fallbacks    = OPENAI_BACKENDS.slice(1).map(b => b.label).join(' → ');
const home         = process.env.HOME || '';
const dispDir      = workdir.startsWith(home) ? '~' + workdir.slice(home.length) : workdir;

process.stdout.write(`\n${BULLET} ${WHITE}AI Assistant${RESET}  ${GRAY}${primaryLabel}${RESET}`);
if (fallbacks) process.stdout.write(`  ${GRAY}↳ ${fallbacks}${RESET}`);
process.stdout.write(`\n  ${BRANCH} ${GRAY}workdir: ${dispDir}${RESET}\n`);
process.stdout.write(`  ${TREE}  ${GRAY}/help for commands${RESET}\n\n`);

rl.setPrompt(getPrompt());
rl.prompt();

rl.on('line', async (line) => {
  if (pendingApproval) {
    const answer  = line.trim().toLowerCase();
    const resolve = pendingApproval.resolve;
    pendingApproval = null;
    resolve(answer === 'y' || answer === 'yes');
    return;
  }

  const text = line.trim();

  if (process.stdout.isTTY && text) {
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(`${USER_BG}${BOLD}you>${RESET}${USER_BG} ${line}${RESET}\n`);
  }

  if (text === '/exit')  { rl.close(); return; }
  if (text === '/help')  { printHelp(); rl.setPrompt(getPrompt()); rl.prompt(); return; }
  if (text === '/wd')    { process.stdout.write(`  ${TREE} ${GRAY}${workdir}${RESET}\n\n`); rl.prompt(); return; }
  if (text === '/clear') {
    messages.length = 0;
    process.stdout.write(`  ${TREE} ${GRAY}Conversation cleared${RESET}\n\n`);
    rl.prompt(); return;
  }
  if (text.startsWith('/cd ')) {
    const target = resolvePath(text.slice(4).trim());
    if (existsSync(target)) {
      workdir = target;
      const d = workdir.startsWith(home) ? '~' + workdir.slice(home.length) : workdir;
      process.stdout.write(`  ${TREE} ${GRAY}→ ${d}${RESET}\n\n`);
      rl.setPrompt(getPrompt());
    } else {
      process.stdout.write(`  ${TREE} ${GRAY}Directory not found: ${target}${RESET}\n\n`);
    }
    rl.prompt(); return;
  }
  if (!text) { rl.prompt(); return; }

  messages.push({ role: 'user', content: text });
  queue.push(1);
  rl.prompt();
  processQueue();
});

rl.on('close', () => { process.stdout.write('\nBye!\n'); process.exit(0); });
