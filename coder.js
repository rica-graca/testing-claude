#!/usr/bin/env node
/**
 * coder.js
 * Automated developer agent that implements user stories sequentially.
 * Finds the next open issue, reads codebase context, uses Claude to write implementation files,
 * pushes to a branch, and opens a Pull Request.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config (from env) ────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'mock';
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const GITHUB_OWNER      = process.env.GITHUB_OWNER || process.env.GITHUB_REPOSITORY_OWNER;
const GITHUB_REPO       = process.env.GITHUB_REPO || process.env.GITHUB_REPOSITORY?.split('/')[1];

const MOCK_MODE = process.env.MOCK_CLAUDE === 'true' || ANTHROPIC_API_KEY === 'mock';

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error('[coder] Error: Missing required GitHub environment variables.');
  process.exit(1);
}

// Initialize Anthropic Client (only if not mocking fully without a key)
const anthropic = ANTHROPIC_API_KEY !== 'mock' ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ─── Run Developer Agent ──────────────────────────────────────────────────────
try {
  await runAgent();
} catch (err) {
  console.error(`\n[coder] Execution failed: ${err.message}`);
  process.exit(1);
}

async function runAgent() {
  console.log(`[coder] Starting development cycle for ${GITHUB_OWNER}/${GITHUB_REPO}...`);
  if (MOCK_MODE) console.log(`[coder] 🟡 MOCK MODE ACTIVE: Bypassing Claude API.`);

  // Step 1: Find the next open User Story
  const issues = await fetchOpenUserStories();
  if (issues.length === 0) {
    console.log('[coder] No open User Stories found! Your backlog is complete. 🎉');
    return;
  }

  const activeStory = issues[0]; // Lowest number issue
  const storyId = activeStory.id; // e.g. "US-001"
  const storyTitle = activeStory.title;
  console.log(`[coder] Active story found: [${storyId}] - ${storyTitle}`);

  // Step 2: Safety Check — Ensure we don't proceed if a PR for this story already exists
  const hasExistingPR = await checkOpenPullRequests(storyId);
  if (hasExistingPR) {
    console.log(`\n[coder] 🛑 A Pull Request is already open for ${storyId}.`);
    console.log(`[coder] Please review, merge, and close the PR/issue before running the coder for the next story.`);
    return;
  }

  // Step 3: Collect Codebase Context
  console.log('[coder] Gathering codebase context...');
  const codebaseContext = getCodebaseContext();

  // Step 4: Ask Claude (or Mock) to implement the files
  console.log(`[coder] Prompting Claude (or mock) to write code for ${storyId}...`);
  const implementation = await generateImplementation(activeStory, codebaseContext);
  console.log(`[coder] Code generation completed! Explanation:\n${implementation.explanation}`);

  // Step 5: Apply Code Changes Locally
  console.log('[coder] Applying code modifications to workspace...');
  applyChanges(implementation.files);

  // Step 6: Create Branch, Commit, Push & Pull Request
  console.log('[coder] Creating Pull Request...');
  await createPullRequest(storyId, storyTitle, activeStory.number, implementation.explanation);

  console.log(`\n[coder] Success! PR has been opened for ${storyId}. Waiting for review.`);
}

// ─── GitHub API Helpers ──────────────────────────────────────────────────────
async function fetchOpenUserStories() {
  const res = await ghRest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues?state=open&sort=created&direction=asc`);
  const issues = await res.json();

  const userStories = [];
  for (const issue of issues) {
    if (issue.pull_request) continue; // Skip PRs disguised as issues
    
    // Check if the title matches "[US-XXX] ..."
    const match = issue.title.match(/^\[(US-\d+)\]\s*(.*)$/i);
    if (match) {
      userStories.push({
        id: match[1].toUpperCase(),
        title: match[2],
        number: issue.number,
        body: issue.body || ''
      });
    }
  }
  return userStories;
}

async function checkOpenPullRequests(storyId) {
  const res = await ghRest('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?state=open`);
  const pulls = await res.json();
  return pulls.some(pr => pr.head.ref === `implement/${storyId.toLowerCase()}` || pr.title.includes(`[${storyId}]`));
}

async function createPullRequest(storyId, title, issueNumber, explanation) {
  const branchName = `implement/${storyId.toLowerCase()}`;

  // Configure local git credentials
  execSync('git config user.name "github-actions[bot]"');
  execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');

  // Checkout and push changes
  execSync(`git checkout -b ${branchName}`);
  execSync('git add .');
  execSync(`git commit -m "feat: implement ${storyId} - ${title}"`);
  execSync(`git push origin ${branchName} --force`);

  // Create PR through API
  const prBody = `Closes #${issueNumber}

This is an automated Pull Request implementing **${storyId}**:

> ${title}

### Implementation Details & Changes
${explanation}

---
*Created by Epic Refiner Coder agent.*`;

  const res = await ghRest('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls`, {
    title: `[${storyId}] ${title}`,
    head: branchName,
    base: 'main',
    body: prBody
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Failed to create Pull Request: ${err.message}`);
  }
  return res.json();
}

function ghRest(method, endpoint, body) {
  return fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

// ─── Codebase Parsing Context ────────────────────────────────────────────────
function getCodebaseContext() {
  const targetFolders = ['internal', 'cmd', 'web'];
  const snippets = [];

  function walkDir(dirPath, currentDepth = 0, maxDepth = 4) {
    if (currentDepth > maxDepth || !fs.existsSync(dirPath)) return;
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;

      if (item.isDirectory()) {
        walkDir(fullPath, currentDepth + 1, maxDepth);
      } else if (item.isFile()) {
        const ext = path.extname(item.name).toLowerCase();
        if (ext !== '.go' && ext !== '.js') continue;

        const content = fs.readFileSync(fullPath, 'utf-8').slice(0, 3000);
        const relativePath = path.relative(process.cwd(), fullPath);
        snippets.push(`### File: ${relativePath}\n\`\`\`\n${content}\n\`\`\``);
      }
    }
  }

  for (const folder of targetFolders) {
    const folderPath = path.resolve(process.cwd(), folder);
    if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
      walkDir(folderPath);
    }
  }

  return snippets.join('\n\n');
}

// ─── Code Generation (Claude or Mock) ────────────────────────────────────────
async function generateImplementation(story, codebaseContext) {
  if (MOCK_MODE) {
    console.log('[coder] Bypassing Claude API -> generating mock implementation...');
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    return {
      explanation: `(MOCK) Automatically implemented ${story.id} to test the PR pipeline. Added UI scaffolding and backend hooks.`,
      files: [
        {
          path: `web/mock_${story.id.toLowerCase()}.js`,
          content: `// Mock implementation file for ${story.id}\n// Title: ${story.title}\n\nexport function initMock() {\n  console.log('Mock loaded!');\n}\n`
        }
      ]
    };
  }

  // UPDATED SYSTEM PROMPT: Uses robust XML tags instead of fragile JSON strings
  const systemPrompt = `You are an automated elite software engineer. 
Your objective is to read the target User Story, analyze the existing codebase context, and write the necessary additions or revisions to satisfy all acceptance criteria.

Maintain architectural consistency, ensure variables match, and write clean, idiomatic code (.go or .js).

CRITICAL OUTPUT FORMAT:
You MUST respond using the exact XML-like blocks below. Do NOT output JSON. 

1. Provide an explanation wrapped in <explanation> tags.
2. Provide each file's code wrapped in <file path="relative/path/here.ext"> tags.

Example Response:
<explanation>
Added the new endpoints to handle the reclamation logic.
</explanation>

<file path="internal/reclamation/reclamation.go">
package reclamation
// your code here
</file>`;

  const userPrompt = `### User Story to Implement
Title: [${story.id}] ${story.title}
Acceptance Criteria:
${story.body}

### Existing Codebase Context
${codebaseContext || 'No existing files. Create the initial directory structure.'}

Provide your changes.`;

  const fallbackSequence = [
    process.env.CLAUDE_MODEL,
    'claude-opus-4-5',
    'claude-3-7-sonnet-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20240620',
    'claude-3-5-haiku-latest',
    'claude-3-haiku-20240307'
  ].filter(Boolean);

  let lastError = null;

  for (const model of fallbackSequence) {
    try {
      console.log(`[coder] Attempting code generation with model: ${model}...`);
      
      const msg = await anthropic.messages.create({
        model: model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      const raw = msg.content.map(b => b.text || '').join('');
      
      // NEW PARSING LOGIC: Safely extract explanation and files from XML-style blocks
      const explanationMatch = raw.match(/<explanation>([\s\S]*?)<\/explanation>/i);
      const explanation = explanationMatch ? explanationMatch[1].trim() : 'No explanation provided.';

      const files = [];
      const fileRegex = /<file\s+path=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;
      let match;
      while ((match = fileRegex.exec(raw)) !== null) {
        files.push({
          path: match[1],
          content: match[2].trim() + '\n' // Ensure ending newline
        });
      }

      if (files.length === 0) {
         throw new Error(`Claude response did not contain any valid <file path="...">...</file> blocks.`);
      }

      console.log(`[coder] Successfully parsed ${files.length} file(s).`);
      return { explanation, files };

    } catch (err) {
      console.warn(`[coder] Model "${model}" failed or returned an error: ${err.message}`);
      lastError = err;
    }
  }

  throw new Error(`All available models in our fallback cascade failed. Last logged error: ${lastError ? lastError.message : 'Unknown'}`);
}

function applyChanges(files) {
  for (const file of files) {
    const fullPath = path.resolve(process.cwd(), file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, 'utf-8');
    console.log(`  [write] Updated file: ${file.path}`);
  }
}