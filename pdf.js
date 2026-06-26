import { writeFile, unlink } from 'fs/promises';
import { execFile, exec } from 'child_process';
import { existsSync } from 'fs';

// ── Markdown → HTML (no dependencies) ────────────────────────────────────────
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g,   '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g,       '<em>$1</em>')
    .replace(/`([^`]+)`/g,         '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

export function markdownToHtml(md) {
  const lines  = md.split('\n');
  let html     = '';
  let inCode   = false;
  let codeLang = '';
  let codeBuf  = [];
  let inUl     = false;
  let inOl     = false;
  let inTable  = false;
  let tableHead = true;

  const closeList  = () => { if (inUl) { html += '</ul>\n'; inUl = false; } if (inOl) { html += '</ol>\n'; inOl = false; } };
  const closeTable = () => { if (inTable) { html += '</tbody></table>\n'; inTable = false; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code blocks
    if (!inCode && line.startsWith('```')) {
      closeList(); closeTable();
      inCode = true; codeLang = line.slice(3).trim(); codeBuf = [];
      continue;
    }
    if (inCode) {
      if (line.startsWith('```')) {
        const escaped = codeBuf.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html += `<pre><code class="lang-${escapeHtml(codeLang)}">${escaped}</code></pre>\n`;
        inCode = false; codeBuf = [];
      } else { codeBuf.push(line); }
      continue;
    }

    // Tables (| col | col |)
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      const isSep = cells.every(c => /^[-:]+$/.test(c));
      if (isSep) { tableHead = false; continue; }
      if (!inTable) {
        closeList();
        html += '<table><thead><tr>';
        cells.forEach(c => { html += `<th>${inline(c)}</th>`; });
        html += '</tr></thead><tbody>\n';
        inTable = true; tableHead = false;
      } else {
        html += '<tr>';
        cells.forEach(c => { html += `<td>${inline(c)}</td>`; });
        html += '</tr>\n';
      }
      continue;
    } else { closeTable(); }

    // Headings
    const h = line.match(/^(#{1,6}) (.+)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>\n`;
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) { closeList(); html += '<hr>\n'; continue; }

    // Blockquote
    if (line.startsWith('> ')) {
      closeList();
      html += `<blockquote>${inline(line.slice(2))}</blockquote>\n`;
      continue;
    }

    // Unordered list
    if (/^(\s*)[-*+] /.test(line)) {
      if (!inUl) { closeTable(); html += '<ul>\n'; inUl = true; }
      const text = line.replace(/^\s*[-*+] /, '');
      html += `<li>${inline(text)}</li>\n`;
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      if (!inOl) { closeTable(); html += '<ol>\n'; inOl = true; }
      html += `<li>${inline(line.replace(/^\d+\. /, ''))}</li>\n`;
      continue;
    }

    // Empty line
    if (line.trim() === '') { closeList(); closeTable(); html += '\n'; continue; }

    // Paragraph
    closeList(); closeTable();
    html += `<p>${inline(line)}</p>\n`;
  }

  closeList(); closeTable();
  if (inCode && codeBuf.length) {
    const escaped = codeBuf.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    html += `<pre><code>${escaped}</code></pre>\n`;
  }
  return html;
}

// ── Full HTML document with print-optimised CSS ───────────────────────────────
export function buildHtmlDoc(markdown, title = '', author = '') {
  const body = markdownToHtml(markdown);
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const titleBlock = title
    ? `<div class="cover"><h1 class="doc-title">${escapeHtml(title)}</h1>${author ? `<div class="author">${escapeHtml(author)}</div>` : ''}<div class="date">${date}</div></div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title || 'Document')}</title>
<style>
@page { margin: 2.5cm 3cm; size: A4; }
* { box-sizing: border-box; }
body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.7; color: #1a1a1a; max-width: 100%; margin: 0; padding: 0; }
.cover { text-align: center; margin-bottom: 3em; padding-bottom: 2em; border-bottom: 2px solid #1a1a2e; }
.doc-title { font-size: 2.1em; color: #1a1a2e; margin: 0 0 0.3em; border: none; }
.author { font-size: 1em; color: #555; margin: 0.2em 0; }
.date { font-size: 0.9em; color: #777; margin-top: 0.4em; }
h1 { font-size: 1.8em; color: #1a1a2e; border-bottom: 2px solid #1a1a2e; padding-bottom: 0.25em; margin: 1.6em 0 0.6em; page-break-after: avoid; }
h2 { font-size: 1.35em; color: #16213e; border-bottom: 1px solid #ccc; padding-bottom: 0.15em; margin: 1.4em 0 0.5em; page-break-after: avoid; }
h3 { font-size: 1.12em; color: #16213e; margin: 1.2em 0 0.4em; page-break-after: avoid; }
h4 { font-size: 1em; font-weight: bold; color: #333; margin: 1em 0 0.3em; }
h5, h6 { font-size: 0.95em; font-weight: bold; color: #555; margin: 0.8em 0 0.3em; }
p { margin: 0.6em 0; }
code { background: #f0f0f8; padding: 0.08em 0.35em; border-radius: 3px; font-family: 'Courier New', Courier, monospace; font-size: 0.87em; color: #2d2d6e; }
pre { background: #f5f5ff; padding: 1em 1.2em; border-radius: 6px; border-left: 4px solid #5b6fff; margin: 1.2em 0; overflow-x: auto; page-break-inside: avoid; }
pre code { background: none; padding: 0; color: #1a1a3e; font-size: 0.85em; }
blockquote { border-left: 4px solid #5b6fff; margin: 1em 0; padding: 0.6em 1.2em; color: #444; background: #f5f5ff; border-radius: 0 4px 4px 0; page-break-inside: avoid; }
blockquote p { margin: 0; }
a { color: #3a6fc4; text-decoration: underline; }
ul, ol { padding-left: 1.8em; margin: 0.6em 0; }
li { margin: 0.25em 0; }
li p { margin: 0; }
hr { border: none; border-top: 1.5px solid #ddd; margin: 2em 0; }
table { border-collapse: collapse; width: 100%; margin: 1.2em 0; page-break-inside: avoid; font-size: 0.95em; }
th { background: #1a1a2e; color: #fff; font-weight: 600; text-align: left; padding: 0.5em 0.8em; }
td { border: 1px solid #ccc; padding: 0.45em 0.8em; }
tr:nth-child(even) td { background: #f7f7f9; }
img { max-width: 100%; height: auto; }
</style>
</head>
<body>
${titleBlock}
${body}
</body>
</html>`;
}

// ── PDF generation via Chrome headless ───────────────────────────────────────
export async function generatePdf(markdown, outputPath, title = '', author = '', openAfter = true) {
  const tmpHtml = outputPath.replace(/\.pdf$/i, '') + '.tmp.html';

  const html = buildHtmlDoc(markdown, title, author);
  await writeFile(tmpHtml, html, 'utf8');

  const absHtml = tmpHtml.startsWith('/') ? tmpHtml : `${process.cwd()}/${tmpHtml}`;
  const absOut  = outputPath.startsWith('/') ? outputPath : `${process.cwd()}/${outputPath}`;

  const chrome = [
    'google-chrome', 'chromium-browser', 'chromium',
  ].find(cmd => {
    try { execFile(cmd, ['--version']); return true; } catch { return false; }
  }) || 'google-chrome';

  const args = [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-pdf-header-footer',
    '--run-all-compositor-stages-before-draw',
    `--print-to-pdf=${absOut}`,
    `file://${absHtml}`,
  ];

  await new Promise((resolve, reject) => {
    execFile(chrome, args, { timeout: 30000 }, async (err, _stdout, stderr) => {
      try { await unlink(tmpHtml); } catch {}
      if (err && !existsSync(absOut)) {
        reject(new Error(`PDF failed: ${stderr?.slice(0, 300) || err.message}`));
      } else {
        resolve();
      }
    });
  });

  if (openAfter) exec(`xdg-open "${absOut}" 2>/dev/null &`);
  return absOut;
}
