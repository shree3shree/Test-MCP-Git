#!/usr/bin/env node
/**
 * GitHub MCP Server v3
 *
 * Works with github.com AND GitHub Enterprise Server (GHES).
 *
 * Environment variables:
 *   GITHUB_TOKEN  (required) Personal access token
 *   GITHUB_HOST   (optional) Your GHES hostname, e.g. "ghe.corp.example.com"
 *                 Leave unset for github.com.
 *
 * Workflow:
 *   1. list_repos          → see all your repos
 *   2. select_repo         → pick one (persists for the session)
 *   3. list_branches       → branches in the active repo
 *   4. get_recent_commits  → recent commits on a branch
 *   5. get_diff            → diff between two branches
 *   6. create_pull_request → open a PR
 *   7. list_pull_requests  → see existing PRs
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Config ────────────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error("Error: GITHUB_TOKEN environment variable is required.");
  process.exit(1);
}

const GITHUB_HOST = (process.env.GITHUB_HOST || "").trim();

// github.com  → https://api.github.com
// GHES        → https://<host>/api/v3
const BASE = GITHUB_HOST
  ? `https://${GITHUB_HOST}/api/v3`
  : "https://api.github.com";

console.error(
  GITHUB_HOST
    ? `[github-mcp] GitHub Enterprise: ${BASE}`
    : "[github-mcp] github.com"
);

// ── HTTP ──────────────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  // application/vnd.github+json works on both github.com and GHES 3.x+
  Accept: "application/vnd.github+json",
  "User-Agent": "github-mcp-server/3.0",
};

async function gh(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const mergedHeaders = { ...BASE_HEADERS, ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers: mergedHeaders });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} ${res.statusText} — ${url}\n${body}`);
  }
  return res.json();
}

async function ghPost(path, data) {
  return gh(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// ── Session state ─────────────────────────────────────────────────────────────

let active = null; // { owner, repo, default_branch }

function requireRepo(owner, repo) {
  const o = owner || active?.owner;
  const r = repo  || active?.repo;
  if (!o || !r) throw new Error("No repo selected — call select_repo first.");
  return { o, r };
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "github-mcp", version: "3.0.0" });

// list_repos ------------------------------------------------------------------

server.tool(
  "list_repos",
  "List all repos you have access to. Works on github.com and GitHub Enterprise. Call select_repo afterward to pick one.",
  {
    type: z.enum(["all", "owner", "member"]).optional().default("owner")
      .describe("owner = yours only | all = yours + org repos"),
    sort: z.enum(["created", "updated", "pushed", "full_name"]).optional().default("pushed"),
    per_page: z.number().min(1).max(100).optional().default(50),
  },
  async ({ type, sort, per_page }) => {
    const repos = await gh(`/user/repos?type=${type}&sort=${sort}&per_page=${per_page}&direction=desc`);
    const rows = repos.map((r) => ({
      full_name: r.full_name,
      description: r.description || "",
      private: r.private,
      default_branch: r.default_branch,
      language: r.language || "",
      pushed_at: r.pushed_at,
      open_issues: r.open_issues_count,
      url: r.html_url,
    }));
    const status = active ? `Active: ${active.owner}/${active.repo}` : "None selected yet — use select_repo.";
    return { content: [{ type: "text", text: `${rows.length} repos found. ${status}\n\n${JSON.stringify(rows, null, 2)}` }] };
  }
);

// select_repo -----------------------------------------------------------------

server.tool(
  "select_repo",
  "Set the active repo for this session. All tools use it automatically after this. No local clone needed — everything talks to the GitHub API.",
  {
    full_name: z.string().optional().describe('e.g. "owner/repo-name"'),
    owner: z.string().optional(),
    repo: z.string().optional(),
  },
  async ({ full_name, owner, repo }) => {
    let o = owner, r = repo;
    if (full_name) {
      const parts = full_name.split("/");
      if (parts.length !== 2) throw new Error('full_name must be "owner/repo"');
      [o, r] = parts;
    }
    if (!o || !r) throw new Error("Provide full_name or both owner and repo.");

    const data = await gh(`/repos/${o}/${r}`);
    active = { owner: data.owner.login, repo: data.name, default_branch: data.default_branch };

    return {
      content: [{
        type: "text",
        text: [
          `✓ Active repo: ${data.full_name}`,
          `  Default branch : ${data.default_branch}`,
          `  Private        : ${data.private}`,
          `  Language       : ${data.language || "—"}`,
          `  Description    : ${data.description || "—"}`,
          `  URL            : ${data.html_url}`,
          "",
          "list_branches, get_recent_commits, get_diff, create_pull_request, and list_pull_requests will all use this repo automatically.",
        ].join("\n"),
      }],
    };
  }
);

// list_branches ---------------------------------------------------------------

server.tool(
  "list_branches",
  "List branches in the active repo. No local clone needed.",
  {
    owner: z.string().optional().describe("Override active repo owner"),
    repo: z.string().optional().describe("Override active repo name"),
  },
  async ({ owner, repo }) => {
    const { o, r } = requireRepo(owner, repo);
    const branches = await gh(`/repos/${o}/${r}/branches?per_page=100`);
    const rows = branches.map((b) => ({
      name: b.name,
      sha: b.commit.sha.slice(0, 7),
      protected: b.protected,
      default: b.name === active?.default_branch,
    }));
    return { content: [{ type: "text", text: `Branches in ${o}/${r}:\n\n${JSON.stringify(rows, null, 2)}` }] };
  }
);

// get_recent_commits ----------------------------------------------------------

server.tool(
  "get_recent_commits",
  "Get recent commits on a branch of the active repo. No local clone needed.",
  {
    branch: z.string().optional().describe("Defaults to the repo default branch"),
    count: z.number().min(1).max(50).optional().default(10),
    owner: z.string().optional(),
    repo: z.string().optional(),
  },
  async ({ branch, count, owner, repo }) => {
    const { o, r } = requireRepo(owner, repo);
    const ref = branch ?? active?.default_branch ?? "";
    const commits = await gh(`/repos/${o}/${r}/commits?per_page=${count}${ref ? `&sha=${encodeURIComponent(ref)}` : ""}`);
    const rows = commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
    }));
    return { content: [{ type: "text", text: `Last ${rows.length} commits on ${o}/${r} @ ${ref || "default"}:\n\n${JSON.stringify(rows, null, 2)}` }] };
  }
);

// get_diff --------------------------------------------------------------------

server.tool(
  "get_diff",
  "Compare two branches or commits in the active repo. Use this before creating a PR. No local clone needed.",
  {
    base: z.string().describe("Branch/SHA to merge INTO (e.g. 'main')"),
    head: z.string().describe("Branch/SHA with your changes (e.g. 'feature/my-branch')"),
    owner: z.string().optional(),
    repo: z.string().optional(),
  },
  async ({ base, head, owner, repo }) => {
    const { o, r } = requireRepo(owner, repo);
    const data = await gh(`/repos/${o}/${r}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    const result = {
      repo: `${o}/${r}`, base, head,
      status: data.status,
      ahead_by: data.ahead_by,
      behind_by: data.behind_by,
      total_commits: data.total_commits,
      commits: data.commits.map((c) => ({
        sha: c.sha.slice(0, 7),
        message: c.commit.message.split("\n")[0],
        author: c.commit.author.name,
        date: c.commit.author.date,
      })),
      files: data.files?.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ? (f.patch.length > 800 ? f.patch.slice(0, 800) + "\n…(truncated)" : f.patch) : undefined,
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// create_pull_request ---------------------------------------------------------

server.tool(
  "create_pull_request",
  "Open a PR in the active repo. The head branch must be pushed to the remote. base defaults to the repo default branch. No local clone needed.",
  {
    title: z.string(),
    head: z.string().describe("Your branch with changes (must be pushed to remote)"),
    base: z.string().optional().describe("Branch to merge into — defaults to repo default branch"),
    body: z.string().optional().default(""),
    draft: z.boolean().optional().default(false),
    owner: z.string().optional(),
    repo: z.string().optional(),
  },
  async ({ title, head, base, body, draft, owner, repo }) => {
    const { o, r } = requireRepo(owner, repo);
    const targetBase = base ?? active?.default_branch;
    if (!targetBase) throw new Error("Cannot determine base branch — pass base explicitly.");

    const pr = await ghPost(`/repos/${o}/${r}/pulls`, { title, head, base: targetBase, body, draft });
    return {
      content: [{
        type: "text",
        text: [
          `✓ PR created in ${o}/${r}`,
          `  #${pr.number}: ${pr.title}`,
          `  ${pr.head.ref} → ${pr.base.ref}`,
          `  Draft : ${pr.draft}`,
          `  State : ${pr.state}`,
          `  URL   : ${pr.html_url}`,
        ].join("\n"),
      }],
    };
  }
);

// list_pull_requests ----------------------------------------------------------

server.tool(
  "list_pull_requests",
  "List PRs in the active repo. No local clone needed.",
  {
    state: z.enum(["open", "closed", "all"]).optional().default("open"),
    per_page: z.number().min(1).max(100).optional().default(20),
    owner: z.string().optional(),
    repo: z.string().optional(),
  },
  async ({ state, per_page, owner, repo }) => {
    const { o, r } = requireRepo(owner, repo);
    const prs = await gh(`/repos/${o}/${r}/pulls?state=${state}&per_page=${per_page}&sort=updated&direction=desc`);
    const rows = prs.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.user.login,
      state: p.state,
      draft: p.draft,
      head: p.head.ref,
      base: p.base.ref,
      updated_at: p.updated_at,
      url: p.html_url,
    }));
    return { content: [{ type: "text", text: `${state} PRs in ${o}/${r} (${rows.length}):\n\n${JSON.stringify(rows, null, 2)}` }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
