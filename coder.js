#!/usr/bin/env node
/**
 * coder.js
 * Automated developer agent that implements user stories sequentially.
 * Finds the next open issue, reads codebase context, uses Claude to write implementation files,
 * pushes to a branch, and opens a Pull Request.
 */

import fs from 'fs';
import path from 'url';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config (from env) ────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const GITHUB_OWNER      = process.env.GITHUB_OWNER || process.env.GITHUB_REPOSITORY_OWNER;
const GITHUB_REPO       = process.env.GITHUB_REPO || process.env.GITHUB_REPOSITORY?.split('/')[1];

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error('[coder] Error: Missing required GitHub environment variables.');
  process.exit(1);
}

if (!ANTHROPIC_API_KEY) {
  console.error('[coder] Error: Missing ANTHROPIC_API_KEY environment variable.');
  process.exit(1);
}

// Initialize Anthropic Client
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Run Developer Agent ──────────────────────────────────────────────────────
try {
  await runAgent();
} catch (err) {
  console.error(`\n[coder] Execution failed: ${err.message}`);
  process.exit(1);
}

async function runAgent() {
  console.log(`[coder] Starting development cycle for ${GITHUB_OWNER}/${GITHUB_REPO}...`);

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

  // Step 4: Ask Claude to implement the files
  console.log(`[coder] Prompting Claude to write code for ${storyId}...`);
  const implementation = await generateImplementation(activeStory, codebaseContext);
  console.log(`[coder] Claude completed generation! Explanation:\n${implementation.explanation}`);

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
*Created by Epic Refiner Coder agent using Claude.*`;

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

// ─── Claude Structured Code Generation ───────────────────────────────────────
async function generateImplementation(story, codebaseContext) {
  const systemPrompt = `You are an automated elite software engineer. 
Your objective is to read the target User Story, analyze the existing codebase context, and write the necessary additions or revisions to satisfy all acceptance criteria.

Maintain architectural consistency, ensure variables match, and write clean, idiomatic code (.go or .js).

You MUST respond with a valid JSON object matching the schema below. Do NOT wrap it in any conversational introduction/outro prose. Respond ONLY with the raw JSON.

Output JSON Schema:
{
  "explanation": "A summary of what changes were implemented and how the architectural requirements were handled.",
  "files": [
    {
      "path": "The relative path of the file to create/overwrite from project root (e.g. 'internal/reclamation/reclamation.go').",
      "content": "The complete, clean new content of the file."
    }
  ]
}`;

  const userPrompt = `### User Story to Implement
Title: [${story.id}] ${story.title}
Acceptance Criteria:
${story.body}

### Existing Codebase Context
${codebaseContext || 'No existing files. Create the initial directory structure.'}

Provide your changes.`;

  const msg = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const raw = msg.content.map(b => b.text || '').join('');
  
  // Extract block cleanly starting with the first curly brace and ending with the last
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Claude response did not contain a valid JSON object block. Raw output: ${raw.slice(0, 200)}`);
  }

  const clean = jsonMatch[0].trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    throw new Error(`Failed parsing Claude JSON output: ${clean.slice(0, 200)}`);
  }
}

function applyChanges(files) {
  for (const file of files) {
    const fullPath = path.resolve(process.cwd(), file.path);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content, 'utf-8');
    console.log(`  [write] Updated file: ${file.path}`);
  }
}