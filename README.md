# RepoStackAI

RepoStackAI analyzes GitHub repositories and returns a structured project summary. It consists of a React + TypeScript frontend and an Express backend that orchestrates GitHub data collection and calls the OpenAI API to perform the analysis.

Note: A previously available "Per-repo Rules" feature (manual whitelist/blacklist of file path substrings) has been temporarily removed for simplification. The backend now applies only a built‑in skip list for common vendor/build directories. This notice will be updated if/when the feature returns.


# RepoStackAI

RepoStackAI is a lightweight toolkit for quickly analyzing public GitHub repositories. It fetches repository files, applies a repository-scoped LLM analysis (OpenAI), and surfaces a structured summary and walkthrough results in a small React frontend.

This repository contains two main components:

- `server/` — Express backend that fetches GitHub data and calls the OpenAI API.
- `client/` — Vite + React frontend for interacting with the agent and viewing results.

Highlights

- Repository-scoped analysis — the agent is constrained to use only the fetched repository files when producing answers.
- Walkthroughs that include references, trace steps, and a 'missing' list for features not present in the repo.

Quickstart (development)

1) Backend

```powershell
cd server
copy .env.example .env
# Edit server/.env and set OPENAI_API_KEY. Optionally set GITHUB_TOKEN to avoid GitHub rate limits or to access private repos.
npm install
npm run dev
```

2) Frontend

```powershell
cd client
copy .env.example .env
# Edit client/.env if you need to override the API base URL (defaults to http://localhost:4000)
npm install
npm run dev
```

Open the frontend at `http://localhost:5173`.

Environment variables

- `server/.env`
  - `OPENAI_API_KEY` (required) — your OpenAI API key. Keep this secret; do not commit it.
  - `GITHUB_TOKEN` (optional) — a personal access token to increase GitHub rate limits and access private repos.
  - `PORT` (optional) — server port (default 4000).

- `client/.env`
  - `VITE_API_BASE` — base URL for the backend API (defaults to `http://localhost:4000`).

Security and secrets

- Never commit real API keys or tokens. The repository includes `*.env.example` files with empty placeholders. Add `.env` to `.gitignore` (already configured).
- If any sensitive values were accidentally committed, rotate those credentials immediately.

Contributing

- Open issues and PRs on GitHub. Describe the repo URL to test and steps to reproduce.
