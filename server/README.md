# Server — RepoStackAI

Express backend that fetches GitHub repository data and calls the OpenAI API to generate structured JSON analysis.

Setup
1. Copy the environment example and set keys safely:
   ```powershell
   cd server
   copy .env.example .env
   notepad .env
   ```
   - Set `OPENAI_API_KEY` (required). Optionally set `GITHUB_TOKEN` for higher GitHub rate limits.
2. Install and run:
   ```powershell
   npm install
   npm run dev
   ```

API
- `GET /api/analyze?repo=<github-url>` — streams SSE messages with progress logs and a final `result` event containing the analysis JSON.

Security
- Never commit `.env` or API keys to source control. Use environment variables or a secrets service.
- Validate or rotate keys if they are accidentally exposed.
