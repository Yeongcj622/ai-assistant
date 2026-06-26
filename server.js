import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { FORMAT_INSTRUCTIONS } from './instructions.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'llama3.1';
const PORT = process.env.PORT || 3300;
const WORKDIR = process.env.ASSISTANT_WORKDIR || process.env.HOME || process.cwd();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/chat', async (req, res) => {
    const { messages, system } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: 'messages must be a non-empty array' });
        return;
    }

    const systemContent = system ? `${system}\n\n${FORMAT_INSTRUCTIONS}` : FORMAT_INSTRUCTIONS;
    const ollamaMessages = [{ role: 'system', content: systemContent }, ...messages];

    try {
        const response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: MODEL, messages: ollamaMessages, stream: false }),
        });

        const data = await response.json();

        if (!response.ok) {
            res.status(response.status).json({ error: data.error || 'Request to Ollama failed' });
            return;
        }

        res.json({ text: data.message?.content || '' });
    } catch (err) {
        res.status(500).json({ error: `Could not reach Ollama at ${OLLAMA_URL}. Is it installed and running? (${err.message})` });
    }
});

app.post('/api/run-command', (req, res) => {
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
        res.status(400).json({ error: 'command must be a non-empty string' });
        return;
    }

    exec(command, { cwd: WORKDIR, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        res.json({
            stdout: stdout.slice(0, 20000),
            stderr: stderr.slice(0, 20000),
            error: err ? err.message : null,
            code: err ? (err.code ?? 1) : 0,
        });
    });
});

app.listen(PORT, () => {
    console.log(`AI assistant running at http://localhost:${PORT}`);
});
