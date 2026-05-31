#!/usr/bin/env node
/**
 * claude-review.js
 * Calls the Anthropic API with the PR diff, parses structured inline comments,
 * and posts them as a GitHub Pull Request Review with per-line annotations.
 */

const fs   = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN;
const REPO              = process.env.REPO;               // "owner/repo"
const PR_NUMBER         = process.env.PR_NUMBER;
const HEAD_SHA          = process.env.HEAD_SHA;

if (!ANTHROPIC_API_KEY || !GITHUB_TOKEN || !REPO || !PR_NUMBER || !HEAD_SHA) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

// ── 1. Read the diff ────────────────────────────────────────────────────────
const diff = fs.readFileSync('/tmp/pr.diff', 'utf8');

if (!diff.trim()) {
  console.log('Empty diff — nothing to review.');
  process.exit(0);
}

// Truncate very large diffs to stay within token limits
const MAX_DIFF_CHARS = 28_000;
const truncated = diff.length > MAX_DIFF_CHARS;
const diffContent = truncated
  ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n[...diff truncated for length...]'
  : diff;

// ── 2. Call Claude ──────────────────────────────────────────────────────────
async function callClaude(diffText) {
  const systemPrompt = `You are an expert Go code reviewer. You will be given a git diff for a Pull Request.

Your task is to review the changed code and provide actionable, constructive inline comments.

Focus on:
- Bugs, logic errors, or incorrect behaviour
- Go best practices and idiomatic patterns
- Error handling issues (unchecked errors, missing context propagation)
- Security concerns (SQL injection, missing validation, etc.)
- Performance issues
- Readability and maintainability improvements

Rules:
- Only comment on lines that appear in the diff (lines starting with "+", excluding the "+++" header lines)
- Be specific and explain WHY something is an issue, not just what it is
- Suggest concrete fixes when possible
- Skip trivial style nits unless they are meaningful
- If the code is good, say so in the summary

Respond ONLY with a valid JSON object, no markdown fences, no preamble:
{
  "summary": "Overall review summary (1-3 sentences, markdown supported)",
  "comments": [
    {
      "path": "relative/file/path.go",
      "line": <line number in the NEW file (right side of diff)>,
      "body": "Your comment here (markdown supported)"
    }
  ]
}

If there are no issues, return an empty comments array and a positive summary.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':         'application/json',
      'x-api-key':            ANTHROPIC_API_KEY,
      'anthropic-version':    '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system:     systemPrompt,
      messages: [
        {
          role:    'user',
          content: `Please review this Pull Request diff:\n\n\`\`\`diff\n${diffText}\n\`\`\``,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw  = data.content.map(b => b.text || '').join('');

  // Strip accidental markdown fences
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

// ── 3. Validate comment positions against the diff ─────────────────────────
/**
 * GitHub's Pull Request Review API requires comments to be placed on lines
 * that exist in the diff. We parse the diff to build a map of
 * { "path:line" -> position } and filter out comments that don't land on
 * a real changed line.
 */
function buildDiffPositionMap(rawDiff) {
  const map = {}; // key: "path:newLine" → value: diff position index
  const fileRegex = /^diff --git a\/.+ b\/(.+)$/;
  const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  let currentFile   = null;
  let newLineNumber = 0;
  let position      = 0; // 1-based position within the current file's diff

  for (const line of rawDiff.split('\n')) {
    const fileMatch = line.match(fileRegex);
    if (fileMatch) {
      currentFile   = fileMatch[1];
      position      = 0;
      newLineNumber = 0;
      continue;
    }

    if (!currentFile) continue;

    const hunkMatch = line.match(hunkRegex);
    if (hunkMatch) {
      newLineNumber = parseInt(hunkMatch[1], 10) - 1;
      position++;
      continue;
    }

    // Skip diff file headers
    if (line.startsWith('---') || line.startsWith('+++')) continue;

    if (line.startsWith('+')) {
      newLineNumber++;
      position++;
      map[`${currentFile}:${newLineNumber}`] = position;
    } else if (line.startsWith('-')) {
      position++;
      // removed lines don't increment newLineNumber
    } else {
      // context line
      newLineNumber++;
      position++;
    }
  }

  return map;
}

// ── 4. Post GitHub PR Review ───────────────────────────────────────────────
async function postReview(summary, comments, positionMap) {
  const [owner, repo] = REPO.split('/');

  // Map Claude comments → GitHub review comments (only valid positions)
  const reviewComments = [];
  for (const c of comments) {
    const key = `${c.path}:${c.line}`;
    const position = positionMap[key];
    if (!position) {
      console.warn(`Skipping comment — "${key}" not found in diff positions.`);
      continue;
    }
    reviewComments.push({
      path:     c.path,
      position, // diff position, not file line number
      body:     c.body,
    });
  }

  const event = reviewComments.length > 0 ? 'COMMENT' : 'COMMENT';

  const payload = {
    commit_id: HEAD_SHA,
    body:      `## 🤖 Claude Code Review\n\n${summary}${truncated ? '\n\n> ⚠️ Diff was truncated — only the first ~28 000 chars were reviewed.' : ''}`,
    event,
    comments:  reviewComments,
  };

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${PR_NUMBER}/reviews`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${GITHUB_TOKEN}`,
      Accept:         'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${err}`);
  }

  const result = await res.json();
  console.log(`✅ Review posted: ${result.html_url}`);
  console.log(`   ${reviewComments.length} inline comment(s)`);
}

// ── 5. Main ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log(`Reviewing PR #${PR_NUMBER} on ${REPO}…`);
    console.log(`Diff size: ${diff.length} chars${truncated ? ' (truncated)' : ''}`);

    const positionMap = buildDiffPositionMap(diff);
    console.log(`Diff position map: ${Object.keys(positionMap).length} addressable lines`);

    console.log('Calling Claude API…');
    const review = await callClaude(diffContent);

    console.log(`Claude returned ${review.comments.length} comment(s)`);
    console.log('Summary:', review.summary);

    await postReview(review.summary, review.comments, positionMap);
  } catch (err) {
    console.error('Error during review:', err);
    process.exit(1);
  }
})();
