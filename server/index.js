const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const OpenAI = require('openai');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Simple in-memory rate limiter (per IP). Configurable via env vars.
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '10', 10); // 10 requests per window
const rateStore = new Map();

function rateLimitMiddleware(req, res, next) {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateStore.get(ip) || { count: 0, windowStart: now };
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    rateStore.set(ip, entry);
    if (entry.count > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'rate_limited', message: `Too many requests. Limit is ${RATE_LIMIT_MAX} per ${RATE_LIMIT_WINDOW_MS/1000}s` });
    }
    next();
  } catch (err) {
    // don't block on rate limiter errors
    next();
  }
}

// Apply rate limiter to analysis endpoints
app.use(['/api/analyze', '/api/walkthrough'], rateLimitMiddleware);

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

// In-memory per-repo rules store: { "owner/repo": { whitelist: [], blacklist: [] } }
const rulesStore = new Map();


function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// axios get with retry/backoff
async function axiosGetWithRetry(url, opts = {}, attempts = 3, backoff = 300) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios.get(url, opts);
    } catch (err) {
      lastErr = err;
      // exponential backoff
      await new Promise(r => setTimeout(r, backoff * Math.pow(2, i)));
    }
  }
  throw lastErr;
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

async function fetchRepoTreeAndFiles(owner, repo, token, opts = {}, logger = null, question = '') {
  // opts: { maxFiles = 50, maxBytes = 200000 }
  const maxFiles = opts.maxFiles || 50;
  const maxBytes = opts.maxBytes || 200000; // 200 KB
  const headers = token ? { Authorization: `token ${token}` } : {};
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const result = { files: [], totalBytes: 0 };
  try {
    // Get default branch
    const repoRes = await axiosGetWithRetry(base, { headers });
    const defaultBranch = repoRes.data.default_branch || 'main';
    if (logger) try { logger('Determined default branch: ' + defaultBranch) } catch(e){}
    // Get git tree recursively
    const treeRes = await axiosGetWithRetry(`${base}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`, { headers });
    const tree = treeRes.data.tree || [];
    // Filter blobs and keep common source file extensions
    const exts = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.cs', '.rb', '.php', '.json', '.md', '.html', '.css'];
    const candidates = tree.filter(t => t.type === 'blob' && exts.some(e => t.path.endsWith(e)));
    // Skip well-known vendor / third-party directories unless overridden by per-repo rules
    const skipPatterns = ['node_modules/', 'vendor/', 'third_party/', 'site-packages/', 'dist/', 'build/', 'coverage/', '.pytest_cache/', '.venv/', '__pycache__/', '.git/'];
    const repoKey = `${owner}/${repo}`;
    const rules = rulesStore.get(repoKey) || { whitelist: [], blacklist: [] };
    const filteredCandidates = candidates.filter(t => {
      // If path matches a whitelist pattern, include it
      for (const w of rules.whitelist || []) {
        if (t.path.includes(w)) return true;
      }
      // If path matches a blacklist pattern, exclude it
      for (const b of rules.blacklist || []) {
        if (t.path.includes(b)) return false;
      }
      return !skipPatterns.some(p => t.path.includes(p));
    });
    // Sort by path length (prefer top-level) and then by size if available
    filteredCandidates.sort((a, b) => (a.path.split('/').length - b.path.split('/').length) || ((b.size || 0) - (a.size || 0)));

    // Prepare keywords (fallback) and an initial candidate window to fetch content for scoring
    const keywords = (question || '').toLowerCase().split(/\W+/).filter(w => w.length > 3);
    // Fetch a larger window for potential semantic reranking
    let topCandidates = filteredCandidates.slice(0, 500);

    // Ensure dependency files (package.json, pyproject.toml, requirements.txt) are included later
    const depFilesSet = new Set(['package.json','requirements.txt','pyproject.toml']);

    // Two-pass: fetch content for top candidates and compute content-based relevance using keywords
    const scoredFiles = [];
    for (const item of topCandidates) {
      if (result.files.length >= maxFiles) break;
      if (result.totalBytes >= maxBytes) break;
      try {
        const fileRes = await axiosGetWithRetry(`${base}/contents/${encodeURIComponent(item.path)}?ref=${encodeURIComponent(defaultBranch)}`, { headers });
        if (fileRes.data && fileRes.data.content) {
          const buff = Buffer.from(fileRes.data.content, fileRes.data.encoding || 'base64');
          const content = buff.toString('utf8');
          // truncate very large files at fetch level
          const truncated = content.length > 100000 ? content.slice(0, 100000) + '\n\n...TRUNCATED...' : content;
          // compute a simple relevance score using keywords in path and content
          let score = 0;
          const pathLower = item.path.toLowerCase();
          for (const k of keywords) { if (pathLower.includes(k)) score += 10; }
          const contentLower = truncated.toLowerCase();
          for (const k of keywords) {
            const occ = (contentLower.match(new RegExp(k, 'g')) || []).length;
            score += Math.min(occ, 20); // cap per keyword
          }
          scoredFiles.push({ path: item.path, content: truncated, bytes: Buffer.byteLength(truncated, 'utf8'), score, originalItem: item });
        }
      } catch (err) {
        if (logger) try { logger(`Skipped ${item.path} due to fetch error`); } catch(e){}
        // skip file fetch errors
      }
    }

    // If we have a question and OpenAI embeddings available, compute embeddings to re-rank semantically
    if (question && openai && openai.embeddings && scoredFiles.length > 0) {
      try {
        const texts = [question].concat(scoredFiles.map(f => f.content.slice(0, 2000)));
        const embRes = await openai.embeddings.create({ model: 'text-embedding-3-large', input: texts });
        const vectors = embRes.data.map(d => d.embedding);
        const qVec = vectors[0];
        const fileVecs = vectors.slice(1);
        // cosine similarity helpers
        function dot(a,b){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s}
        function norm(a){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*a[i];return Math.sqrt(s)}
        const qNorm = norm(qVec);
        scoredFiles.forEach((f, idx)=>{
          const fv = fileVecs[idx];
          const sim = qNorm===0 ? 0 : dot(qVec,fv)/(qNorm*norm(fv));
          f.semanticScore = sim;
          // combine with fallback score
          f.finalScore = (f.score || 0) * 0.2 + sim * 100;
        });
        scoredFiles.sort((a,b)=> (b.finalScore - a.finalScore) || (a.path.split('/').length - b.path.split('/').length));
      } catch (err) {
        // fallback to keyword ranking
        scoredFiles.sort((a,b)=> (b.score - a.score) || (a.path.split('/').length - b.path.split('/').length));
      }
    } else {
      // Sort by score and then by path depth
      scoredFiles.sort((a,b)=> (b.score - a.score) || (a.path.split('/').length - b.path.split('/').length));
    }

    // Add top scored files until limits hit and include metadata about truncation
    for (const f of scoredFiles) {
      if (result.files.length >= maxFiles) break;
      if (result.totalBytes + f.bytes > maxBytes) break;
      const isTruncated = f.content.endsWith('\n\n...TRUNCATED...');
      result.files.push({ path: f.path, content: isTruncated ? f.content.replace('\n\n...TRUNCATED...','') : f.content, truncated: isTruncated, bytes: f.bytes, score: f.finalScore || f.score });
      result.totalBytes += f.bytes;
    }

    // Always ensure dependency files are present (fetch them if they exist and we still have headroom)
    for (const dep of Array.from(depFilesSet)) {
      if (result.files.some(ff => ff.path === dep)) continue;
      try {
        const r = await axiosGetWithRetry(`${base}/contents/${dep}`, { headers });
        if (r.data && r.data.content) {
          const buff = Buffer.from(r.data.content, r.data.encoding || 'base64');
          const content = buff.toString('utf8');
          const bytes = Buffer.byteLength(content, 'utf8');
          if (result.totalBytes + bytes <= maxBytes) {
            result.files.push({ path: dep, content });
            result.totalBytes += bytes;
          }
        }
      } catch (err) {
        // ignore missing dep files
      }
    }
  } catch (err) {
    if (logger) try { logger('Error while building file list: ' + (err && err.message ? err.message : String(err))); } catch(e){}
    // return partial result
  }
  return result;
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
  const filesData = await fetchRepoTreeAndFiles(owner, repoName, process.env.GITHUB_TOKEN, { maxFiles: 60, maxBytes: 300000 }, (m)=>sendSSE(res,'log',{message:m}), question);
    sendSSE(res, 'log', { message: `Fetched ${filesData.files.length} files (${filesData.totalBytes} bytes)` });

    // Early exit if no files were fetched (rate limit, private repo, invalid URL, etc.)
    if (!filesData.files || filesData.files.length === 0) {
      sendSSE(res, 'log', { message: 'No repository files fetched; cannot produce walkthrough.' });
      const reason = 'No files could be fetched from GitHub (possible 403 rate limit, missing GITHUB_TOKEN for private repo, or invalid repository). Configure GITHUB_TOKEN and try again.';
      sendSSE(res, 'result', { walkthrough: { answer: '', references: [], trace: [], sources: [], missing: [], cannot_answer: true, reason } });
      res.end();
      return;
    }

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

  // Updated system instruction: allow partial answers & explicitly call out missing aspects.
  // Schema now includes a "missing" array listing requested concepts/features not found.
  // Only use repository files; NEVER invent functionality. Provide high-level summaries when asked.
  const systemMsg = `You are a disciplined repository code analyst. You MUST use ONLY the repository files provided in the user's message.\nReturn ONLY valid JSON exactly matching the schema: {"answer":"string","references":[{"path":"string","excerpt":"string"}],"trace":["string"],"sources":["string"],"missing":["string"],"cannot_answer":boolean,"reason":string}.\nGuidelines:\n- Always attempt to answer with what IS present in the provided files.\n- Never mention or reference a file path that is not EXACTLY one of the provided file paths.\n- For each explicit feature or concept the user asks about that is NOT present (e.g. authentication, payment, database), add a short phrase to the 'missing' array (e.g. "authentication") and DO NOT fabricate implementation details.\n- Do NOT hallucinate code, files, libraries, or frameworks.\n- If some relevant information exists, set cannot_answer=false even if some requested concepts are missing; list those missing concepts in 'missing'.\n- Only set cannot_answer=true when NOTHING in the repo can help answer ANY part of the question. In that case answer='', references=[], trace=[], missing=[], and give a concise reason.\n- Provide at least one reference and list each file you drew from in 'sources'.\n- References excerpts must be exact substrings from the file content.\n- Keep the answer concise and scoped strictly to the repository contents.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: systemMsg }, { role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.0
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

    // Validate returned references/sources; allow auto-fix if missing.
    const availablePaths = new Set(filesData.files.map(f => f.path));
    const allFetched = filesData.files.map(f => f.path);

    if (!Array.isArray(json.sources)) json.sources = [];
    if (!Array.isArray(json.references)) json.references = [];
    if (!Array.isArray(json.missing)) json.missing = [];

    // Filter invalid sources
    json.sources = json.sources.filter(s => typeof s === 'string' && availablePaths.has(s));
    // Filter invalid references
    json.references = json.references.filter(r => r && typeof r.path === 'string' && availablePaths.has(r.path));

    // Auto-populate sources if empty but we have fetched files
    if (json.sources.length === 0 && allFetched.length > 0 && json.cannot_answer !== true) {
      json.sources = allFetched.slice(0, Math.min(5, allFetched.length));
    }

    // If references empty but sources exist, synthesize a simple reference (first file snippet)
    if (json.references.length === 0 && json.sources.length > 0 && json.cannot_answer !== true) {
      const first = filesData.files.find(f => f.path === json.sources[0]);
      if (first) {
        json.references.push({ path: first.path, excerpt: (first.content || '').slice(0, 300) });
      }
    }

    // Decide final cannot_answer: only true if explicitly set OR still no references and answer is empty
    if (json.cannot_answer === true || (json.references.length === 0 && (!json.answer || json.answer.trim()===''))) {
      json.cannot_answer = true;
      json.answer = '';
      json.references = [];
      json.trace = [];
      json.missing = [];
      if (!json.reason) json.reason = 'The information required to answer this question is not present in the provided repository files.';
      sendSSE(res, 'log', { message: 'Walkthrough: no in-repo basis for answer (cannot_answer=true)' });
      sendSSE(res, 'result', { walkthrough: json });
      res.end();
      return;
    } else {
      json.cannot_answer = false;
      if (!json.reason) json.reason = '';
    }

    // Hallucination mitigation: detect file names mentioned in answer that were not fetched
    const answerText = typeof json.answer === 'string' ? json.answer : '';
    if (answerText) {
      const fileLikeRegex = /[A-Za-z0-9_\-\.\/]+\.(?:js|jsx|ts|tsx|py|java|go|rb|php|rs|c|cpp|cs|json|md|html|css)/g;
      const mentioned = Array.from(new Set(answerText.match(fileLikeRegex) || []));
      const availablePaths = new Set(filesData.files.map(f => f.path));
      const unknown = mentioned.filter(m => !availablePaths.has(m));
      if (unknown.length > 0) {
        // Remove paragraphs that solely describe unknown files
        const paras = answerText.split(/\n\n+/);
        const filteredParas = paras.filter(p => !unknown.some(u => p.includes(u)) || availablePaths.has(p.trim()));
        let newAnswer = filteredParas.join('\n\n').trim();
        if (!newAnswer) {
          json.cannot_answer = false; // we still can provide partial high-level answer using existing files
          newAnswer = 'Some requested components or files are not present in this repository.';
        }
        json.answer = newAnswer;
        // Add unknown file concepts to missing (without duplicates, remove extensions to treat as concept?)
        const additions = unknown.map(u => u.replace(/\.[^.]+$/, '')); // strip extension for concept tag
        additions.forEach(a => { if (!json.missing.includes(a)) json.missing.push(a); });
        // Add a short note in reason if reason empty
        if (!json.reason) json.reason = 'Removed references to files not present in repository.';
      }
    }

    sendSSE(res, 'log', { message: 'Walkthrough answer (repo-scoped) ready' });
    sendSSE(res, 'result', { walkthrough: json });
    res.end();
  } catch (err) {
    sendSSE(res, 'error', { message: err.message || String(err) });
    res.end();
  }
});

// Rules management endpoints
app.get('/api/rules', (req, res) => {
  const repo = req.query.repo;
  if (!repo) return res.status(400).json({ error: 'missing repo query parameter' });
  const m = repo.match(/github.com\/(.+?)\/(.+?)(?:$|\/|\.)/i);
  if (!m) return res.status(400).json({ error: 'invalid github repo url' });
  const key = `${m[1]}/${m[2]}`;
  const rules = rulesStore.get(key) || { whitelist: [], blacklist: [] };
  res.json({ repo: key, rules });
});

app.post('/api/rules', (req, res) => {
  const { repo, rules } = req.body || {};
  if (!repo || !rules) return res.status(400).json({ error: 'missing repo or rules in body' });
  const m = repo.match(/(?:github.com\/)?(.+?)\/(.+?)(?:$|\/|\.)/i);
  if (!m) return res.status(400).json({ error: 'invalid repo format' });
  const key = `${m[1]}/${m[2]}`;
  const normalized = { whitelist: Array.isArray(rules.whitelist) ? rules.whitelist : [], blacklist: Array.isArray(rules.blacklist) ? rules.blacklist : [] };
  rulesStore.set(key, normalized);
  res.json({ repo: key, rules: normalized });
});

// Fetch single file content on-demand (bypasses truncation)
app.get('/api/file', async (req, res) => {
  const repo = req.query.repo;
  const path = req.query.path;
  if (!repo || !path) return res.status(400).json({ error: 'missing repo or path query parameter' });
  const m = repo.match(/github.com\/(.+?)\/(.+?)(?:$|\/|\.)/i);
  if (!m) return res.status(400).json({ error: 'invalid github repo url' });
  const owner = m[1];
  const repoName = m[2];
  try {
    const headers = process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {};
    const repoRes = await axios.get(`https://api.github.com/repos/${owner}/${repoName}` , { headers });
    const defaultBranch = repoRes.data.default_branch || 'main';
    const fileRes = await axios.get(`https://api.github.com/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(defaultBranch)}`, { headers });
    if (fileRes.data && fileRes.data.content) {
      const buff = Buffer.from(fileRes.data.content, fileRes.data.encoding || 'base64');
      const content = buff.toString('utf8');
      res.json({ path, content });
      return;
    }
    res.status(404).json({ error: 'file not found' });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
