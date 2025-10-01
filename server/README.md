
# Server — RepoStackAI

Express backend that:

- Fetches repository metadata and source files from GitHub.
- Optionally uses a `GITHUB_TOKEN` to increase rate limits and access private repos.
- Calls the OpenAI API to perform repository-scoped analysis and returns structured JSON via SSE.

Quickstart

```powershell
cd server
copy .env.example .env
# Edit server/.env and set OPENAI_API_KEY (required). Optionally set GITHUB_TOKEN.
npm install
npm run dev
```

Environment variables

- `OPENAI_API_KEY` (required) — your OpenAI API key.
- `GITHUB_TOKEN` (optional) — GitHub personal access token for higher rate limits/private repos.
- `PORT` (optional) — server port (default 4000)

API (development)

- GET /api/analyze?repo=<github-url>
   - Streams progress via Server-Sent Events (SSE). Final `result` event contains structured JSON analysis.

- GET /api/walkthrough?repo=<github-url>&question=<url-encoded-question>
   - Streams logs and a final `result` event containing a JSON object with keys: `answer`, `references`, `trace`, `sources`, `missing`, `cannot_answer`, `reason`.

- GET /api/file?repo=<github-url>&path=<path>
   - Fetches the full content of a single file on demand (bypasses client truncation hints).

Notes and diagnostics

- If the server sees GitHub 403 responses fetching repository trees, include `GITHUB_TOKEN` in `server/.env` to avoid rate limits.
- The service intentionally scopes LLM responses to repository files to reduce hallucination. If zero files are fetched the server will return a `cannot_answer` result with a reason.

Security

- Do not commit `.env` files. The repository includes `.env.example` placeholders only.

Logging & troubleshooting

- Check server console logs for GitHub rate-limit headers (`x-ratelimit-remaining`, `x-ratelimit-reset`) when debugging fetch failures.

Extending

- Per-repo rules (whitelist/blacklist) were previously available but temporarily removed. If you want that feature back, we can reintroduce it behind a feature flag or add persistent storage.

