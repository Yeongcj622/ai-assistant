import dotenv from 'dotenv';
import readline from 'readline';
import { exec } from 'child_process';
import { webSearch, fetchUrl } from './tools.js';

dotenv.config();

// ── Config ──────────────────────────────────────────────────────────────────
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY || '';
const CEREBRAS_MODEL   = process.env.CEREBRAS_MODEL   || 'llama-3.3-70b';
const CEREBRAS_URL     = 'https://api.cerebras.ai/v1/chat/completions';

const GROQ_API_KEY     = process.env.GROQ_API_KEY || '';
const GROQ_URL         = 'https://api.groq.com/openai/v1/chat/completions';

const OLLAMA_URL       = process.env.OLLAMA_URL   || 'http://localhost:11434';
const OLLAMA_MODEL     = process.env.OLLAMA_MODEL || 'llama3.2:3b';
const WORKDIR          = process.env.ASSISTANT_WORKDIR || process.env.HOME || process.cwd();

// Ordered fallback chain — first available wins each turn
const OPENAI_BACKENDS = [
  CEREBRAS_API_KEY && { name: 'Cerebras', label: `Cerebras/${CEREBRAS_MODEL}`, url: CEREBRAS_URL, key: CEREBRAS_API_KEY, model: CEREBRAS_MODEL },
  GROQ_API_KEY     && { name: 'Groq',     label: `Groq/llama-4-scout`,         url: GROQ_URL,     key: GROQ_API_KEY,     model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
  GROQ_API_KEY     && { name: 'Groq-8b',  label: `Groq/llama-3.1-8b`,         url: GROQ_URL,     key: GROQ_API_KEY,     model: 'llama-3.1-8b-instant' },
].filter(Boolean);
const USE_OLLAMA_ONLY = OPENAI_BACKENDS.length === 0;

// ── ANSI ────────────────────────────────────────────────────────────────────
const DIM      = '\x1b[2m';
const BOLD     = '\x1b[1m';
const ITALIC   = '\x1b[3m';
const USER_BG  = '\x1b[48;2;30;32;40m\x1b[38;2;200;210;230m';
const GREEN    = '\x1b[38;2;80;200;120m';
const ORANGE   = '\x1b[38;2;230;140;60m';
const BLUE     = '\x1b[38;2;100;160;240m';
const GRAY     = '\x1b[38;2;130;140;160m';
const WHITE    = '\x1b[38;2;220;225;240m';
const YELLOW   = '\x1b[38;2;220;190;80m';
const RESET    = '\x1b[0m';
const BULLET   = `${GREEN}●${RESET}`;
const TREE     = `${GRAY}└${RESET}`;
const PROMPT   = `${GRAY}>${RESET} `;
const APPROVAL_PROMPT = `${BOLD}Allow this command? [y/N]${RESET} `;

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for current facts, news, prices, people, events. Use proactively for anything time-sensitive or that may have changed since training.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Focused search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch full text of a web page. Use after web_search to read a specific result.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL to fetch.' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: "Run a shell command on the user's computer. Requires explicit user approval.",
      parameters: {
        type: 'object',
        properties: {
          command:     { type: 'string', description: 'Shell command to run.' },
          description: { type: 'string', description: 'Plain-English explanation of what it does.' },
        },
        required: ['command', 'description'],
      },
    },
  },
];

// ── System prompt (kept short to save tokens) ────────────────────────────────
const SYSTEM = `You are a fast, accurate personal assistant in the terminal. Today: ${new Date().toDateString()}.
Tools available: web_search(query), fetch_url(url), run_command(command, description).
Use web_search freely for current info, news, prices, or anything time-sensitive. Cite sources as [Title](URL).
Code in fenced blocks with language tag. Be concise but complete.`;

// ── State ────────────────────────────────────────────────────────────────────
const messages = [];
let pendingApproval = null;
let busy = false;
const queue = [];

// Keep context lean: only last 20 messages (10 turns) to avoid TPM limits
function buildContext() {
  const recent = messages.length > 20 ? messages.slice(-20) : messages;
  return [{ role: 'system', content: SYSTEM }, ...recent];
}

// ── Terminal helpers ──────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });

function clearLine() {
  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
}

// Render code blocks with line numbers
function renderCodeBlock(lang, code) {
  const lines  = code.replace(/\n$/, '').split('\n');
  const numW   = String(lines.length).length;
  const header = `${GRAY}${lang || 'code'}${RESET}`;
  const body   = lines.slice(0, 40).map((l, i) =>
    `  ${GRAY}${String(i + 1).padStart(numW)}${RESET}  ${WHITE}${l}${RESET}`
  ).join('\n');
  const trunc  = lines.length > 40 ? `\n  ${GRAY}… ${lines.length - 40} more lines${RESET}` : '';
  return `${header}\n${body}${trunc}`;
}

// Render assistant markdown reply
function renderReply(text) {
  const lines  = text.split('\n');
  const out    = [];
  let inCode   = false;
  let codeLang = '';
  let codeBuf  = [];

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
      .replace(/^[-*] /, `${GRAY}• ${RESET}`);
    out.push(l);
  }
  if (inCode && codeBuf.length) out.push(renderCodeBlock(codeLang, codeBuf.join('\n')));
  return out.join('\n');
}

// ── SSE stream parser ─────────────────────────────────────────────────────────
async function* sseLines(body) {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('data: ')) yield t.slice(6);
    }
  }
}

// ── OpenAI-compatible stream (Groq + Cerebras) ───────────────────────────────
async function* streamOpenAI(backend, msgs) {
  const res = await fetch(backend.url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${backend.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: backend.model, messages: msgs, stream: true,
      tools: TOOLS, tool_choice: 'auto', max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const err  = new Error(`${backend.name} ${res.status}: ${body}`);
    err.status = res.status;
    // Parse retry-after from error message if present
    const m = body.match(/try again in ([0-9.]+)s/i);
    err.retryAfter = m ? Math.ceil(parseFloat(m[1])) : 10;
    throw err;
  }

  let content = '';
  const tcMap = {};

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
    method:  'POST',
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

// ── Execute tools (parallel when possible) ───────────────────────────────────
async function executeOneTool(name, args) {
  if (name === 'web_search') {
    process.stdout.write(`${BULLET} ${ORANGE}web_search${RESET}${GRAY}(${RESET}"${args.query}"${GRAY})${RESET}\n`);
    const results = await webSearch(args.query);
    process.stdout.write(`  ${TREE} ${GRAY}${results.length} results${RESET}\n`);
    return results.map((r, i) => `[${i+1}] **${r.title}**\nURL: ${r.url}\n${r.snippet}`).join('\n\n');
  }

  if (name === 'fetch_url') {
    const short = args.url.replace(/^https?:\/\//, '').slice(0, 60);
    process.stdout.write(`${BULLET} ${ORANGE}fetch_url${RESET}${GRAY}(${RESET}${short}${GRAY})${RESET}\n`);
    const text  = await fetchUrl(args.url);
    process.stdout.write(`  ${TREE} ${GRAY}${text.split('\n').length} lines${RESET}\n`);
    return text;
  }

  if (name === 'run_command') {
    process.stdout.write(`${BULLET} ${ORANGE}run_command${RESET}${GRAY}(${RESET}${args.command}${GRAY})${RESET}\n`);
    process.stdout.write(`  ${TREE} ${GRAY}${args.description || ''}${RESET}\n`);
    rl.setPrompt(APPROVAL_PROMPT);
    rl.prompt();
    const approved = await new Promise(resolve => { pendingApproval = { resolve }; });
    rl.setPrompt(PROMPT);
    if (!approved) {
      process.stdout.write(`  ${TREE} ${GRAY}Denied${RESET}\n`);
      return '[user denied the command]';
    }
    const output  = await runShell(args.command);
    const outLines = output.trim().split('\n');
    const shown   = outLines.slice(0, 20).join('\n');
    const extra   = outLines.length > 20 ? `\n  ${GRAY}… +${outLines.length - 20} lines${RESET}` : '';
    process.stdout.write(`  ${TREE} ${GRAY}${shown}${extra}${RESET}\n`);
    return output;
  }

  throw new Error(`Unknown tool: ${name}`);
}

// Run non-interactive tools in parallel; run_command must be sequential
async function executeTools(toolCalls) {
  const interactive = toolCalls.filter(tc => tc.name === 'run_command');
  const automatic   = toolCalls.filter(tc => tc.name !== 'run_command');

  const results = new Map();

  // Parallel automatic tools
  clearLine();
  await Promise.all(automatic.map(async tc => {
    try {
      results.set(tc.id || tc.name, await executeOneTool(tc.name, tc.args));
    } catch (e) {
      process.stdout.write(`  ${TREE} ${GRAY}${tc.name} failed: ${e.message}${RESET}\n`);
      results.set(tc.id || tc.name, `Error: ${e.message}`);
    }
  }));

  // Sequential interactive tools
  for (const tc of interactive) {
    try {
      results.set(tc.id || tc.name, await executeOneTool(tc.name, tc.args));
    } catch (e) {
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
    exec(command, { cwd: WORKDIR, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const parts = [];
      if (stdout) parts.push(`stdout:\n${stdout.slice(0, 20000)}`);
      if (stderr) parts.push(`stderr:\n${stderr.slice(0, 20000)}`);
      if (err)    parts.push(`error: ${err.message}`);
      parts.push(`exit code: ${err ? (err.code ?? 1) : 0}`);
      resolve(parts.join('\n\n'));
    });
  });
}

// ── Core turn — tries backends in order, skips on 429 ────────────────────────
async function runTurn(backendIndex = 0) {
  const ctx = buildContext();

  clearLine();
  process.stdout.write(`${BULLET} ${GRAY}…${RESET}`);

  // Pick stream source
  let stream;
  let usedBackend = null;

  if (!USE_OLLAMA_ONLY && backendIndex < OPENAI_BACKENDS.length) {
    usedBackend = OPENAI_BACKENDS[backendIndex];
    try {
      stream = streamOpenAI(usedBackend, ctx);
    } catch {
      return runTurn(backendIndex + 1);
    }
  } else {
    stream = streamOllama(ctx);
  }

  let firstToken = true;
  let fullContent = '';

  try {
    for await (const event of stream) {
      if (event.type === 'token') {
        if (firstToken) {
          clearLine();
          process.stdout.write(`${BULLET} `);
          firstToken = false;
        }
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
          role: 'assistant',
          content: event.content || null,
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
        rl.prompt();
      }
    }
  } catch (err) {
    clearLine();

    // Rate limited — try next backend silently
    if (err.status === 429 && !USE_OLLAMA_ONLY && backendIndex + 1 < OPENAI_BACKENDS.length) {
      const next = OPENAI_BACKENDS[backendIndex + 1];
      process.stdout.write(`  ${TREE} ${YELLOW}${usedBackend?.name} rate-limited → trying ${next.name}${RESET}\n`);
      return runTurn(backendIndex + 1);
    }

    // All backends exhausted or different error
    const hint = USE_OLLAMA_ONLY
      ? `Could not reach Ollama at ${OLLAMA_URL}. Is it running?`
      : err.status === 429
        ? `All backends rate-limited. Wait a moment and try again.`
        : err.message;
    process.stdout.write(`${BULLET} ${GRAY}${hint}${RESET}\n\n`);
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

// Startup banner
const primaryLabel = OPENAI_BACKENDS[0]?.label ?? `Ollama/${OLLAMA_MODEL}`;
const fallbacks    = OPENAI_BACKENDS.slice(1).map(b => b.label).join(', ');
process.stdout.write(`\n${BULLET} ${WHITE}AI Assistant${RESET}  ${GRAY}${primaryLabel}${RESET}`);
if (fallbacks) process.stdout.write(`  ${GRAY}(fallback: ${fallbacks})${RESET}`);
process.stdout.write(`\n  ${TREE} ${GRAY}/clear  /exit${RESET}\n\n`);
rl.prompt();

rl.on('line', (line) => {
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
  if (text === '/clear') { messages.length = 0; process.stdout.write(`  ${TREE} ${GRAY}Conversation cleared${RESET}\n\n`); rl.prompt(); return; }
  if (text.startsWith('/system ')) { messages.unshift({ role: 'system', content: text.slice(8).trim() }); process.stdout.write(`  ${TREE} ${GRAY}System prompt set${RESET}\n\n`); rl.prompt(); return; }
  if (!text) { rl.prompt(); return; }

  messages.push({ role: 'user', content: text });
  queue.push(1);
  rl.prompt();
  processQueue();
});

rl.on('close', () => { process.stdout.write('\nBye!\n'); process.exit(0); });
