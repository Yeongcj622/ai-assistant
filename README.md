# My AI Assistant

A simple personal chat assistant powered by a local AI model via [Ollama](https://ollama.com) — no API key, no cost, runs entirely on your machine.

## Setup

1. Install [Ollama](https://ollama.com/download) and make sure it's running:
   ```
   ollama serve
   ```

2. Pull a model (e.g. Llama 3.1):
   ```
   ollama pull llama3.1
   ```

3. Install dependencies:
   ```
   npm install
   ```

4. Start the server:
   ```
   npm start
   ```

5. Open http://localhost:3300 in your browser.

## Features

- Chat with a local LLM in a simple web UI.
- Conversation history is saved in your browser (localStorage) and persists across reloads.
- Click **Settings** to set a custom personality / system prompt for the assistant.
- Click **Clear chat** to start a fresh conversation.

## Configuration

Copy `.env.example` to `.env` to override defaults:

- `OLLAMA_URL` — where Ollama is running (default `http://localhost:11434`)
- `OLLAMA_MODEL` — which model to use (default `llama3.1`; must be pulled via `ollama pull <model>`)
- `PORT` — port for this app (default `3300`)
