#!/usr/bin/env node
/**
 * refiner.js
 * Reads a refinement file, calls Claude to decompose it into stories,
 * then creates GitHub Issues and adds them to a Project board.
 *
 * Usage:
 *   node refiner.js <path-to-refinement-file>
 *   node refiner.js --watch          (watches refinements/ folder)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config (from env) ────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const GITHUB_OWNER      = process.env.GITHUB_OWNER;
const GITHUB_REPO       = process.env.GITHUB_REPO;
const GITHUB_PROJECT_NUMBER = parseInt(process.env.GITHUB_PROJECT_NUMBER || '0');
const REFINEMENTS_DIR   = process.env.REFINEMENTS_DIR  || path.join(__dirname, 'refinements');
const PROCESSED_DIR     = process.env.PROCESSED_DIR    || path.join(__dirname, 'processed');
const DEFAULT_STATUS    = process.env.DEFAULT_STATUS   || 'Todo';

const SUPPORTED_EXTS = ['.md', '.txt', '.epic'];

// ─── Claude system prompt ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a senior product analyst embedded in a CI pipeline.
You receive epic or feature descriptions (sometimes with codebase context) and
decompose them into user stories following INVEST principles.

For each story produce exactly this JSON shape — nothing else:
{
  "id": "US-001",
  "title": "Short imperative phrase",
  "role": "who the user is",
  "goal": "what they want to do",
  "motivation": "why — the business value",
  "acceptance_criteria": [
    "Given <context>, when <action>, then <outcome>"
  ],
  "size": "S | M | L | SPIKE",
  "dependencies": ["US-002"],
  "labels": ["optional", "extra", "labels"]
}

Decomposition rules:
1. Vertical slices only — each story must be demoable end-to-end on its own.
2. Happy path first, edge cases as separate lower-priority stories.
3. Size S = ~half day, M = 1-2 days, L = flag it (needs splitting), SPIKE = unknown.
4. If something is ambiguous, emit a SPIKE story with research questions as ACs.
5. If a codebase context section is included, reference specific files/modules in the ACs.
6. Mark dependencies explicitly — do not merge dependent stories.

Return a JSON array only. No prose, no markdown fences, no backticks.`;

// ─── Main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === '--watch') {
  watchFolder();
} else if (args[0]) {
  await processFile(args[0]);
} else {
  console.error('Usage: node refiner.js <file>  |  node refiner.js --watch');
  process.exit(1);
}

// ─── File watcher ─────────────────────────────────────────────────────────────
function watchFolder() {
  fs.mkdirSync(REFINEMENTS_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_DIR,   { recursive: true });

  console.log(`[watcher] Watching ${REFINEMENTS_DIR} for refinement files...`);

  // Process any existing unprocessed files on startup
  for (const f of fs.readdirSync(REFINEMENTS_DIR)) {
    if (SUPPORTED_EXTS.includes(path.extname(f))) {
      processFile(path.join(REFINEMENTS_DIR, f)).catch(console.error);
    }
  }

  fs.watch(REFINEMENTS_DIR, async (eventType, filename) => {
    if (eventType !== 'rename' || !filename) return;
    if (!SUPPORTED_EXTS.includes(path.extname(filename))) return;

    const fullPath = path.join(REFINEMENTS_DIR, filename);

    // Wait briefly for the write to complete
    await sleep(500);
    if (!fs.existsSync(fullPath)) return; // deleted, not created

    console.log(`[watcher] Detected: ${filename}`);
    try {
      await processFile(fullPath);
    } catch (e) {
      console.error(`[watcher] Failed on ${filename}:`, e.message);
    }
  });
}

// ─── Process a single refinement file ─────────────────────────────────────────
async function processFile(filePath) {
  const filename = path.basename(filePath);
  console.log(`\n[refiner] Processing: ${filename}`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const rawContent = fs.readFileSync(filePath, 'utf-8').trim();
  if (!rawContent) {
    console.warn(`[refiner] Empty file, skipping: ${filename}`);
    return;
  }

  // Parse optional front-matter for labels / epic title
  const { meta, body } = parseFrontMatter(rawContent);

  // Build user message — include codebase context if referenced
  const userMessage = buildUserMessage(body, meta);

  // ── Step 1: Refine with Claude ──────────────────────────────────────────────
  console.log('[refiner] Calling Claude...');
  const stories = await refineWithClaude(userMessage);
  console.log(`[refiner] Got ${stories.length} stories`);

  // ── Step 2: Push to GitHub ──────────────────────────────────────────────────
  if (GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO) {
    console.log('[refiner] Pushing to GitHub...');
    await pushStoriesToGitHub(stories, meta);
  } else {
    console.warn('[refiner] GitHub env vars not set — writing stories.json only');
  }

  // ── Step 3: Write output + move file to processed ──────────────────────────
  const outName = path.basename(filename, path.extname(filename));
  const outPath = path.join(path.dirname(filePath), '..', `${outName}.stories.json`);
  fs.writeFileSync(outPath, JSON.stringify(stories, null, 2));
  console.log(`[refiner] Wrote: ${path.basename(outPath)}`);

  // Move to processed/
  const processedPath = path.join(PROCESSED_DIR, filename);
  fs.renameSync(filePath, processedPath);
  console.log(`[refiner] Moved to processed/`);

  return stories;
}

// ─── Claude call ──────────────────────────────────────────────────────────────
async function refineWithClaude(userMessage) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });

  const raw = msg.content.map(b => b.text || '').join('');
  const clean = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error(`Claude returned invalid JSON: ${clean.slice(0, 200)}`);
  }
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────
async function pushStoriesToGitHub(stories, meta) {
  const projectId = GITHUB_PROJECT_NUMBER
    ? await getProjectId(GITHUB_OWNER, GITHUB_PROJECT_NUMBER)
    : null;

  const statusField = projectId ? await getStatusField(projectId) : null;
  const statusOptionId = statusField
    ? statusField.options.find(o => o.name === DEFAULT_STATUS)?.id
    : null;

  const epicLabels = meta.labels || [];

  // Ensure size labels exist
  await ensureLabels(['size:s','size:m','size:l','size:spike', ...epicLabels]);

  for (const story of stories) {
    process.stdout.write(`  [github] Creating issue for ${story.id}... `);

    const storyLabels = [
      `size:${story.size.toLowerCase()}`,
      ...(story.labels || []),
      ...epicLabels
    ];

    const issue = await createIssue(story, storyLabels);
    process.stdout.write(`#${issue.number} `);

    if (projectId) {
      const itemId = await addIssueToProject(projectId, issue.node_id);
      if (statusOptionId && itemId) {
        await setProjectItemStatus(projectId, itemId, statusField.id, statusOptionId);
      }
      process.stdout.write(`→ board `);
    }

    console.log('✓');
    await sleep(200); // respect rate limits
  }
}

async function createIssue(story, labels) {
  const body = buildIssueBody(story);
  const res = await ghRest('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`, {
    title: `[${story.id}] ${story.title}`,
    body,
    labels
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`GitHub issue creation failed: ${err.message}`);
  }
  return res.json();
}

async function ensureLabels(names) {
  const colors = { 'size:s': '4ade80', 'size:m': 'fbbf24', 'size:l': 'f87171', 'size:spike': '60a5fa' };
  for (const name of [...new Set(names)]) {
    await ghRest('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/labels`, {
      name,
      color: colors[name] || 'ededed'
    }).catch(() => {}); // ignore if already exists
  }
}

async function getProjectId(owner, number) {
  const query = `
    query($owner: String!, $num: Int!) {
      user(login: $owner) { projectV2(number: $num) { id } }
      organization(login: $owner) { projectV2(number: $num) { id } }
    }`;
  const data = await ghGraphQL(query, { owner, num: number });
  return data.user?.projectV2?.id || data.organization?.projectV2?.id || null;
}

async function getStatusField(projectId) {
  const query = `
    query($id: ID!) {
      node(id: $id) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                id name options { id name }
              }
            }
          }
        }
      }
    }`;
  const data = await ghGraphQL(query, { id: projectId });
  return data.node?.fields?.nodes?.find(f => f.name === 'Status') || null;
}

async function addIssueToProject(projectId, issueNodeId) {
  const mutation = `
    mutation($pid: ID!, $cid: ID!) {
      addProjectV2ItemById(input: { projectId: $pid, contentId: $cid }) {
        item { id }
      }
    }`;
  const data = await ghGraphQL(mutation, { pid: projectId, cid: issueNodeId });
  return data.addProjectV2ItemById?.item?.id || null;
}

async function setProjectItemStatus(projectId, itemId, fieldId, optionId) {
  const mutation = `
    mutation($pid: ID!, $iid: ID!, $fid: ID!, $oid: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $pid, itemId: $iid,
        fieldId: $fid, value: { singleSelectOptionId: $oid }
      }) { projectV2Item { id } }
    }`;
  await ghGraphQL(mutation, { pid: projectId, iid: itemId, fid: fieldId, oid: optionId });
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function ghRest(method, endpoint, body) {
  return fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify(body)
  });
}

async function ghGraphQL(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

// ─── Content builders ─────────────────────────────────────────────────────────
// ─── Content builders ─────────────────────────────────────────────────────────
function buildUserMessage(epicBody, meta) {
  let msg = epicBody;

  // Root folders we want to inject
  const targetFolders = ['internal', 'cmd', 'web'];
  const snippets = [];

  // Helper to recursively find files up to a reasonable max depth (e.g., 4)
  function walkDir(dirPath, currentDepth = 0, maxDepth = 4) {
    if (currentDepth > maxDepth || !fs.existsSync(dirPath)) return;

    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      
      // Skip common clutter
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;

      if (item.isDirectory()) {
        walkDir(fullPath, currentDepth + 1, maxDepth);
      } else if (item.isFile()) {
        // Enforce file extension guardrail (.go or .js)
        const ext = path.extname(item.name).toLowerCase();
        if (ext !== '.go' && ext !== '.js') continue;

        // Read file content (capped at 3000 chars)
        const content = fs.readFileSync(fullPath, 'utf-8').slice(0, 3000);
        // Get the path relative to the workspace root for cleaner headers
        const relativePath = path.relative(process.cwd(), fullPath);
        
        snippets.push(`### ${relativePath}\n\`\`\`\n${content}\n\`\`\``);
      }
    }
  }

  // Scan each of the targeted directories
  for (const folder of targetFolders) {
    const folderPath = path.resolve(process.cwd(), folder);
    if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
      walkDir(folderPath);
    }
  }

  // Inject snippets if any files were found
  if (snippets.length) {
    msg += `\n\n---\n## Codebase context\n${snippets.join('\n\n')}`;
  }

  return msg;
}

function buildIssueBody(s) {
  const acs = (s.acceptance_criteria || []).map((ac, i) => `${i + 1}. ${ac}`).join('\n');
  const deps = (s.dependencies || []).length ? s.dependencies.join(', ') : 'none';
  return `## User story

As a **${s.role}**, I want ${s.goal} so that ${s.motivation}.

## Acceptance criteria

${acs}

## Metadata

| Field | Value |
|---|---|
| Story ID | \`${s.id}\` |
| Size | \`${s.size}\` |
| Dependencies | ${deps} |

---
*Generated by Epic Refiner CI*`;
}

function parseFrontMatter(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: content };

  const meta = {};
  for (const line of fmMatch[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) meta[key.trim()] = rest.join(':').trim();
  }
  return { meta, body: fmMatch[2].trim() };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
