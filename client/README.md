
# Client — RepoStackAI

Vite + React + TypeScript frontend for interacting with the RepoStackAI backend.

Quickstart (development)

```powershell
cd client
copy .env.example .env
# Optionally set VITE_API_BASE in client/.env if backend runs elsewhere
npm install
npm run dev
```

Open the dev UI at `http://localhost:5173`.

Usage

- Enter a public GitHub repository URL and click `Analyze` to fetch the README and dependency files.
- Use `Deep Dive` to ask targeted questions. The walkthrough displays logs, references, and missing items (features not present in the repo).

Build for production

```powershell
cd client
npm run build
# Build output will go to client/dist/
```

Notes

- `client/dist/` is a generated build artifact. It can be removed from source control and added to `.gitignore` to keep the repo source-only.
- The UI includes a small log panel and reference cards. When excerpts are truncated you can fetch full file content from the backend.

Customization

- Tailwind configuration is in `tailwind.config.cjs` and styles in `src/styles.css`.

