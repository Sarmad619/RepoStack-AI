const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const OpenAI = require('openai');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

let openai = null;
if (!process.env.OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. OpenAI calls will fail until it is configured. Endpoints will return helpful errors.');
} else {
  try {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } catch (err) {
    console.warn('OpenAI client initialization failed:', err && err.message ? err.message : err);
    openai = null;
  }
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function fetchRepoContents(owner, repo, token) {
  const headers = token ? { Authorization: `token ${token}` } : {};
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const result = { readme: null, languages: null, files: [] };
  try {
    const readmeRes = await axios.get(`${base}/readme`, { headers });
    if (readmeRes.data && readmeRes.data.content) {
      const buff = Buffer.from(readmeRes.data.content, readmeRes.data.encoding || 'base64');
      result.readme = buff.toString('utf8');
    }
  } catch (err) {
    // ignore README fetch errors
  }
  try {
    const langRes = await axios.get(`${base}/languages`, { headers });
    result.languages = Object.keys(langRes.data || {});
  } catch (err) {
    // ignore
  }
  // Try to fetch common dependency files at repo root
  const depFiles = ['package.json', 'requirements.txt', 'pyproject.toml'];
  for (const f of depFiles) {
    try {
      const r = await axios.get(`${base}/contents/${f}`, { headers });
      if (r.data && r.data.content) {
        const buff = Buffer.from(r.data.content, r.data.encoding || 'base64');
        result.files.push({ path: f, content: buff.toString('utf8') });
      }
    } catch (err) {
      // skip
    }
  }
  return result;
}

async function fetchRepoTreeAndFiles(owner, repo, token, opts = {}) {
  // opts: { maxFiles = 50, maxBytes = 200000 }
  const maxFiles = opts.maxFiles || 50;
  const maxBytes = opts.maxBytes || 200000; // 200 KB
  const headers = token ? { Authorization: `token ${token}` } : {};
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const result = { files: [], totalBytes: 0 };
  try {
    // Get default branch
    const repoRes = await axios.get(base, { headers });
    const defaultBranch = repoRes.data.default_branch || 'main';
    sendLogIfPossible();
    // Get git tree recursively
    const treeRes = await axios.get(`${base}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`, { headers });
    const tree = treeRes.data.tree || [];
    // Filter blobs and keep common source file extensions
    const exts = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.cs', '.rb', '.php', '.json', '.md', '.html', '.css'];
    const candidates = tree.filter(t => t.type === 'blob' && exts.some(e => t.path.endsWith(e)));
    // Sort by path length (prefer top-level) and then by size if available
    candidates.sort((a, b) => (a.path.split('/').length - b.path.split('/').length) || ((b.size || 0) - (a.size || 0)));
    for (const item of candidates) {
      if (result.files.length >= maxFiles) break;
      if (result.totalBytes >= maxBytes) break;
      try {
        const fileRes = await axios.get(`${base}/contents/${encodeURIComponent(item.path)}?ref=${encodeURIComponent(defaultBranch)}`, { headers });
        if (fileRes.data && fileRes.data.content) {
          const buff = Buffer.from(fileRes.data.content, fileRes.data.encoding || 'base64');
          const content = buff.toString('utf8');
          // truncate very large files
          const truncated = content.length > 100000 ? content.slice(0, 100000) + '\n\n...TRUNCATED...' : content;
          const bytes = Buffer.byteLength(truncated, 'utf8');
          if (result.totalBytes + bytes > maxBytes) break;
          result.files.push({ path: item.path, content: truncated });
          result.totalBytes += bytes;
        }
      } catch (err) {
        // skip file fetch errors
      }
    }
  } catch (err) {
    // return partial result
  }
  return result;

  // local helper to avoid lint warnings when used internally
  function sendLogIfPossible() { /* placeholder; caller may send SSE logs separately */ }
}

function makePrompt(repoUrl, data) {
  return `You are a repository analysis agent. Analyze the repository at ${repoUrl} and respond with ONLY valid JSON exactly matching the schema: {"project_summary":string,"primary_languages": [string],"key_frameworks":[string],"possible_use_cases":[string],"difficulty_rating":string}.\n\nREADME:\n${data.readme || ''}\n\nDependency files:\n${data.files.map(f => `--- ${f.path}\n${f.content}`).join('\n\n')}`;
}

app.get('/api/analyze', async (req, res) => {
  const repo = req.query.repo;
  if (!repo) return res.status(400).json({ error: 'missing repo query parameter' });
  // Parse owner/repo
  const m = repo.match(/github.com\/(.+?)\/(.+?)(?:$|\/|\.)/i);
  if (!m) return res.status(400).json({ error: 'invalid github repo url' });
  const owner = m[1];
  const repoName = m[2];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sendSSE(res, 'log', { message: 'Starting analysis' });
  try {
    sendSSE(res, 'log', { message: 'Fetching repository contents' });
    const data = await fetchRepoContents(owner, repoName, process.env.GITHUB_TOKEN);
    sendSSE(res, 'log', { message: 'Fetched README and dependency files' });

    const prompt = makePrompt(repo, data);
    sendSSE(res, 'log', { message: 'Sending data to OpenAI for structured analysis' });
      if (!openai) {
        sendSSE(res, 'error', { message: 'OpenAI API key not configured on server. Set OPENAI_API_KEY to enable analysis.' });
        res.end();
        return;
      }

      const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'You output strict JSON only.' }, { role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.1
    });

    const text = completion.choices?.[0]?.message?.content || completion.choices?.[0]?.text || '';
    // Try to parse JSON out of the response
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (err) {
      // Attempt to extract JSON substring
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        try { json = JSON.parse(text.slice(start, end + 1)); } catch (e) { }
      }
    }

    if (!json) {
      sendSSE(res, 'error', { message: 'OpenAI did not return parseable JSON', raw: text });
      res.end();
      return;
    }

    sendSSE(res, 'log', { message: 'Received analysis from OpenAI' });
    sendSSE(res, 'result', { analysis: json });
    res.end();
  } catch (err) {
    sendSSE(res, 'error', { message: err.message || String(err) });
    res.end();
  }
});

// Walkthrough / Q&A endpoint: accepts repo and question, streams logs and final JSON result
app.get('/api/walkthrough', async (req, res) => {
  const repo = req.query.repo;
  const question = req.query.question;
  if (!repo) return res.status(400).json({ error: 'missing repo query parameter' });
  if (!question) return res.status(400).json({ error: 'missing question query parameter' });
  const m = repo.match(/github.com\/(.+?)\/(.+?)(?:$|\/|\.)/i);
  if (!m) return res.status(400).json({ error: 'invalid github repo url' });
  const owner = m[1];
  const repoName = m[2];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sendSSE(res, 'log', { message: 'Starting walkthrough' });
  try {
    sendSSE(res, 'log', { message: 'Fetching repository tree and source files (limited)' });
    const filesData = await fetchRepoTreeAndFiles(owner, repoName, process.env.GITHUB_TOKEN, { maxFiles: 60, maxBytes: 300000 });
    sendSSE(res, 'log', { message: `Fetched ${filesData.files.length} files (${filesData.totalBytes} bytes)` });

    // Build a detailed prompt that includes the question and the collected files
    let prompt = `You are an expert code reviewer and software engineer. The user asked: "${question}"\n\n`;
    prompt += 'Use the provided repository files to answer the question in depth. When referencing code, include file paths and short code snippets. If you trace a request or function across files, show the step-by-step trace. If you cannot find an answer in the provided files, be explicit about what is missing and where to look. Output ONLY valid JSON matching the schema: {"answer":"string","references":[{"path":"string","excerpt":"string"}],"trace": ["step descriptions"]}.\n\n';
    prompt += 'Repository files:\n';
    for (const f of filesData.files) {
      prompt += `--- ${f.path}\n${f.content}\n\n`;
    }

    sendSSE(res, 'log', { message: 'Sending data to OpenAI for walkthrough answer' });

    if (!openai) {
      sendSSE(res, 'error', { message: 'OpenAI API key not configured on server. Set OPENAI_API_KEY to enable walkthroughs.' });
      res.end();
      return;
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'You are a helpful, precise assistant. Return strict JSON only.' }, { role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.2
    });

    const text = completion.choices?.[0]?.message?.content || completion.choices?.[0]?.text || '';
    let json = null;
    try { json = JSON.parse(text); } catch (err) {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        try { json = JSON.parse(text.slice(start, end + 1)); } catch (e) { }
      }
    }

    if (!json) {
      sendSSE(res, 'error', { message: 'OpenAI did not return parseable JSON for walkthrough', raw: text });
      res.end();
      return;
    }

    sendSSE(res, 'log', { message: 'Received walkthrough answer from OpenAI' });
    sendSSE(res, 'result', { walkthrough: json });
    res.end();
  } catch (err) {
    sendSSE(res, 'error', { message: err.message || String(err) });
    res.end();
  }
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
