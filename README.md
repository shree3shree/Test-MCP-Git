# GitHub MCP Server

An MCP server that connects GitHub Copilot Chat (and Claude) to your GitHub account.

## Tools

| Tool | What it does |
|---|---|
| `list_repos` | List all your repos (sorted by last push by default) |
| `list_branches` | List branches in a repo |
| `get_recent_commits` | Show recent commits on a branch |
| `get_diff` | Compare two branches/commits — great before making a PR |
| `create_pull_request` | Open a PR (supports draft PRs) |
| `list_pull_requests` | List open/closed PRs in a repo |

---

## Setup

### 1. Prerequisites

- **Node.js 18+** — check with `node -v`
- **VS Code 1.99+** — check with `code -v`
- **GitHub Copilot Chat** extension installed in VS Code

### 2. Install dependencies

```bash
cd github-mcp
npm install
```

### 3. Get a GitHub token

Go to https://github.com/settings/tokens → **Generate new token (classic)**

Required scope: `repo` (full repo access, including private repos)

Copy the token — you only see it once.

### 4. Configure the MCP server

Copy `.vscode/mcp.json` into your project's `.vscode/` folder (or keep it in
the `github-mcp` folder if you're opening that directly in VS Code).

Edit the two placeholders:

```json
{
  "servers": {
    "github": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/github-mcp/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

- Replace `/absolute/path/to/github-mcp/index.js` with the real path, e.g.
  - Mac/Linux: `/Users/you/github-mcp/index.js`
  - Windows: `C:\\Users\\you\\github-mcp\\index.js`
- Replace `ghp_your_token_here` with your token.

> **Global setup (optional):** To use this across all projects, add the same
> block under `"mcp"` → `"servers"` in your VS Code `settings.json` instead.

### 5. Enable the server in VS Code

1. Open VS Code in the folder that contains `.vscode/mcp.json`
2. You'll see a prompt: **"MCP server 'github' found — Enable?"** → click **Allow**
3. Alternatively: open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run
   **"MCP: List Servers"** to verify it's running

### 6. Use it in Copilot Chat

1. Open Copilot Chat (`Cmd+Shift+I` / `Ctrl+Shift+I`)
2. Switch to **Agent mode** using the mode picker at the bottom of the chat input
3. Type `#` to see available tools, or just ask naturally:

```
List all my GitHub repos
Show me what changed on feature/auth vs main in my-repo
Create a PR from feature/auth into main titled "Add OAuth login"
List open PRs in owner/repo
```

---

## Security

- Your token is passed as an env variable and never leaves your machine.
- Use a **fine-grained personal access token** scoped to specific repos for tighter control.
- Add `.vscode/mcp.json` to `.gitignore` if your token is hardcoded, or use an
  environment variable reference instead:

```json
"env": {
  "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
}
```

Then set `GITHUB_TOKEN` in your shell profile (`~/.zshrc`, `~/.bashrc`, etc.).
