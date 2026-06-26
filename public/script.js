const STORAGE_MESSAGES = 'ai-assistant-messages';
const STORAGE_SYSTEM = 'ai-assistant-system';

const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('chat-input');
const clearBtn = document.getElementById('clear-btn');

const settingsBtn = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const systemPromptInput = document.getElementById('system-prompt');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');

let messages = JSON.parse(localStorage.getItem(STORAGE_MESSAGES) || '[]');
let systemPrompt = localStorage.getItem(STORAGE_SYSTEM) || '';

const queue = [];
let busy = false;

function saveMessages() {
    localStorage.setItem(STORAGE_MESSAGES, JSON.stringify(messages));
}

function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

// --- Rendering ---

function renderMessages() {
    messagesEl.innerHTML = '';
    messages.forEach((msg, i) => {
        if (msg.hidden) return;
        appendMessageEl(msg.role, msg.content, i);
    });
    scrollToBottom();
}

function insertAfter(el, afterEl) {
    if (afterEl && afterEl.parentNode === messagesEl) {
        if (afterEl.nextSibling) messagesEl.insertBefore(el, afterEl.nextSibling);
        else messagesEl.appendChild(el);
    } else {
        messagesEl.appendChild(el);
    }
}

// msgIndex is either a number (index into `messages`) or 'pending' for an
// in-flight assistant reply.
function appendMessageEl(role, text, msgIndex, afterEl) {
    const el = document.createElement('div');
    el.className = `message ${role}`;
    if (typeof msgIndex === 'number') el.dataset.msgIndex = msgIndex;

    if (role === 'user' || role === 'error') {
        el.textContent = text;
    } else if (role === 'assistant') {
        const contentEl = document.createElement('div');
        contentEl.className = 'msg-content';

        const dot = document.createElement('span');
        dot.className = `status-dot ${msgIndex === 'pending' ? 'typing' : 'done'}`;

        el.appendChild(contentEl);
        el.appendChild(dot);

        if (msgIndex === 'pending') {
            contentEl.textContent = 'Thinking…';
        } else {
            setMessageContent(contentEl, text, { interactive: false, msgIndex });
        }
    }

    insertAfter(el, afterEl);
    return el;
}

function finalizeAssistantMessage(el, text, idx) {
    const dot = el.querySelector('.status-dot');
    dot.classList.remove('typing');
    dot.classList.add('done');
    el.dataset.msgIndex = idx;

    const contentEl = el.querySelector('.msg-content');
    setMessageContent(contentEl, text, { interactive: true, msgIndex: idx });
}

function setMessageContent(el, text, { interactive = false, msgIndex } = {}) {
    const { text: cleanText, tool } = parseToolCall(text);

    el.innerHTML = cleanText ? marked.parse(cleanText, { breaks: true }) : '';
    addCopyButtons(el);
    renderMathInElement(el, {
        delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
        ],
    });

    if (tool && interactive) {
        el.appendChild(buildToolCard(tool));
    }
}

function addCopyButtons(el) {
    el.querySelectorAll('pre').forEach((pre) => {
        const code = pre.querySelector('code');
        if (!code) return;

        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.addEventListener('click', () => {
            navigator.clipboard.writeText(code.textContent).then(() => {
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            });
        });

        pre.style.position = 'relative';
        pre.appendChild(btn);
    });
}

// --- Tool calls (the assistant asking to run a shell command) ---

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

function buildToolCard(tool) {
    const card = document.createElement('div');
    card.className = 'tool-card';

    const desc = document.createElement('div');
    desc.className = 'tool-desc';
    desc.textContent = tool.description || 'The assistant wants to run a command on your computer.';
    card.appendChild(desc);

    const codeEl = document.createElement('code');
    codeEl.textContent = tool.command;
    card.appendChild(codeEl);

    const actions = document.createElement('div');
    actions.className = 'tool-actions';

    const approveBtn = document.createElement('button');
    approveBtn.className = 'tool-approve';
    approveBtn.textContent = 'Allow';

    const denyBtn = document.createElement('button');
    denyBtn.className = 'tool-deny';
    denyBtn.textContent = 'Deny';

    actions.append(approveBtn, denyBtn);
    card.appendChild(actions);

    approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        denyBtn.disabled = true;
        approveBtn.textContent = 'Running…';

        let resultText;
        try {
            const res = await fetch('/api/run-command', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ command: tool.command }),
            });
            const data = await res.json();
            resultText = [
                data.stdout && `stdout:\n${data.stdout}`,
                data.stderr && `stderr:\n${data.stderr}`,
                data.error && `error: ${data.error}`,
                `exit code: ${data.code}`,
            ].filter(Boolean).join('\n\n');
        } catch (err) {
            resultText = `Failed to run command: ${err.message}`;
        }

        showToolResult(card, resultText);
        messages.push({ role: 'user', content: `[Result of running \`${tool.command}\`]\n${resultText}`, hidden: true });
        saveMessages();
        enqueue(messages.length - 1);
    });

    denyBtn.addEventListener('click', () => {
        approveBtn.disabled = true;
        denyBtn.disabled = true;
        showToolResult(card, 'Permission denied by user.');

        messages.push({ role: 'user', content: `[The user denied permission to run: ${tool.command}]`, hidden: true });
        saveMessages();
        enqueue(messages.length - 1);
    });

    return card;
}

function showToolResult(card, text) {
    const result = document.createElement('div');
    result.className = 'tool-result';
    const pre = document.createElement('pre');
    pre.textContent = text;
    result.appendChild(pre);
    card.appendChild(result);
}

// --- Sending / queue ---

function enqueue(idx) {
    queue.push(idx);
    processQueue();
}

async function processQueue() {
    if (busy || queue.length === 0) return;
    busy = true;

    const idx = queue.shift();
    const contextMessages = messages.slice(0, idx + 1);
    const afterEl = messagesEl.querySelector(`[data-msg-index="${idx}"]`);
    const pendingEl = appendMessageEl('assistant', '', 'pending', afterEl);
    scrollToBottom();

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: contextMessages, system: systemPrompt || undefined }),
        });
        const data = await response.json();

        if (!response.ok) {
            pendingEl.remove();
            appendMessageEl('error', data.error || 'Something went wrong.');
        } else {
            messages.push({ role: 'assistant', content: data.text });
            finalizeAssistantMessage(pendingEl, data.text, messages.length - 1);
            saveMessages();
        }
    } catch (err) {
        pendingEl.remove();
        appendMessageEl('error', err.message);
    }

    scrollToBottom();
    busy = false;
    processQueue();
}

renderMessages();

// --- Auto-resize input ---
inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
});

inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        formEl.requestSubmit();
    }
});

// --- Sending messages ---
formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;

    messages.push({ role: 'user', content: text });
    const idx = messages.length - 1;
    appendMessageEl('user', text, idx);
    saveMessages();
    scrollToBottom();

    inputEl.value = '';
    inputEl.style.height = 'auto';

    enqueue(idx);
});

// --- Clear chat ---
clearBtn.addEventListener('click', () => {
    if (!confirm('Clear the whole conversation?')) return;
    messages = [];
    queue.length = 0;
    saveMessages();
    renderMessages();
});

// --- Settings ---
settingsBtn.addEventListener('click', () => {
    systemPromptInput.value = systemPrompt;
    settingsOverlay.classList.remove('hidden');
});

settingsCancel.addEventListener('click', () => {
    settingsOverlay.classList.add('hidden');
});

settingsSave.addEventListener('click', () => {
    systemPrompt = systemPromptInput.value.trim();
    localStorage.setItem(STORAGE_SYSTEM, systemPrompt);
    settingsOverlay.classList.add('hidden');
});
