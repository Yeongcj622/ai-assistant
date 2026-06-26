// Converts LaTeX-style math into Unicode and pulls out fenced code blocks
// so they can be printed in their own box for easy copying.

const SYMBOLS = {
    '\\times': '×', '\\div': '÷', '\\cdot': '·', '\\pm': '±', '\\mp': '∓',
    '\\leq': '≤', '\\geq': '≥', '\\neq': '≠', '\\approx': '≈', '\\equiv': '≡',
    '\\infty': '∞', '\\to': '→', '\\rightarrow': '→', '\\leftarrow': '←',
    '\\Rightarrow': '⇒', '\\Leftarrow': '⇐', '\\leftrightarrow': '↔',
    '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\subseteq': '⊆',
    '\\cup': '∪', '\\cap': '∩', '\\forall': '∀', '\\exists': '∃',
    '\\partial': '∂', '\\nabla': '∇', '\\sum': '∑', '\\prod': '∏', '\\int': '∫',
    '\\emptyset': '∅', '\\angle': '∠', '\\perp': '⊥', '\\parallel': '∥',
    '\\degree': '°', '\\circ': '∘', '\\sim': '∼', '\\propto': '∝',
    '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ',
    '\\epsilon': 'ε', '\\zeta': 'ζ', '\\eta': 'η', '\\theta': 'θ',
    '\\iota': 'ι', '\\kappa': 'κ', '\\lambda': 'λ', '\\mu': 'μ',
    '\\nu': 'ν', '\\xi': 'ξ', '\\pi': 'π', '\\rho': 'ρ', '\\sigma': 'σ',
    '\\tau': 'τ', '\\upsilon': 'υ', '\\phi': 'φ', '\\chi': 'χ', '\\psi': 'ψ',
    '\\omega': 'ω',
    '\\Gamma': 'Γ', '\\Delta': 'Δ', '\\Theta': 'Θ', '\\Lambda': 'Λ',
    '\\Xi': 'Ξ', '\\Pi': 'Π', '\\Sigma': 'Σ', '\\Phi': 'Φ', '\\Psi': 'Ψ',
    '\\Omega': 'Ω',
};

const SUPERSCRIPT = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
    '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽',
    ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ', 'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵃ',
    'e': 'ᵉ', 'f': 'ᶠ', 'g': 'ᵍ', 'h': 'ʰ', 'j': 'ʲ', 'k': 'ᵏ', 'l': 'ˡ',
    'm': 'ᵃ', 'o': 'ᵒ', 'p': 'ᵃ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵃ', 'u': 'ᵘ',
    'v': 'ᵃ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ',
};

const SUBSCRIPT = {
    '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
    '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍',
    ')': '₍', 'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ', 'k': 'ₖ',
    'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ',
    't': 'ₜ', 'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ',
};

function toScript(content, map) {
    let out = '';
    for (const ch of content) {
        const mapped = map[ch.toLowerCase()];
        if (!mapped) return null;
        out += mapped;
    }
    return out;
}

// Replaces ^{...}, ^x, _{...}, _x with Unicode super/subscripts where possible,
// otherwise falls back to ^(...) / _(...).
function applyScripts(s) {
    s = s.replace(/([\^_])\{([^{}]*)\}/g, (match, kind, content) => {
        const map = kind === '^' ? SUPERSCRIPT : SUBSCRIPT;
        const converted = toScript(content, map);
        return converted !== null ? converted : `${kind === '^' ? '^' : '_'}(${content})`;
    });

    s = s.replace(/([\^_])([0-9a-zA-Z+\-=()])/g, (match, kind, content) => {
        const map = kind === '^' ? SUPERSCRIPT : SUBSCRIPT;
        const converted = toScript(content, map);
        return converted !== null ? converted : match;
    });

    return s;
}

// Repeatedly expands \sqrt{...} / \sqrt[n]{...} and \frac{a}{b} since they
// can be nested.
function expandStructures(s) {
    let prev;
    do {
        prev = s;
        s = s.replace(/\\sqrt\[([^[\]]*)\]\{([^{}]*)\}/g, (m, index, body) => {
            const sup = toScript(index, SUPERSCRIPT) ?? `^(${index})`;
            return `${sup}√(${body})`;
        });
        s = s.replace(/\\sqrt\{([^{}]*)\}/g, (m, body) => `√(${body})`);
        s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (m, a, b) => `(${a})/(${b})`);
        s = s.replace(/\\text\{([^{}]*)\}/g, (m, body) => body);
        s = s.replace(/\\left|\\right/g, '');
    } while (s !== prev);

    return s;
}

function latexToUnicode(s) {
    s = expandStructures(s);

    for (const [cmd, symbol] of Object.entries(SYMBOLS)) {
        s = s.split(cmd).join(symbol);
    }

    s = applyScripts(s);
    s = s.replace(/\\,|\\!|\\;|\\:/g, '');
    s = s.replace(/\s+/g, ' ').trim();

    return s;
}

// Converts $$...$$, $...$, \[...\] and \(...\) math segments in `text` to
// Unicode notation, leaving everything else untouched.
function convertMath(text) {
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (m, body) => `\n${latexToUnicode(body)}\n`);
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, (m, body) => `\n${latexToUnicode(body)}\n`);
    text = text.replace(/\$([^$\n]+?)\$/g, (m, body) => latexToUnicode(body));
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, (m, body) => latexToUnicode(body));
    return text;
}

// ANSI styling for markdown, similar to how this chat renders **bold**,
// headers, and lists.
const BOLD = '\x1b[1m';
const ITALIC = '\x1b[3m';
const DIM = '\x1b[2m';
const HEADER = '\x1b[1;36m';
const INLINE_CODE = '\x1b[33m';
const RESET = '\x1b[0m';

// Converts common inline/block markdown (headers, bullet/numbered lists,
// bold, italics, inline code) to ANSI-styled terminal text.
function applyMarkdownStyling(text) {
    const lines = text.split('\n').map((line) => {
        const header = line.match(/^(#{1,6})\s+(.*)$/);
        if (header) return `${HEADER}${header[2]}${RESET}`;

        const numbered = line.match(/^(\s*)(\d+)([.)])\s+(.*)$/);
        if (numbered) return `${numbered[1]}${BOLD}${numbered[2]}${numbered[3]}${RESET} ${numbered[4]}`;

        const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
        if (bullet) return `${bullet[1]}${DIM}•${RESET} ${bullet[2]}`;

        return line;
    });

    let result = lines.join('\n');
    result = result.replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${RESET}`);
    result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, `${ITALIC}$1${RESET}`);
    result = result.replace(/(?<!_)_([^_\n]+)_(?!_)/g, `${ITALIC}$1${RESET}`);
    result = result.replace(/`([^`\n]+)`/g, `${INLINE_CODE}$1${RESET}`);

    return result;
}

const BOX_WIDTH = Math.min(process.stdout.columns || 80, 100);

// Draws a bordered box with a labelled top edge around `lines` of plain text.
export function renderBox(title, lines) {
    const width = Math.max(
        BOX_WIDTH,
        ...lines.map((l) => l.length + 4),
        title.length + 5
    );

    const top = `┌─ ${title} ${'─'.repeat(Math.max(0, width - title.length - 5))}┐`;
    const bottom = `└${'─'.repeat(width - 2)}┘`;
    const body = lines.map((l) => `│ ${l.padEnd(width - 4)} │`).join('\n');

    return `${top}\n${body}\n${bottom}`;
}

// Breaks `text` into lines no longer than `width`, splitting on whitespace.
export function wrapText(text, width) {
    const words = text.split(/\s+/);
    const lines = [];
    let current = '';

    for (const word of words) {
        if (current && (current.length + 1 + word.length) > width) {
            lines.push(current);
            current = word;
        } else {
            current = current ? `${current} ${word}` : word;
        }
    }
    if (current) lines.push(current);

    return lines;
}

function renderCodeBox(lang, code) {
    const lines = code.replace(/\n$/, '').split('\n');
    return renderBox(lang || 'code', lines);
}

// Splits `text` on fenced code blocks, converts math in the prose parts to
// Unicode, and renders code blocks in boxes that are easy to select and copy.
export function formatForTerminal(text) {
    const parts = [];
    const codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRe.exec(text)) !== null) {
        const prose = text.slice(lastIndex, match.index);
        if (prose.trim()) parts.push(applyMarkdownStyling(convertMath(prose)).trim());

        const [, lang, code] = match;
        parts.push(renderCodeBox(lang, code));
        lastIndex = codeBlockRe.lastIndex;
    }

    const rest = text.slice(lastIndex);
    if (rest.trim()) parts.push(applyMarkdownStyling(convertMath(rest)).trim());

    return parts.join('\n\n');
}
