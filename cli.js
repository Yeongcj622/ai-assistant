import dotenv from 'dotenv';
import readline from 'readline';
import { exec, execFile } from 'child_process';
import { readFile, writeFile as fsWriteFile, readdir, stat, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join, relative, dirname, basename } from 'path';
import { promisify } from 'util';
import { webSearch, fetchUrl } from './tools.js';
import { generatePdf } from './pdf.js';

dotenv.config();
const execFileAsync = promisify(execFile);

// ── Config ───────────────────────────────────────────────────────────────────
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY || '';
const CEREBRAS_MODEL   = process.env.CEREBRAS_MODEL   || 'llama3.3-70b';
const CEREBRAS_URL     = 'https://api.cerebras.ai/v1/chat/completions';

const GOOGLE_API_KEY   = process.env.GOOGLE_API_KEY || '';
const GEMINI_MODEL     = process.env.GEMINI_MODEL    || 'gemini-2.5-flash';
const GEMINI_URL       = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const GROQ_API_KEY     = process.env.GROQ_API_KEY || '';
const GROQ_URL         = 'https://api.groq.com/openai/v1/chat/completions';
const OLLAMA_URL       = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL     = process.env.OLLAMA_MODEL || 'llama3.2:3b';

// Backend priority chain — first available is primary, rest are fallbacks
const OPENAI_BACKENDS = [
  CEREBRAS_API_KEY && { name: 'Cerebras', label: `Cerebras/${CEREBRAS_MODEL}`,   url: CEREBRAS_URL, key: CEREBRAS_API_KEY, model: CEREBRAS_MODEL },
  GOOGLE_API_KEY   && { name: 'Gemini',   label: `Gemini/${GEMINI_MODEL}`,        url: GEMINI_URL,   key: GOOGLE_API_KEY,   model: GEMINI_MODEL },
  GROQ_API_KEY     && { name: 'Groq',     label: 'Groq/llama-4-scout',            url: GROQ_URL,     key: GROQ_API_KEY,     model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
  GROQ_API_KEY     && { name: 'Groq-8b',  label: 'Groq/llama-3.1-8b',            url: GROQ_URL,     key: GROQ_API_KEY,     model: 'llama-3.1-8b-instant' },
].filter(Boolean);
const USE_OLLAMA_ONLY = OPENAI_BACKENDS.length === 0;

// ── State ────────────────────────────────────────────────────────────────────
let workdir        = process.env.ASSISTANT_WORKDIR || process.env.HOME || process.cwd();
const messages     = [];
let pendingApproval = null;
let busy           = false;
const queue        = [];

// ── ANSI ─────────────────────────────────────────────────────────────────────
const DIM     = '\x1b[2m';
const BOLD    = '\x1b[1m';
const ITALIC  = '\x1b[3m';
const USER_BG = '\x1b[48;2;30;32;40m\x1b[38;2;200;210;230m';
const GREEN   = '\x1b[38;2;80;200;120m';
const RED     = '\x1b[38;2;220;80;80m';
const ORANGE  = '\x1b[38;2;230;140;60m';
const BLUE    = '\x1b[38;2;100;160;240m';
const GRAY    = '\x1b[38;2;130;140;160m';
const WHITE   = '\x1b[38;2;220;225;240m';
const YELLOW  = '\x1b[38;2;220;190;80m';
const RESET   = '\x1b[0m';
const BULLET  = `${GREEN}●${RESET}`;
const TREE    = `${GRAY}└${RESET}`;
const BRANCH  = `${GRAY}├${RESET}`;
const APPROVAL_PROMPT = `${BOLD}Allow? [y/N]${RESET} `;

function getPrompt() {
  const home    = process.env.HOME || '';
  const display = workdir.startsWith(home) ? '~' + workdir.slice(home.length) : workdir;
  return `${GRAY}${display}${RESET} ${GREEN}>${RESET} `;
}

// ── Tools (10 total) ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function', function: {
      name: 'read_file',
      description: 'Read a file. ALWAYS call before editing to get exact content and line numbers. Returns numbered lines.',
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
      description: 'Write or overwrite a file entirely. Use for new files. Prefer edit_file for modifications to existing files. Creates parent dirs automatically.',
      parameters: { type: 'object', properties: {
        path:    { type: 'string' },
        content: { type: 'string' },
      }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function', function: {
      name: 'edit_file',
      description: 'Replace EXACTLY one occurrence of old_string with new_string in a file. old_string must match character-for-character (spaces, indentation, newlines). Read the file first. If old_string appears multiple times, add surrounding context lines to make it unique.',
      parameters: { type: 'object', properties: {
        path:       { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to replace — must be unique in the file' },
        new_string: { type: 'string', description: 'Replacement text' },
      }, required: ['path', 'old_string', 'new_string'] },
    },
  },
  {
    type: 'function', function: {
      name: 'list_dir',
      description: 'List directory contents as a tree (2 levels). Use to understand project structure before diving in.',
      parameters: { type: 'object', properties: {
        path: { type: 'string', description: 'Directory (default: working dir)' },
      }, required: [] },
    },
  },
  {
    type: 'function', function: {
      name: 'search_code',
      description: 'Grep files for a pattern. Returns filename:line:content. Use to find definitions, usages, imports.',
      parameters: { type: 'object', properties: {
        pattern:   { type: 'string', description: 'Text or regex' },
        path:      { type: 'string', description: 'Dir or file to search (default: working dir)' },
        file_glob: { type: 'string', description: 'e.g. "*.js" "*.py" (optional)' },
      }, required: ['pattern'] },
    },
  },
  {
    type: 'function', function: {
      name: 'summarize_files',
      description: 'Summarize one or more PDF/text files into a single PDF. Handles all chunking and API calls internally — NEVER hits context limits. Use this instead of manually reading chunks when summarizing documents. Perfect for lecture notes, research papers, textbooks.',
      parameters: { type: 'object', properties: {
        paths:       { type: 'array', items: { type: 'string' }, description: 'File paths to summarize (PDFs or text files)' },
        output_path: { type: 'string', description: 'Output .pdf path (e.g. "summary.pdf")' },
        title:       { type: 'string', description: 'Title for the summary document' },
        subject:     { type: 'string', description: 'Subject/domain context for better summaries (e.g. "information security")' },
      }, required: ['paths', 'output_path'] },
    },
  },
  {
    type: 'function', function: {
      name: 'make_pdf',
      description: 'Create a professional PDF from markdown content. Use for: summarizing notes, creating reports, writing documents. Automatically opens the PDF when done.',
      parameters: { type: 'object', properties: {
        content:     { type: 'string', description: 'Full markdown content to put in the PDF' },
        output_path: { type: 'string', description: 'Output .pdf path (relative to working dir). e.g. "summary.pdf"' },
        title:       { type: 'string', description: 'Document title shown on the cover' },
        author:      { type: 'string', description: 'Author name (optional)' },
      }, required: ['content', 'output_path'] },
    },
  },
  {
    type: 'function', function: {
      name: 'web_search',
      description: 'Search the web for current facts, news, documentation, prices, APIs. Use freely for anything you are uncertain about.',
      parameters: { type: 'object', properties: {
        query: { type: 'string' },
      }, required: ['query'] },
    },
  },
  {
    type: 'function', function: {
      name: 'fetch_url',
      description: 'Fetch the full readable text of a web page. Use after web_search to read a specific result.',
      parameters: { type: 'object', properties: {
        url: { type: 'string' },
      }, required: ['url'] },
    },
  },
  {
    type: 'function', function: {
      name: 'run_command',
      description: 'Run a shell command (requires your approval). Use for: tests, builds, git, npm install, etc.',
      parameters: { type: 'object', properties: {
        command:     { type: 'string' },
        description: { type: 'string', description: 'What it does and why' },
      }, required: ['command', 'description'] },
    },
  },
];

// ── Dynamic system prompt ─────────────────────────────────────────────────────
function buildSystem() {
  const home    = process.env.HOME || '';
  const dispDir = workdir.startsWith(home) ? '~' + workdir.slice(home.length) : workdir;
  return `You are an expert software engineer and personal assistant in the terminal.
Working directory: ${dispDir}   Today: ${new Date().toDateString()}

## Tools
- read_file(path, offset?, limit?)          — numbered output; ALWAYS read before editing
- write_file(path, content)                 — full write; for new files or complete rewrites
- edit_file(path, old_string, new_string)   — precise replacement; safer for edits; read first
- list_dir(path?)                           — project tree
- search_code(pattern, path?, file_glob?)   — grep across files
- make_pdf(content, output_path, title?, author?) — PDF from markdown, auto-opens
- web_search(query)                         — current info, docs, APIs
- fetch_url(url)                            — read full web page
- run_command(command, description)         — shell (needs approval)

## Accuracy rules — follow strictly
1. ALWAYS read_file before edit_file. Never guess file content.
2. edit_file old_string must be unique. Include extra context lines if needed.
3. After write_file or edit_file you will see the file content back — verify it looks correct before proceeding.
4. If a write verification shows a mistake, fix it immediately with another edit_file.
5. For multi-file tasks: finish one file completely before moving to the next.
6. When unsure about an API, function name, or library — use web_search first.

## PDF / notes workflow
- To summarize documents: ALWAYS use summarize_files([paths], output_path, title, subject)
  It handles chunking, API calls, combining, and PDF generation internally — zero context blowout
  Example: summarize_files(["Slides/01.pdf","Slides/02.pdf"], "summary.pdf", "My Notes", "physics")
- make_pdf: use for writing NEW content as a PDF (reports, your own writing)
- read_file extracts real text from .pdf files via pdftotext automatically
- make_pdf markdown: use ## for each source file section, bullet key points, bold important terms, code blocks for formulas/algorithms
- Use a clear title; the PDF will have a professional cover with title + date

## Coding workflow
list_dir → search_code → read_file → edit_file / write_file → run_command (test) → iterate

Be direct and concise in explanations. Show code changes clearly. Cite web sources [Title](URL).`;
}

// ── Context window — trim old large tool results to avoid TPM blowout ─────────
const TOOL_RESULT_KEEP_TURNS = 3;   // how many recent turns keep full tool results
const TOOL_RESULT_MAX_CHARS  = 400; // older results get truncated to this

function buildContext() {
  const recent = messages.length > 20 ? messages.slice(-20) : messages;

  // Find the message index marking the "keep full results" boundary
  let keepFromIdx = recent.length;
  let turnsSeen   = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role === 'user') { turnsSeen++; if (turnsSeen >= TOOL_RESULT_KEEP_TURNS) { keepFromIdx = i; break; } }
  }

  const trimmed = recent.map((msg, i) => {
    if (i < keepFromIdx && msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > TOOL_RESULT_MAX_CHARS) {
      // Keep only the first part so the AI knows what it read, but drop the bulk
      return { ...msg, content: msg.content.slice(0, TOOL_RESULT_MAX_CHARS) + '\n[…content trimmed from context to save tokens]' };
    }
    return msg;
  });

  return [{ role: 'system', content: buildSystem() }, ...trimmed];
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
  const out   = [];
  let inCode  = false, codeLang = '', codeBuf = [];

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
      .replace(/^#{1,4} (.+)$/,    `${BOLD}${WHITE}$1${RESET}`)
      .replace(/^[-*] /,           `${GRAY}• ${RESET}`);
    out.push(l);
  }
  if (inCode && codeBuf.length) out.push(renderCodeBlock(codeLang, codeBuf.join('\n')));
  return out.join('\n');
}

// ── File operations ───────────────────────────────────────────────────────────
const PDF_DEFAULT_LIMIT  = 100;  // lines per chunk for PDFs
const TEXT_DEFAULT_LIMIT = 200;  // lines per chunk for large text files

async function extractPdfText(fullPath) {
  return new Promise((resolve, reject) => {
    execFile('pdftotext', ['-layout', fullPath, '-'], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(new Error(`pdftotext failed: ${err.message}. Install with: sudo apt install poppler-utils`));
      else resolve(stdout);
    });
  });
}

async function opReadFile(path, offset, limit) {
  const full    = resolvePath(path);
  const isPdf   = path.toLowerCase().endsWith('.pdf');
  let raw;

  if (isPdf) {
    raw = await extractPdfText(full);
  } else {
    try { raw = await readFile(full, 'utf8'); }
    catch { throw new Error(`Cannot read file: ${path}`); }
  }

  const allLines = raw.split('\n');
  const start    = offset ? Math.max(0, offset - 1) : 0;
  const defLimit = isPdf ? PDF_DEFAULT_LIMIT : TEXT_DEFAULT_LIMIT;
  // If no explicit limit, cap at default to protect context window
  const take     = limit ?? defLimit;
  const slice    = allLines.slice(start, start + take);
  const numW     = String(start + slice.length).length;
  const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(numW)} │ ${l}`).join('\n');

  const remaining = allLines.length - (start + slice.length);
  const chunkNote = remaining > 0
    ? `\n\n[Showing lines ${start + 1}–${start + slice.length} of ${allLines.length} total. ${remaining} lines remain. Use offset=${start + slice.length + 1} limit=${take} to read the next chunk.]`
    : '';

  const typeLabel = isPdf ? 'PDF extracted' : 'text';
  return `${path} (${typeLabel}, ${allLines.length} lines total)\n${numbered}${chunkNote}`;
}

async function opWriteFile(path, content) {
  const full = resolvePath(path);
  await mkdir(dirname(full), { recursive: true });
  await fsWriteFile(full, content, 'utf8');
  // Return first 20 lines so AI can self-verify
  const preview = content.split('\n').slice(0, 20).join('\n');
  const total   = content.split('\n').length;
  return `Wrote ${total} lines to ${path}.\n\nVerification (first 20 lines):\n${preview}${total > 20 ? `\n… (${total - 20} more lines)` : ''}`;
}

async function opEditFile(path, oldStr, newStr) {
  const full    = resolvePath(path);
  const content = await readFile(full, 'utf8');
  const count   = content.split(oldStr).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${path}. The text must match exactly — read the file again to copy the exact content.`);
  if (count > 1)   throw new Error(`old_string found ${count} times in ${path}. Add more surrounding lines to make it unique.`);

  const newContent = content.replace(oldStr, newStr);
  await fsWriteFile(full, newContent, 'utf8');

  // Find where the edit landed and return context for self-verification
  const allLines  = newContent.split('\n');
  const editStart = newContent.indexOf(newStr);
  const lineNum   = newContent.slice(0, editStart).split('\n').length;
  const ctxStart  = Math.max(0, lineNum - 3);
  const ctxEnd    = Math.min(allLines.length, lineNum + newStr.split('\n').length + 2);
  const context   = allLines.slice(ctxStart, ctxEnd)
    .map((l, i) => `${ctxStart + i + 1} │ ${l}`).join('\n');

  const ol = oldStr.split('\n').length;
  const nl = newStr.split('\n').length;
  return `Edited ${path}: replaced ${ol} line${ol>1?'s':''} → ${nl} line${nl>1?'s':''}.\n\nVerification (lines ${ctxStart+1}–${ctxEnd}):\n${context}`;
}

async function opListDir(path, depth = 0, prefix = '') {
  const full    = resolvePath(path || '');
  let entries;
  try { entries = await readdir(full, { withFileTypes: true }); }
  catch { return `(cannot read directory: ${path || workdir})\n`; }

  const skip    = new Set(['node_modules', '__pycache__', '.git', 'dist', 'build', 'target', '.next', 'venv', '.venv']);
  const visible = entries
    .filter(e => !e.name.startsWith('.') && !skip.has(e.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  let out = '';
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]; const last = i === visible.length - 1;
    out += `${prefix}${last ? '└─ ' : '├─ '}${e.name}${e.isDirectory() ? '/' : ''}\n`;
    if (e.isDirectory() && depth < 1) {
      out += await opListDir(join(full, e.name), depth + 1, prefix + (last ? '   ' : '│  '));
    }
  }
  return out;
}

function opSearchCode(pattern, path, fileGlob) {
  return new Promise(resolve => {
    const searchPath = resolvePath(path || '');
    const args = ['-r', '-n', '-m', '5', '--color=never'];
    if (fileGlob) args.push(`--include=${fileGlob}`);
    args.push('--', pattern, searchPath);
    execFile('grep', args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (_err, stdout) => {
      if (!stdout.trim()) { resolve('(no matches)'); return; }
      const lines = stdout.trim().split('\n').slice(0, 60).map(l => l.replace(workdir + '/', ''));
      resolve(lines.join('\n') + (lines.length >= 60 ? '\n… (narrow your search for more precise results)' : ''));
    });
  });
}

// ── Isolated single-shot API call (no chat history, no tools) ────────────────
async function callApiOnce(system, user) {
  for (const backend of OPENAI_BACKENDS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(backend.url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${backend.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model:      backend.model,
            messages:   [{ role: 'system', content: system }, { role: 'user', content: user }],
            stream:     false,
            max_tokens: 1500,
          }),
          signal: AbortSignal.timeout(45000),
        });
        if (res.status === 429 || res.status === 413) {
          const body = await res.text();
          const m    = body.match(/try again in ([0-9.]+)s/i);
          const wait = Math.min((m ? Math.ceil(parseFloat(m[1])) : (attempt + 1) * 5) * 1000, 15000);
          process.stdout.write(`  ${GRAY}  ⏳ ${backend.name} limit, waiting ${Math.round(wait/1000)}s…${RESET}\r`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) break;
        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || '';
      } catch { if (attempt < 2) await new Promise(r => setTimeout(r, 2000)); }
    }
  }
  if (USE_OLLAMA_ONLY) {
    const res  = await fetch(`${OLLAMA_URL}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: false }) });
    const data = await res.json();
    return data.message?.content?.trim() || '';
  }
  throw new Error('All backends failed');
}

// ── Batch summarization pipeline (runs entirely outside chat history) ─────────
async function opSummarizeFiles(paths, outputPath, title, subject) {
  const CHUNK     = 60;   // lines per summarization call
  const DELAY     = 2500; // ms between API calls
  const domain    = subject || 'the subject';
  let fullMarkdown = '';

  for (let fi = 0; fi < paths.length; fi++) {
    const filePath = paths[fi];
    const fullPath = resolvePath(filePath);
    const isPdf    = filePath.toLowerCase().endsWith('.pdf');
    const name     = basename(filePath).replace(/\.(pdf|md|txt|tex)$/i, '');

    process.stdout.write(`\n${BULLET} ${WHITE}${name}${RESET} ${GRAY}(${fi+1}/${paths.length})${RESET}\n`);

    // Extract raw text
    let raw;
    if (isPdf) {
      raw = await new Promise((res, rej) => {
        execFile('pdftotext', ['-layout', fullPath, '-'], { timeout: 30000, maxBuffer: 20*1024*1024 },
          (err, stdout) => { if (err && !stdout) rej(new Error(`pdftotext: ${err.message}`)); else res(stdout); });
      });
    } else {
      raw = await readFile(fullPath, 'utf8');
    }

    // Split into chunks, stripping blank lines to save tokens
    const lines  = raw.split('\n').filter(l => l.trim().length > 1);
    const chunks = [];
    for (let i = 0; i < lines.length; i += CHUNK) chunks.push(lines.slice(i, i + CHUNK).join('\n'));

    // Summarize each chunk with an isolated API call
    const chunkSummaries = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      process.stdout.write(`  ${BRANCH} ${GRAY}chunk ${ci+1}/${chunks.length}…         ${RESET}\r`);
      const sys = `You are a precise note-taker summarizing lecture slides on ${domain} for a student.
This is excerpt ${ci+1}/${chunks.length} from "${name}".
Extract ALL key concepts, definitions, theorems, algorithms, and important facts.
Format your output as structured markdown:
- **Bold** key terms and names
- Bullet points for facts, properties, steps
- Preserve mathematical notation and pseudocode exactly
- Subheadings (###) for distinct topics if multiple appear`;
      const summary = await callApiOnce(sys, chunks[ci]);
      chunkSummaries.push(summary);
      if (ci < chunks.length - 1) await new Promise(r => setTimeout(r, DELAY));
    }

    // If multiple chunks, do one final combining call
    let section;
    if (chunkSummaries.length === 1) {
      section = chunkSummaries[0];
    } else {
      process.stdout.write(`  ${BRANCH} ${GRAY}combining ${chunks.length} chunks…     ${RESET}\n`);
      await new Promise(r => setTimeout(r, DELAY));
      const combined = chunkSummaries.join('\n\n---\n\n');
      section = await callApiOnce(
        `Combine these ${chunks.length} partial summaries of "${name}" (${domain} lecture) into one cohesive markdown summary. Merge duplicate points, organize by topic with ### subheadings. Preserve ALL technical details, formulas, and definitions.`,
        combined.slice(0, 12000)
      );
    }

    fullMarkdown += `## ${name}\n\n${section}\n\n`;
    process.stdout.write(`  ${TREE} ${GREEN}✓ done${RESET}                    \n`);
  }

  // Generate the PDF
  process.stdout.write(`\n${BULLET} ${BLUE}Generating PDF${RESET}…\n`);
  const pdfPath = resolvePath(outputPath);
  await mkdir(dirname(pdfPath), { recursive: true });
  const outPath = await generatePdf(fullMarkdown, pdfPath, title || 'Summary', '', true);
  const sz      = (await execFileAsync('du', ['-sh', outPath]).catch(() => ({ stdout: '?' }))).stdout.trim().split('\t')[0];
  process.stdout.write(`  ${TREE} ${GRAY}${sz} — opened in viewer${RESET}\n`);
  return `PDF created: ${outPath} (${sz}). Summarized ${paths.length} files.`;
}

// ── Tool execution ────────────────────────────────────────────────────────────
async function executeOneTool(name, args) {

  // ── Read-only (auto, no approval) ────────────────────────────────────────────
  if (name === 'read_file') {
    const rel = relative(workdir, resolvePath(args.path)) || basename(args.path);
    process.stdout.write(`${BULLET} ${GRAY}Read${RESET}(${WHITE}${rel}${RESET})\n`);
    const out = await opReadFile(args.path, args.offset, args.limit);
    const lc  = out.split('\n').length - 1;
    process.stdout.write(`  ${TREE} ${GRAY}${lc} lines${RESET}\n`);
    return out;
  }

  if (name === 'list_dir') {
    const p = args.path ? relative(workdir, resolvePath(args.path)) || '.' : '.';
    process.stdout.write(`${BULLET} ${GRAY}ListDir${RESET}(${WHITE}${p}${RESET})\n`);
    const tree = await opListDir(args.path);
    process.stdout.write(`  ${TREE} ${GRAY}${tree.trim().split('\n').length} entries${RESET}\n`);
    return tree || '(empty)';
  }

  if (name === 'search_code') {
    process.stdout.write(`${BULLET} ${GRAY}Search${RESET}(${WHITE}${args.pattern}${RESET}${args.file_glob ? `  ${GRAY}in ${args.file_glob}${RESET}` : ''})\n`);
    const out   = await opSearchCode(args.pattern, args.path, args.file_glob);
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

  // ── Writes (auto-applied, verified) ──────────────────────────────────────────
  if (name === 'write_file') {
    const rel = relative(workdir, resolvePath(args.path)) || basename(args.path);
    const lc  = args.content.split('\n').length;
    process.stdout.write(`${BULLET} ${GREEN}Write${RESET}(${WHITE}${rel}${RESET})\n`);
    const result = await opWriteFile(args.path, args.content);
    process.stdout.write(`  ${TREE} ${GRAY}Wrote ${lc} lines${RESET}\n`);
    return result;
  }

  if (name === 'edit_file') {
    const rel      = relative(workdir, resolvePath(args.path)) || basename(args.path);
    const oldLines = args.old_string.split('\n');
    const newLines = args.new_string.split('\n');
    process.stdout.write(`${BULLET} ${ORANGE}Edit${RESET}(${WHITE}${rel}${RESET})\n`);
    const maxShow = 3;
    oldLines.slice(0, maxShow).forEach(l => process.stdout.write(`  ${RED}- ${l}${RESET}\n`));
    if (oldLines.length > maxShow) process.stdout.write(`  ${RED}  … ${oldLines.length - maxShow} more${RESET}\n`);
    newLines.slice(0, maxShow).forEach(l => process.stdout.write(`  ${GREEN}+ ${l}${RESET}\n`));
    if (newLines.length > maxShow) process.stdout.write(`  ${GREEN}  … ${newLines.length - maxShow} more${RESET}\n`);
    const result = await opEditFile(args.path, args.old_string, args.new_string);
    process.stdout.write(`  ${TREE} ${GRAY}-${oldLines.length} +${newLines.length} lines${RESET}\n`);
    return result;
  }

  // ── Batch summarizer (runs outside chat history) ──────────────────────────────
  if (name === 'summarize_files') {
    const paths = args.paths.map(p => p);
    process.stdout.write(`${BULLET} ${BLUE}SummarizeFiles${RESET}(${WHITE}${paths.length} files → ${args.output_path}${RESET})\n`);
    const result = await opSummarizeFiles(paths, args.output_path, args.title, args.subject);
    return result;
  }

  // ── PDF generation ────────────────────────────────────────────────────────────
  if (name === 'make_pdf') {
    const rel = relative(workdir, resolvePath(args.output_path)) || args.output_path;
    process.stdout.write(`${BULLET} ${BLUE}PDF${RESET}(${WHITE}${rel}${RESET})\n`);
    if (args.title) process.stdout.write(`  ${BRANCH} ${GRAY}title: ${args.title}${RESET}\n`);
    const outPath = await generatePdf(
      args.content,
      resolvePath(args.output_path),
      args.title || '',
      args.author || '',
      true,
    );
    const sizeResult = await execFileAsync('du', ['-sh', outPath]).catch(() => ({ stdout: '?' }));
    const size = sizeResult.stdout?.trim().split('\t')[0] || '?';
    process.stdout.write(`  ${TREE} ${GRAY}${size} — opened in PDF viewer${RESET}\n`);
    return `PDF created: ${outPath} (${size}). Opened in PDF viewer.`;
  }

  // ── Shell (always needs approval) ─────────────────────────────────────────────
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

// Parallel for reads, sequential for writes
async function executeTools(toolCalls) {
  const readOnly   = new Set(['web_search', 'fetch_url', 'read_file', 'list_dir', 'search_code', 'summarize_files']);
  const parallel   = toolCalls.filter(tc => readOnly.has(tc.name));
  const sequential = toolCalls.filter(tc => !readOnly.has(tc.name));
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
    role: 'tool', tool_call_id: tc.id || tc.name,
    content: results.get(tc.id || tc.name) ?? '',
  }));
}

function runShell(command) {
  return new Promise(resolve => {
    exec(command, { cwd: workdir, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const parts = [];
      if (stdout) parts.push(stdout.slice(0, 30000));
      if (stderr) parts.push(`stderr:\n${stderr.slice(0, 5000)}`);
      if (err && !stdout && !stderr) parts.push(`error: ${err.message}`);
      parts.push(`exit: ${err ? (err.code ?? 1) : 0}`);
      resolve(parts.join('\n').trim());
    });
  });
}

// ── SSE stream (Groq / Cerebras / Gemini — all OpenAI-compatible) ─────────────
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
    const m    = body.match(/try again in ([0-9.]+)s/i);
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

// ── Ollama ────────────────────────────────────────────────────────────────────
async function* streamOllama(msgs) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
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

  const usedBackend = !USE_OLLAMA_ONLY && backendIndex < OPENAI_BACKENDS.length
    ? OPENAI_BACKENDS[backendIndex] : null;
  const stream = usedBackend ? streamOpenAI(usedBackend, ctx) : streamOllama(ctx);

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
          const results = await executeTools(event.toolCalls);
          process.stdout.write('\n');
          messages.push(...results);
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
    // Try next backend on any API error (rate limit, model not found, auth, etc.)
    if (err.status && !USE_OLLAMA_ONLY && backendIndex + 1 < OPENAI_BACKENDS.length) {
      const next   = OPENAI_BACKENDS[backendIndex + 1];
      const reason = err.status === 429 ? 'rate-limited' : err.status === 404 ? 'model not found' : `error ${err.status}`;
      process.stdout.write(`  ${TREE} ${YELLOW}${usedBackend?.name} ${reason} → ${next.name}${RESET}\n`);
      return runTurn(backendIndex + 1);
    }
    const hint = err.status === 429 ? 'All backends rate-limited. Wait a moment.'
      : USE_OLLAMA_ONLY ? `Cannot reach Ollama at ${OLLAMA_URL}. Is it running?`
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
  process.stdout.write(`  ${BRANCH} ${ORANGE}/cd <path>${RESET}    ${GRAY}change working directory (shown in prompt)${RESET}\n`);
  process.stdout.write(`  ${BRANCH} ${ORANGE}/wd${RESET}           ${GRAY}print current working directory${RESET}\n`);
  process.stdout.write(`  ${BRANCH} ${ORANGE}/clear${RESET}        ${GRAY}clear conversation history${RESET}\n`);
  process.stdout.write(`  ${BRANCH} ${ORANGE}/help${RESET}         ${GRAY}show this${RESET}\n`);
  process.stdout.write(`  ${TREE}  ${ORANGE}/exit${RESET}         ${GRAY}quit${RESET}\n\n`);
}

// ── Banner ────────────────────────────────────────────────────────────────────
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
      process.stdout.write(`  ${TREE} ${GRAY}Not found: ${target}${RESET}\n\n`);
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
