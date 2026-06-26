import dotenv from 'dotenv';
import readline from 'readline';
import { exec } from 'child_process';
import { formatForTerminal, renderBox, wrapText } from './format.js';
import { FORMAT_INSTRUCTIONS } from './instructions.js';

dotenv.config();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
let MODEL = process.env.OLLAMA_MODEL || 'llama3.1';
const WORKDIR = process.env.ASSISTANT_WORKDIR || process.env.HOME || process.cwd();

let systemPrompt = process.env.SYSTEM_PROMPT || '';
const messages = [];

// Light-blue background for the lines the user typed, to match the web app.
const USER_BG = '\x1b[48;2;214;236;255m\x1b[38;2;26;58;74m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const USER_LABEL = '\x1b[1;34m'; // bold blue
const ASSISTANT_LABEL = '\x1b[1;35m'; // bold magenta
const RESET = '\x1b[0m';

const PROMPT = `${USER_LABEL}you>${RESET} `;
const APPROVAL_PROMPT = `${BOLD}Allow this command? [y/N]${RESET} `;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });

const queue = [];
let busy = false;
let pendingApproval = null;

console.log(`AI assistant (${MODEL}) — type your message and press enter.`);
console.log('You can keep typing while it replies; messages are queued and answered in order.');
console.log('Commands: /system <prompt>, /model <name>, /clear, /exit\n');

rl.prompt();

// Clears the current prompt line, prints `text` above it, then redraws the
// prompt (with whatever the user has typed so far) underneath.
function printAbove(text) {
    if (process.stdout.isTTY) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
    }
    process.stdout.write(text + '\n');
    rl.prompt(true);
}

function separator() {
    const width = Math.min(process.stdout.columns || 60, 80);
    console.log(`${DIM}${'─'.repeat(width)}${RESET}`);
}

rl.on('line', (line) => {
    if (pendingApproval) {
        const answer = line.trim().toLowerCase();
        const resolve = pendingApproval.resolve;
        pendingApproval = null;
        resolve(answer === 'y' || answer === 'yes');
        return;
    }

    const text = line.trim();

    // Repaint the line that was just submitted with a background colour.
    if (process.stdout.isTTY && text) {
        readline.moveCursor(process.stdout, 0, -1);
        readline.clearLine(process.stdout, 0);
        console.log(`${USER_BG}${BOLD}you>${RESET}${USER_BG} ${line}${RESET}`);
    }

    if (text === '/exit') {
        rl.close();
        return;
    }

    if (text === '/clear') {
        messages.length = 0;
        console.log('(conversation cleared)\n');
        rl.prompt();
        return;
    }

    if (text.startsWith('/system ')) {
        systemPrompt = text.slice('/system '.length).trim();
        console.log('(system prompt set)\n');
        rl.prompt();
        return;
    }

    if (text.startsWith('/model ')) {
        MODEL = text.slice('/model '.length).trim();
        console.log(`(model set to ${MODEL})\n`);
        rl.prompt();
        return;
    }

    if (!text) {
        rl.prompt();
        return;
    }

    messages.push({ role: 'user', content: text });
    queue.push(messages.length - 1);
    rl.prompt();
    processQueue();
});

async function processQueue() {
    if (busy || queue.length === 0) return;
    busy = true;

    const idx = queue.shift();
    await runTurn(idx);

    busy = false;
    processQueue();
}

// Sends the conversation up to `idx` to Ollama, prints the reply, and — if
// the assistant proposed a command — asks for permission, runs it, and loops
// again with the result so the assistant can continue.
async function runTurn(idx) {
    const contextMessages = messages.slice(0, idx + 1);
    const systemContent = systemPrompt ? `${systemPrompt}\n\n${FORMAT_INSTRUCTIONS}` : FORMAT_INSTRUCTIONS;
    const ollamaMessages = [{ role: 'system', content: systemContent }, ...contextMessages];

    printAbove(`${ASSISTANT_LABEL}assistant>${RESET} ${DIM}(thinking...)${RESET}`);

    let reply;
    try {
        const response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: MODEL, messages: ollamaMessages, stream: false }),
        });

        const data = await response.json();

        if (!response.ok) {
            printAbove(data.error || 'Request to Ollama failed');
            return;
        }

        reply = data.message?.content || '';
    } catch (err) {
        printAbove(`Could not reach Ollama at ${OLLAMA_URL}. Is it installed and running? (${err.message})`);
        return;
    }

    const { text: cleanText, tool } = parseToolCall(reply);
    printAbove(`${ASSISTANT_LABEL}assistant>${RESET} ${formatForTerminal(cleanText)}`);
    messages.push({ role: 'assistant', content: reply });
    separator();

    if (tool) {
        await handleTool(tool);
    }
}

function parseToolCall(text) {
    const match = text.match(/```tool\s*\n([\s\S]*?)```/);
    if (!match) return { text, tool: null };

    let tool = null;
    try {
        const parsed = JSON.parse(match[1]);
        if (parsed && typeof parsed.command === 'string') tool = parsed;
    } catch {
        tool = null;
    }

    const cleanText = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
    return { text: cleanText, tool };
}

async function handleTool(tool) {
    const description = tool.description || '(no description given)';
    const boxLines = [...wrapText(description, 70), '', tool.command];
    printAbove(renderBox('Permission needed', boxLines));

    rl.setPrompt(APPROVAL_PROMPT);
    rl.prompt();

    const approved = await new Promise((resolve) => {
        pendingApproval = { resolve };
    });

    rl.setPrompt(PROMPT);

    let resultMessage;
    if (approved) {
        const result = await runCommand(tool.command);
        printAbove(formatForTerminal('```\n' + result + '\n```'));
        resultMessage = `[Result of running \`${tool.command}\`]\n${result}`;
    } else {
        printAbove('(command denied)');
        resultMessage = `[The user denied permission to run: ${tool.command}]`;
    }

    messages.push({ role: 'user', content: resultMessage });
    await runTurn(messages.length - 1);
}

function runCommand(command) {
    return new Promise((resolve) => {
        exec(command, { cwd: WORKDIR, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
            const parts = [];
            if (stdout) parts.push(`stdout:\n${stdout.slice(0, 20000)}`);
            if (stderr) parts.push(`stderr:\n${stderr.slice(0, 20000)}`);
            if (err) parts.push(`error: ${err.message}`);
            parts.push(`exit code: ${err ? (err.code ?? 1) : 0}`);
            resolve(parts.join('\n\n'));
        });
    });
}

rl.on('close', () => {
    console.log('\nBye!');
    process.exit(0);
});
