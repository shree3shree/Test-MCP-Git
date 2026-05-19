#!/usr/bin/env node
/**
 * GitHub MCP Server v2
 *
 * Works entirely via the GitHub API — no local clone needed.
 *
 * Workflow:
 *   1. list_repos          → see all your repos
 *   2. select_repo         → pick one by full_name (e.g. "owner/my-repo")
 *   3. list_branches       → branches in the selected repo
 *   4. get_recent_commits  → recent commits on a branch
 *   5. get_diff            → diff between two branches
 *   6. create_pull_request → open a PR (base defaults to repo default branch)
 *   7. list_pull_requests  → see existing PRs
 *
 * select_repo only needs to be called once per session.
 * All other tools use it automatically; pass owner+repo to override.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// ── Auth ──────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_FILE = path.join(__dirname, ".env");

loadEnvFile(ENV_FILE);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error(
    `Error: GITHUB_TOKEN environment variable is required. Set it in the environment or in ${ENV_FILE}.`
  );
  process.exit(1);
}

const BASE = "https://api.github.com";
const baseHeaders = {
  Authorization: `Bearer ${GITHUB_TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "github-mcp-server",
};

async function gh(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const res = await fetch(url, { headers: baseHeaders, ...opts });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${err}`);
  }
  return res.json();
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

// ── Session state ─────────────────────────────────────────────────────────────

let selectedRepo = null; // { owner, repo, default_branch }

function requireRepo(overrideOwner, overrideRepo) {
  const owner = overrideOwner || selectedRepo?.owner;
  const repo  = overrideRepo  || selectedRepo?.repo;
  if (!owner || !repo) {
    throw new Error(
      "No repo selected. Call select_repo first, or pass owner + repo explicitly."
    );
  }
  return { owner, repo };
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "github-mcp", version: "2.0.0" });

// ── list_repos ────────────────────────────────────────────────────────────────

server.tool(
  "list_repos",
  `List all GitHub repos you have access to. No local clone needed.
After listing, call select_repo with a full_name to set the active repo.`,
  {
    type: z.enum(["all", "owner", "member"]).optional().default("owner")
      .describe("'owner' = only yours, 'all' = yours + org repos"),
    sort: z.enum(["created", "updated", "pushed", "full_name"]).optional().default("pushed"),
    per_page: z.number().min(1).max(100).optional().default(50),
  },
  async ({ type, sort, per_page }) => {
    const repos = await gh(`/user/repos?type=${type}&sort=${sort}&per_page=${per_page}&direction=desc`);
    const result = repos.map((r) => ({
      full_name: r.full_name,
      description: r.description || "",
      private: r.private,
      default_branch: r.default_branch,
      language: r.language || "",
      pushed_at: r.pushed_at,
      open_issues: r.open_issues_count,
      url: r.html_url,
    }));
    const status = selectedRepo
      ? `Active repo: ${selectedRepo.owner}/${selectedRepo.repo}`
      : "No repo selected yet — use select_repo after choosing one.";
    return {
      content: [{ type: "text", text: `Found ${result.length} repos. ${status}\n\n${JSON.stringify(result, null, 2)}` }],
    };
  }
);

// ── select_repo ───────────────────────────────────────────────────────────────

server.tool(
  "select_repo",
  `Set the active repo for this session. All tools will use it automatically after this.
No local clone required — everything goes through the GitHub API.
Pass full_name like "owner/repo", OR separate owner + repo fields.`,
  {
    full_name: z.string().optional().describe('e.g. "owner/repo"'),
    owner: z.string().optional(),
    repo: z.string().optional(),
  },
  async ({ full_name, owner, repo }) => {
    let o = owner, r = repo;
    if (full_name) {
      const parts = full_name.split("/");
      if (parts.length !== 2) throw new Error("full_name must be 'owner/repo'");
      [o, r] = parts;
    }
    if (!o || !r) throw new Error("Provide full_name or both owner and repo.");

    const data = await gh(`/repos/${o}/${r}`);
    selectedRepo = { owner: data.owner.login, repo: data.name, default_branch: data.default_branch };

    return {
      content: [{
        type: "text",
        text: [
          `✓ Active repo set: ${data.full_name}`,
          `  Default branch : ${data.default_branch}`,
          `  Private        : ${data.private}`,
          `  Language       : ${data.language || "—"}`,
          `  Description    : ${data.description || "—"}`,
          `  URL            : ${data.html_url}`,
          ``,
          `All tools (list_branches, get_recent_commits, get_diff, create_pull_request, list_pull_requests) will now use this repo automatically.`,
        ].join("\n"),
      }],
    };
  }
);

// ── list_branches ─────────────────────────────────────────────────────────────

server.tool(
  "list_branches",
  "List branches in the active repo. No local clone needed.",
  {
    owner: z.string().optional().describe("Override the active repo owner"),
    repo: z.string().optional().describe("Override the active repo name"),
  },
  async ({ owner, repo }) => {
    const { owner: o, repo: r } = requireRepo(owner, repo);
    const branches = await gh(`/repos/${o}/${r}/branches?per_page=100`);
    const result = branches.map((b) => ({
      name: b.name,
      sha: b.commit.sha.slice(0, 7),
      protected: b.protected,
      default: b.name === selectedRepo?.default_branch,
    }));
    return {
      content: [{ type: "text", text: `Branches in ${o}/${r}:\n\n${JSON.stringify(result, null, 2)}` }],
    };
  }
);

// ── get_recent_commits ────────────────────────────────────────────────────────

server.tool(
  "get_recent_commits",
  "Get recent commits on a branch of the active repo. No local clone needed.",
  {
    branch: z.string().optional().describe("Branch name — defaults to the repo default branch"),
    count: z.number().min(1).max(50).optional().default(10),
    owner: z.string().optional().describe("Override the active repo owner"),
    repo: z.string().optional().describe("Override the active repo name"),
  },
  async ({ branch, count, owner, repo }) => {
    const { owner: o, repo: r } = requireRepo(owner, repo);
    const ref = branch ?? selectedRepo?.default_branch ?? "";
    const commits = await gh(`/repos/${o}/${r}/commits?per_page=${count}${ref ? `&sha=${ref}` : ""}`);
    const result = commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
    }));
    return {
      content: [{ type: "text", text: `Last ${result.length} commits on ${o}/${r}@${ref || "default"}:\n\n${JSON.stringify(result, null, 2)}` }],
    };
  }
);

// ── get_diff ──────────────────────────────────────────────────────────────────

server.tool(
  "get_diff",
  `Compare two branches or commits in the active repo. No local clone needed.
Use this before creating a PR to review what will be merged.`,
  {
    base: z.string().describe("Branch/SHA to merge INTO (e.g. 'main')"),
    head: z.string().describe("Branch/SHA with your changes (e.g. 'feature/my-branch')"),
    owner: z.string().optional().describe("Override the active repo owner"),
    repo: z.string().optional().describe("Override the active repo name"),
  },
  async ({ base, head, owner, repo }) => {
    const { owner: o, repo: r } = requireRepo(owner, repo);
    const data = await gh(`/repos/${o}/${r}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    const result = {
      repo: `${o}/${r}`,
      base, head,
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
        patch: f.patch ? f.patch.slice(0, 800) + (f.patch.length > 800 ? "\n…(truncated)" : "") : undefined,
      })),
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── create_pull_request ───────────────────────────────────────────────────────

server.tool(
  "create_pull_request",
  `Open a PR in the active repo. No local clone needed.
The head branch just needs to exist on GitHub (pushed remotely).
base defaults to the repo's default branch if not specified.`,
  {
    title: z.string(),
    head: z.string().describe("Branch with your changes (must be pushed to GitHub)"),
    base: z.string().optional().describe("Branch to merge into — defaults to repo default branch"),
    body: z.string().optional().default(""),
    draft: z.boolean().optional().default(false),
    owner: z.string().optional().describe("Override the active repo owner"),
    repo: z.string().optional().describe("Override the active repo name"),
  },
  async ({ title, head, base, body, draft, owner, repo }) => {
    const { owner: o, repo: r } = requireRepo(owner, repo);
    const targetBase = base ?? selectedRepo?.default_branch;
    if (!targetBase) throw new Error("Could not determine base branch — pass base explicitly.");

    const pr = await gh(`/repos/${o}/${r}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, head, base: targetBase, body, draft }),
      headers: { ...baseHeaders, "Content-Type": "application/json" },
    });

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

// ── list_pull_requests ────────────────────────────────────────────────────────

server.tool(
  "list_pull_requests",
  "List PRs in the active repo. No local clone needed.",
  {
    state: z.enum(["open", "closed", "all"]).optional().default("open"),
    per_page: z.number().min(1).max(100).optional().default(20),
    owner: z.string().optional().describe("Override the active repo owner"),
    repo: z.string().optional().describe("Override the active repo name"),
  },
  async ({ state, per_page, owner, repo }) => {
    const { owner: o, repo: r } = requireRepo(owner, repo);
    const prs = await gh(`/repos/${o}/${r}/pulls?state=${state}&per_page=${per_page}&sort=updated&direction=desc`);
    const result = prs.map((p) => ({
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
    return {
      content: [{ type: "text", text: `${state} PRs in ${o}/${r} (${result.length}):\n\n${JSON.stringify(result, null, 2)}` }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
