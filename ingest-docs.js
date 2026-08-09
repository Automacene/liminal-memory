/**
 * One-time ingestion script — chunks reference docs into Liminal Memory nodes.
 * Run: node ingest-docs.js
 * Then start serve.js and the demo will restore these nodes.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { LiminalMemory } from './src/index.js';

const DOCS = [
  {
    path: 'agents/liminal-memory-reference.md',
    prefix: '[Reference]',
    // Include all sections — this is the system's self-knowledge
    filter: null
  },
  {
    path: 'agents/reasoning_loop_summary.md',
    prefix: '[Architecture]',
    // Only include actionable sections, skip philosophical spiral
    filter: (heading) => {
      const skip = [
        'Continuation',
        'Phase 12: Philosophical',
        'Phase 13: Convergence on Incompleteness',
        'Phase 14:',
        'Phase 15:',
        'Phase 16:',
        'Unresolved Architectural Tensions',
        'Nodes 172',
        'Nodes 173',
        'Nodes 174',
        'Nodes 175',
        'Nodes 176',
        'Nodes 182',
        'Nodes 184',
        'Nodes 193',
        'Nodes 201',
        'Nodes 205',
        'Nodes 231'
      ];
      return !skip.some(s => heading.includes(s));
    }
  }
];

/**
 * Split a markdown document into chunks by ## headings,
 * then further split large sections by paragraph breaks.
 * Returns array of { heading, content } objects.
 */
function chunkByHeadings(text) {
  const lines = text.split('\n');
  const sections = [];
  let currentHeading = '';
  let currentContent = [];

  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('### ')) {
      if (currentContent.length > 0) {
        const content = currentContent.join('\n').trim();
        if (content.length > 50) {
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
    if (content.length > 50) {
      sections.push({ heading: currentHeading, content });
    }
  }

  // Now split large sections into paragraph-level chunks
  const chunks = [];
  for (const section of sections) {
    if (section.content.length <= 2000) {
      // Small enough — keep as one chunk
      chunks.push(section);
    } else {
      // Split by double-newline (paragraph boundaries)
      const paragraphs = section.content.split(/\n\n+/);
      let currentChunk = '';
      let chunkIdx = 0;

      for (const para of paragraphs) {
        if (currentChunk.length + para.length > 2000 && currentChunk.length > 100) {
          // Save current chunk
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

      // Last chunk
      if (currentChunk.trim().length > 50) {
        chunkIdx++;
        chunks.push({
          heading: section.heading + (chunkIdx > 1 ? ' (part ' + (chunkIdx) + ')' : ''),
          content: currentChunk.trim()
        });
      }
    }
  }

  return chunks;
}

async function main() {
  console.log('=== Liminal Memory Document Ingestion ===\n');

  const memory = new LiminalMemory({});
  await memory.init();

  let totalNodes = 0;

  for (const doc of DOCS) {
    console.log(`\nProcessing: ${doc.path}`);
    const text = await readFile(doc.path, 'utf8');
    const chunks = chunkByHeadings(text);
    console.log(`  Found ${chunks.length} sections`);

    let ingested = 0;
    for (const chunk of chunks) {
      // Apply filter if defined
      if (doc.filter && !doc.filter(chunk.heading)) {
        continue;
      }

      // Store full content — no truncation
      const nodeContent = `${doc.prefix} ${chunk.heading}\n${chunk.content}`;

      const node = memory.chain.append('system', nodeContent);
      memory.bm25.add(node);
      ingested++;
    }

    console.log(`  Ingested ${ingested} sections as nodes`);
    totalNodes += ingested;
  }

  // Also ingest the demo fixture conversation (the knowledge base about how to USE Liminal)
  console.log(`\nProcessing: demo/fixtures/knowledge-base.js`);
  const fixtureText = await readFile('demo/fixtures/knowledge-base.js', 'utf8');
  // Extract the conversation array — it's an export
  const { demoConversation } = await import('./demo/fixtures/knowledge-base.js');
  let fixtureCount = 0;
  for (let i = 0; i < demoConversation.length - 1; i += 2) {
    const user = demoConversation[i];
    const assistant = demoConversation[i + 1];
    if (user && assistant) {
      memory.chain.appendTurn(user.content, assistant.content);
      const node = memory.chain.all()[memory.chain.length - 1];
      memory.bm25.add(node);
      fixtureCount++;
    }
  }
  console.log(`  Ingested ${fixtureCount} conversation turns`);
  totalNodes += fixtureCount;

  // Export and save
  const state = await memory.export();
  if (!existsSync('data')) await mkdir('data', { recursive: true });
  await writeFile('data/memory-state.json', JSON.stringify(state), 'utf8');

  console.log(`\n=== Done ===`);
  console.log(`Total nodes: ${totalNodes}`);
  console.log(`Chain length: ${memory.chain.length}`);
  console.log(`Saved to: data/memory-state.json`);
  console.log(`\nStart serve.js and refresh the demo — it will restore these nodes.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
