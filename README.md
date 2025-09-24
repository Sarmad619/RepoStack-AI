# RepoStackAI

RepoStackAI analyzes GitHub repositories and returns a structured project summary. It consists of a React + TypeScript frontend and an Express backend that orchestrates GitHub data collection and calls the OpenAI API to perform the analysis.

Quickstart

1. Backend
	 - Copy `server/.env.example` to `server/.env` and set `OPENAI_API_KEY` (required) and `GITHUB_TOKEN` (optional).
	 - Install and start the server:
		 ```powershell
		 cd server
		 npm install
		 npm run dev
		 ```

2. Frontend
	 - Install and start the client:
		 ```powershell
		 cd client
		 npm install
		 npm run dev
		 ```

Open the frontend at `http://localhost:5173`. Provide a public GitHub repository URL and click `Analyze` to run the agent.

Security

- Do not commit `.env` files or API keys. Use environment variables or a secrets manager. This repository contains an example `.env.example` for reference only.
- If credentials were accidentally committed, rotate them immediately.

Files

- `server/` — Express backend, GitHub + OpenAI integration.
- `client/` — Vite React frontend (TypeScript, Tailwind).
