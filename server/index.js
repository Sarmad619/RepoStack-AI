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

if (!process.env.OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. OpenAI calls will fail until it is configured.');
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
