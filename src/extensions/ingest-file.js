/**
 * File Ingestion Extension — PDF, markdown, text, and code file ingestion.
 *
 * Handles:
 * - PDF text extraction (unpdf → pdf-parse → OCR fallback via Playwright + tesseract.js)
 * - Document chunking (markdown by headings, code by boundaries, plain text by paragraphs)
 *
 * Usage: import { extractPdfText, chunkDocument } from './ingest-file.js'
 */
import { writeFile, unlink } from "node:fs/promises";
import { join, extname } from "node:path";

// ============================================================
// PDF TEXT EXTRACTION
// ============================================================

/**
 * Extract text from a PDF buffer. Tries multiple strategies:
 * 1. unpdf (modern pdf.js wrapper)
 * 2. pdf-parse (fallback)
 * 3. OCR via Playwright (for scanned/image-only PDFs)
 *
 * @param {Buffer} buffer - raw PDF file buffer
 * @param {object} [opts] - { getBrowser, dataDir } for OCR fallback
 * @returns {Promise<string>} extracted text
 */
export async function extractPdfText(buffer, opts = {}) {
  let text = '';

  // Strategy 1: unpdf
  try {
    const { extractText } = await import('unpdf');
    const result = await extractText(new Uint8Array(buffer));
    // unpdf returns { text: string | string[], totalPages: number }
    let extracted = '';
    if (Array.isArray(result.text)) {
      extracted = result.text.join('\n\n');
    } else if (typeof result.text === 'string') {
      extracted = result.text;
    }
    if (extracted.trim().length > 100) return extracted;
  } catch (err) {
    // extractor failed — fall through to the next strategy
  }

  // Strategy 2: pdf-parse
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const pdfParseFn = require("pdf-parse");
    const data = await pdfParseFn(buffer);
    text = data.text || '';
    if (text.trim().length > 100) return text;
  } catch (err) {
    // extractor failed — fall through to OCR
  }

  // Strategy 3: OCR all pages via Playwright + tesseract.js
  if (opts.dataDir) {
    try {
      text = await ocrAllPages(buffer, opts);
      if (text.trim().length > 50) return text;
    } catch (err) {
      // OCR failed — return whatever text we have
    }
  }

  return text;
}

/**
 * OCR all pages of a PDF by rendering in Chrome and running tesseract.js.
 * Follows Playwright safety rules: launch → use → browser.close() in finally.
 * Serves the PDF via a temp HTTP server since Chromium won't render file:// PDFs.
 */
async function ocrAllPages(buffer, opts) {
  const { chromium } = await import('playwright');
  const { createWorker } = await import('tesseract.js');
  const { createServer } = await import('node:http');

  // Spin up a tiny temp HTTP server to serve the PDF to Chrome
  const pdfServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buffer.length });
    res.end(buffer);
  });
  await new Promise(resolve => pdfServer.listen(0, '127.0.0.1', resolve));
  const pdfPort = pdfServer.address().port;
  const pdfUrl = `http://127.0.0.1:${pdfPort}/doc.pdf`;

  let browser;
  const allText = [];

  try {
    browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);

    await page.goto(pdfUrl, { waitUntil: 'networkidle', timeout: 20000 });
    await new Promise(r => setTimeout(r, 3000));

    const worker = await createWorker('eng');
    let emptyStreak = 0;

    for (let i = 0; i < 100; i++) {
      const screenshot = await page.screenshot({ type: 'png' });
      const { data: { text } } = await worker.recognize(screenshot);

      if (text && text.trim().length > 20) {
        allText.push(text.trim());
        emptyStreak = 0;
      } else {
        emptyStreak++;
        if (emptyStreak >= 3) break;
      }

      await page.keyboard.press('PageDown');
      await new Promise(r => setTimeout(r, 600));
    }

    await worker.terminate();
  } finally {
    if (browser) await browser.close();
    pdfServer.close();
  }

  return allText.join('\n\n---\n\n');
}

// ============================================================
// DOCUMENT CHUNKING
// ============================================================

/**
 * Chunk any document into node-sized pieces.
 * Detects markdown vs code vs plain text automatically.
 *
 * @param {string} text - document content
 * @param {string} filename - file name/path (for context + type detection)
 * @returns {Array<{heading: string, content: string}>}
 */
export function chunkDocument(text, filename = '') {
  const ext = extname(filename).toLowerCase();
  const hasHeadings = /^#{1,3}\s+/m.test(text);

  if (hasHeadings || ext === '.md' || ext === '.txt' || ext === '.rst') {
    return chunkMarkdown(text, filename);
  } else if (isCodeExt(ext)) {
    return chunkCode(text, filename);
  } else {
    return chunkPlainText(text, filename);
  }
}

function isCodeExt(ext) {
  return ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rs', '.go',
    '.java', '.c', '.cpp', '.h', '.hpp', '.rb', '.php', '.swift', '.kt',
    '.scala', '.zig', '.css', '.scss', '.html', '.svelte', '.vue', '.astro',
    '.sh', '.bash', '.sql', '.graphql', '.proto', '.yaml', '.yml', '.toml',
    '.json'].includes(ext);
}

function chunkMarkdown(text, filename) {
  const lines = text.split('\n');
  const sections = [];
  let currentHeading = filename || 'Introduction';
  let currentContent = [];

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      if (currentContent.length > 0) {
        const content = currentContent.join('\n').trim();
        if (content.length > 30) {
          sections.push({ heading: currentHeading, content });
        }
      }
      currentHeading = line.replace(/^#+\s*/, '');
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0) {
    const content = currentContent.join('\n').trim();
    if (content.length > 30) {
      sections.push({ heading: currentHeading, content });
    }
  }

  return subChunkSections(sections);
}

function chunkCode(text, filename) {
  const lines = text.split('\n');
  const chunks = [];
  let currentChunk = [];
  let chunkIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    currentChunk.push(lines[i]);

    const atBoundary = lines[i].trim() === '' && currentChunk.length >= 40;
    const atCap = currentChunk.length >= 80;

    if (atBoundary || atCap || i === lines.length - 1) {
      const content = currentChunk.join('\n').trim();
      if (content.length > 30) {
        chunkIdx++;
        chunks.push({
          heading: filename + (chunkIdx > 1 ? ' (part ' + chunkIdx + ')' : ''),
          content: content
        });
      }
      currentChunk = [];
    }
  }

  return chunks;
}

function chunkPlainText(text, filename) {
  const paragraphs = text.split(/\n\s*\n+/);
  const chunks = [];
  let currentChunk = '';
  let chunkIdx = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (currentChunk.length + trimmed.length > 1500 && currentChunk.length > 100) {
      chunkIdx++;
      chunks.push({
        heading: filename + (chunkIdx > 1 ? ' (part ' + chunkIdx + ')' : ''),
        content: currentChunk.trim()
      });
      currentChunk = trimmed;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + trimmed;
    }
  }

  if (currentChunk.trim().length > 30) {
    chunkIdx++;
    chunks.push({
      heading: filename + (chunkIdx > 1 ? ' (part ' + chunkIdx + ')' : ''),
      content: currentChunk.trim()
    });
  }

  return chunks;
}

function subChunkSections(sections) {
  const chunks = [];

  for (const section of sections) {
    if (section.content.length <= 2000) {
      chunks.push(section);
    } else {
      const paragraphs = section.content.split(/\n\n+/);
      let currentChunk = '';
      let chunkIdx = 0;

      for (const para of paragraphs) {
        if (currentChunk.length + para.length > 2000 && currentChunk.length > 100) {
          chunkIdx++;
          chunks.push({
            heading: section.heading + (chunkIdx > 1 ? ' (part ' + chunkIdx + ')' : ''),
            content: currentChunk.trim()
          });
          currentChunk = para;
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + para;
        }
      }

      if (currentChunk.trim().length > 30) {
        chunkIdx++;
        chunks.push({
          heading: section.heading + (chunkIdx > 1 ? ' (part ' + chunkIdx + ')' : ''),
          content: currentChunk.trim()
        });
      }
    }
  }

  return chunks;
}
