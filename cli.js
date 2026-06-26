import dotenv from 'dotenv';
import readline from 'readline';
import { exec } from 'child_process';
import { formatForTerminal, renderBox, wrapText } from './format.js';
import { webSearch, fetchUrl } from './tools.js';

dotenv.config();

// ── Config ──────────────────────────────────────────────────────────────────
const GROQ_API_KEY  = process.env.GROQ_API_KEY || '';
const GROQ_MODEL    = process.env.GROQ_MODEL    || 'llama-3.3-70b-versatile';
const GROQ_URL      = 'https://api.groq.com/openai/v1/chat/completions';
const OLLAMA_URL    = process.env.OLLAMA_URL    || 'http://localhost:11434';
let   OLLAMA_MODEL  = process.env.OLLAMA_MODEL  || 'llama3.2:3b';
const WORKDIR       = process.env.ASSISTANT_WORKDIR || process.env.HOME || process.cwd();
const USE_GROQ      = !!GROQ_API_KEY;

// ── ANSI ────────────────────────────────────────────────────────────────────
const DIM           = '\x1b[2m';
const BOLD          = '\x1b[1m';
const USER_BG       = '\x1b[48;2;214;236;255m\x1b[38;2;26;58;74m';
const USER_LABEL    = '\x1b[1;34m';
const ASST_LABEL    = '\x1b[1;35m';
const TOOL_COLOR    = '\x1b[1;36m';
const RESET         = '\x1b[0m';
const PROMPT        = `${USER_LABEL}you>${RESET} `;
const APPROVAL_PROMPT = `${BOLD}Allow this command? [y/N]${RESET} `;

// ── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS_OPENAI = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the internet for current, accurate information. Use this proactively for any factual question, current event, price, person, news, or anything that may have changed since training.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A focused search query optimised for web search.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Read the full content of a specific web page. Use this after web_search to get details from a promising result URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to fetch.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: "Run a shell command on the user's computer. This requires explicit user approval before executing.",
      parameters: {
        type: 'object',
        properties: {
          command:     { type: 'string', description: 'The exact shell command to run.' },
          description: { type: 'string', description: 'Plain-English explanation of what it does and why.' },
        },
        required: ['command', 'description'],
      },
    },
  },
];

// Ollama uses the same OpenAI format for tools.
const TOOLS_OLLAMA = TOOLS_OPENAI;

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM = `You are a fast, accurate personal assistant running in the terminal.

You have three tools:
• web_search(query)  — search DuckDuckGo for current information. Use it freely whenever a question involves facts, news, current events, prices, people, or anything time-sensitive.
• fetch_url(url)     — read the text content of any web page. Use it to follow up on a search result.
• run_command(command, description) — run a shell command (requires the user to approve each time).

Formatting rules:
- Write code in fenced code blocks with a language tag.
- Write maths using LaTeX ($..$ for inline, $$...$$ for display).
- When you use web_search, always cite sources with [Title](URL) links.
- Keep answers concise but complete. If unsure, search first.`;

// ── State ────────────────────────────────────────────────────────────────────
const messages = [];
let pendingApproval = null;
let busy = false;
const queue = [];

// ── Terminal helpers ──────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });

function printAbove(text) {
  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
  process.stdout.write(text + '\n');
  rl.prompt(true);
}

function separator() {
  const w = Math.min(process.stdout.columns || 72, 80);
  printAbove(`${DIM}${'─'.repeat(w)}${RESET}`);
}

// ── SSE stream parser (Groq / OpenAI format) ─────────────────────────────────
async function* sseLines(body) {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('data: ')) yield t.slice(6);
    }
  }
}

// ── Streaming call: yields { type:'token', text } | { type:'finish', content, toolCalls } ──
async function* streamGroq(msgs) {
  const res = await fetch(GROQ_URL, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: GROQ_MODEL, messages: msgs, stream: true, tools: TOOLS_OPENAI, tool_choice: 'auto', max_tokens: 8192 }),
  });
  if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);

  let content = '';
  const tcMap = {};

  for await (const raw of sseLines(res.body)) {
    if (raw === '[DONE]') break;
    let data; try { data = JSON.parse(raw); } catch { continue; }
    const choice = data.choices?.[0]; if (!choice) continue;
    const delta  = choice.delta       || {};

    if (delta.content) { content += delta.content; yield { type: 'token', text: delta.content }; }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!tcMap[tc.index]) tcMap[tc.index] = { id: '', name: '', args: '' };
        if (tc.id)                 tcMap[tc.index].id   = tc.id;
        if (tc.function?.name)     tcMap[tc.index].name += tc.function.name;
        if (tc.function?.arguments)tcMap[tc.index].args += tc.function.arguments;
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

async function* streamOllama(msgs) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages: msgs, stream: true, tools: TOOLS_OLLAMA }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}`);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';

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
          id:   tc.id || '',
          name: tc.function.name,
          args: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments,
        }));
        yield { type: 'finish', content, toolCalls };
      }
    }
  }
}

// ── Execute tools ─────────────────────────────────────────────────────────────
async function executeTool(name, args) {
  if (name === 'web_search') {
    printAbove(`${TOOL_COLOR}🔍 Searching:${RESET} ${DIM}${args.query}${RESET}`);
    const results = await webSearch(args.query);
    const formatted = results.map((r, i) =>
      `[${i+1}] **${r.title}**\nURL: ${r.url}\n${r.snippet}`
    ).join('\n\n');
    printAbove(`${TOOL_COLOR}✓ Got ${results.length} results${RESET}`);
    return formatted;
  }

  if (name === 'fetch_url') {
    printAbove(`${TOOL_COLOR}📄 Fetching:${RESET} ${DIM}${args.url}${RESET}`);
    const text = await fetchUrl(args.url);
    printAbove(`${TOOL_COLOR}✓ Page loaded${RESET}`);
    return text;
  }

  if (name === 'run_command') {
    const boxLines = [...wrapText(args.description || '(no description)', 70), '', args.command];
    printAbove(renderBox('Permission needed', boxLines));
    rl.setPrompt(APPROVAL_PROMPT);
    rl.prompt();
    const approved = await new Promise(resolve => { pendingApproval = { resolve }; });
    rl.setPrompt(PROMPT);
    if (!approved) { printAbove('(command denied)'); return '[user denied the command]'; }
    const output = await runShell(args.command);
    printAbove(formatForTerminal('```\n' + output + '\n```'));
    return output;
  }

  throw new Error(`Unknown tool: ${name}`);
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

// ── Core turn ─────────────────────────────────────────────────────────────────
async function runTurn() {
  const context = [{ role: 'system', content: SYSTEM }, ...messages];

  // Show thinking indicator
  if (process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
  process.stdout.write(`${ASST_LABEL}assistant>${RESET} ${DIM}▪▪▪${RESET}`);

  let firstToken = true;
  let fullContent = '';

  try {
    const stream = USE_GROQ ? streamGroq(context) : streamOllama(context);

    for await (const event of stream) {
      if (event.type === 'token') {
        if (firstToken) {
          // Replace "▪▪▪" with the actual response start
          if (process.stdout.isTTY) {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
          }
          process.stdout.write(`${ASST_LABEL}assistant>${RESET} `);
          firstToken = false;
        }
        process.stdout.write(event.text);
        fullContent += event.text;
      }

      if (event.type === 'finish') {
        if (firstToken) {
          // Never got any text — clear the indicator
          if (process.stdout.isTTY) {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
          }
        } else {
          process.stdout.write('\n');
        }

        messages.push({ role: 'assistant', content: event.content || null, tool_calls: event.toolCalls.length ? event.toolCalls.map(tc => ({
          id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) }
        })) : undefined });

        if (event.toolCalls.length > 0) {
          // Execute each tool and add results to messages
          for (const tc of event.toolCalls) {
            let result;
            try   { result = await executeTool(tc.name, tc.args); }
            catch (e) { result = `Error: ${e.message}`; printAbove(`${TOOL_COLOR}✗ ${tc.name} failed:${RESET} ${e.message}`); }

            messages.push({
              role: 'tool',
              tool_call_id: tc.id || tc.name,
              content: result,
            });
          }
          // Continue the conversation with tool results
          await runTurn();
          return;
        }

        separator();
      }
    }
  } catch (err) {
    if (process.stdout.isTTY) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); }
    const hint = USE_GROQ
      ? `Could not reach Groq. Check GROQ_API_KEY in .env. (${err.message})`
      : `Could not reach Ollama at ${OLLAMA_URL}. Is it running? (${err.message})`;
    printAbove(`${ASST_LABEL}assistant>${RESET} ${hint}`);
    separator();
  }
}

// ── Input loop ────────────────────────────────────────────────────────────────
async function processQueue() {
  if (busy || queue.length === 0) return;
  busy = true;
  while (queue.length > 0) { queue.shift(); await runTurn(); }
  busy = false;
}

const backend = USE_GROQ ? `Groq (${GROQ_MODEL})` : `Ollama (${OLLAMA_MODEL})`;
console.log(`\n${ASST_LABEL}AI Assistant${RESET} — ${DIM}${backend}${RESET}`);
console.log(`${DIM}Commands: /system <prompt>  /clear  /exit${RESET}\n`);
rl.prompt();

rl.on('line', (line) => {
  if (pendingApproval) {
    const answer = line.trim().toLowerCase();
    const resolve = pendingApproval.resolve;
    pendingApproval = null;
    resolve(answer === 'y' || answer === 'yes');
    return;
  }

  const text = line.trim();

  if (process.stdout.isTTY && text) {
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
    console.log(`${USER_BG}${BOLD}you>${RESET}${USER_BG} ${line}${RESET}`);
  }

  if (text === '/exit') { rl.close(); return; }
  if (text === '/clear') { messages.length = 0; console.log('(conversation cleared)\n'); rl.prompt(); return; }
  if (text.startsWith('/system ')) { messages.unshift({ role: 'system', content: text.slice(8).trim() }); console.log('(system prompt set)\n'); rl.prompt(); return; }
  if (!text) { rl.prompt(); return; }

  messages.push({ role: 'user', content: text });
  queue.push(1);
  rl.prompt();
  processQueue();
});

rl.on('close', () => { console.log('\nBye!'); process.exit(0); });
