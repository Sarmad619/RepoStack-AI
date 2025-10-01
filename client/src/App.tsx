import React, { useState, useEffect, useRef } from 'react'
import axios from 'axios'

function Badge({ text }: { text: string }) {
  return <span className="inline-block bg-gradient-to-r from-[#00a884] to-[#00675b] text-black px-3 py-1 rounded-full text-sm mr-2">{text}</span>
}

function LogPanel({ logs, collapsed, onToggle }: any) {
  return (
      <div className={`transition-all duration-200 ${collapsed ? 'h-10 overflow-hidden' : 'h-48'}`}>
      <div className="flex items-center justify-between p-2 text-xs text-gray-300">
        <div>Agent Log</div>
        <button onClick={onToggle} className="text-sm underline">{collapsed ? 'Expand' : 'Collapse'}</button>
      </div>
      <div className="agent-log p-2 font-mono text-[12px] text-gray-200 overflow-auto h-36">{logs.map((l:any,i:number)=>(<div key={i}>• {l}</div>))}</div>
    </div>
  )
}

function ReferenceCard({ refData }: any) {
  const [open, setOpen] = useState(false)
  const excerpt = refData?.excerpt || ''
  const truncated = excerpt.length > 400 ? excerpt.slice(0, 400) + '\n\n...TRUNCATED...' : excerpt

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(excerpt)
      // lightweight feedback
      // eslint-disable-next-line no-alert
      alert('Reference copied to clipboard')
    } catch (err) {
      console.warn('clipboard copy failed', err)
    }
  }

  return (
    <div className="p-3 bg-[rgba(255,255,255,0.01)] rounded border border-[rgba(255,255,255,0.03)]">
      <div className="flex items-start justify-between">
        <div className="text-sm font-medium text-gray-100">{refData.path}</div>
        <div className="flex gap-2">
          <button onClick={()=>setOpen(o=>!o)} className="text-xs px-2 py-1 bg-[rgba(255,255,255,0.03)] rounded">{open ? 'Hide' : 'Show'}</button>
          <button onClick={copyToClipboard} className="text-xs px-2 py-1 bg-[rgba(255,255,255,0.03)] rounded">Copy</button>
        </div>
      </div>
      <div className="mt-2 text-xs text-gray-200 font-mono">
        {open ? (
          <pre className="whitespace-pre-wrap text-[12px]">{excerpt}</pre>
        ) : (
          <pre className="whitespace-pre-wrap text-[12px]">{truncated}</pre>
        )}
      </div>
    </div>
  )
}

// Per-repo RuleManager removed temporarily

export default function App(){
  const [repo, setRepo] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [analysis, setAnalysis] = useState<any>(null)
  const [question, setQuestion] = useState('Give me a high-level walkthrough of the codebase and where authentication is handled.')
  const [walkthrough, setWalkthrough] = useState<any>(null)
  const evtSourceRef = useRef<EventSource | null>(null)

  useEffect(()=>{ return ()=>{ if (evtSourceRef.current) evtSourceRef.current.close() } }, [])

  function addLog(msg:string){ setLogs(s=>[...s, msg]) }

  const analyze = async () => {
    setLogs([])
    setAnalysis(null)
    if (evtSourceRef.current) evtSourceRef.current.close()
    const url = `http://localhost:4000/api/analyze?repo=${encodeURIComponent(repo)}`
    const es = new EventSource(url)
    evtSourceRef.current = es
    es.addEventListener('log', (e:any)=>{ const d=JSON.parse(e.data); addLog(d.message) })
    es.addEventListener('result', (e:any)=>{ const d=JSON.parse(e.data); setAnalysis(d.analysis) })
    es.addEventListener('error', (e:any)=>{ const d=JSON.parse(e.data); addLog('ERROR: '+(d.message||JSON.stringify(d))) })
    es.onerror = (ev)=>{ addLog('EventSource error'); es.close(); }
  }

  const askWalkthrough = async () => {
    setLogs([])
    setWalkthrough(null)
    if (evtSourceRef.current) evtSourceRef.current.close()
    const url = `http://localhost:4000/api/walkthrough?repo=${encodeURIComponent(repo)}&question=${encodeURIComponent(question)}`
    const es = new EventSource(url)
    evtSourceRef.current = es
    es.addEventListener('log', (e:any)=>{ const d=JSON.parse(e.data); addLog(d.message) })
    es.addEventListener('result', (e:any)=>{ const d=JSON.parse(e.data); setWalkthrough(d.walkthrough) })
    es.addEventListener('error', (e:any)=>{ try{ const d=JSON.parse(e.data); addLog('ERROR: '+(d.message||JSON.stringify(d))) }catch{ addLog('Unknown error event') } })
    es.onerror = (ev)=>{ addLog('EventSource error'); es.close(); }
  }

  const fetchFullFile = async (path:string)=>{
    try{
      const r = await axios.get(`http://localhost:4000/api/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`)
      return r.data.content
    }catch(err){ console.warn(err); return null }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#001021] via-[#00373a] to-[#00a884] text-white p-8 font-sans">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <h1 className="text-3xl font-bold">RepoStackAI</h1>
          <p className="text-sm text-gray-300">Mission control for repository analysis</p>
        </header>

        <section className="mb-6 p-6 bg-[rgba(255,255,255,0.03)] rounded-xl shadow-lg">
          <div className="flex gap-2">
            <input className="flex-1 p-3 bg-transparent border border-dotted border-gray-600 rounded-md" placeholder="https://github.com/owner/repo" value={repo} onChange={e=>setRepo(e.target.value)} />
            <button onClick={analyze} className="px-4 py-2 bg-gradient-to-r from-[#00373a] to-[#00a884] hover:shadow-[0_0_20px_rgba(0,168,132,0.5)] rounded">Analyze</button>
            <button onClick={askWalkthrough} className="px-4 py-2 bg-gradient-to-r from-[#7b6bff] to-[#5a3cff] hover:shadow-[0_0_20px_rgba(123,107,255,0.4)] rounded">Deep Dive</button>
          </div>
          {/* RuleManager removed */}
          <div className="mt-3">
            <input value={question} onChange={e=>setQuestion(e.target.value)} className="w-full p-2 bg-transparent border border-dashed border-gray-600 rounded-md text-sm" />
            <div className="text-xs text-gray-400 mt-1">Ask targeted questions about the codebase (e.g., "Where is auth handled?", "Trace request X").</div>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="md:col-span-2 p-6 bg-[rgba(255,255,255,0.02)] rounded-xl">
            <h2 className="text-xl mb-2">Summary</h2>
            {analysis ? (
              <div>
                <p className="mb-2">{analysis.project_summary}</p>
                <div className="mb-2"><strong>Languages:</strong> {analysis.primary_languages?.map((l:string)=>(<Badge key={l} text={l} />))}</div>
                <div className="mb-2"><strong>Frameworks:</strong> {analysis.key_frameworks?.map((l:string)=>(<Badge key={l} text={l} />))}</div>
                <div className="mb-2"><strong>Use Cases:</strong>
                  <div className="mt-2 grid grid-cols-2 gap-2">{analysis.possible_use_cases?.map((u:string,i:number)=>(<div key={i} className="p-2 bg-[rgba(255,255,255,0.02)] rounded">{u}</div>))}</div>
                </div>
                <div className="mt-4 p-3 inline-block bg-gradient-to-r from-[#7ef3d1] to-[#00a884] text-black rounded">Difficulty: {analysis.difficulty_rating}</div>
              </div>
            ) : (
              <div className="text-gray-400">No analysis yet. Provide a GitHub repo URL and click Analyze.</div>
            )}

            {walkthrough ? (
              <div className="mt-6 p-4 bg-[rgba(255,255,255,0.02)] rounded">
                <h3 className="text-lg mb-3">Walkthrough</h3>
                {walkthrough.cannot_answer && (
                  <div className="mb-4 p-3 border border-red-500/40 bg-red-900/20 rounded">
                    <div className="text-sm font-semibold text-red-300 mb-1">Cannot answer from repository</div>
                    <div className="text-xs text-red-200 whitespace-pre-wrap">{walkthrough.reason || 'Requested information not present in repository.'}</div>
                  </div>
                )}
                {!walkthrough.cannot_answer && walkthrough.missing && walkthrough.missing.length>0 && (
                  <div className="mb-4 p-3 border border-amber-500/40 bg-amber-900/20 rounded">
                    <div className="text-xs text-amber-200 mb-2">Not found in repo:</div>
                    <div className="flex flex-wrap gap-2">
                      {walkthrough.missing.map((m:string,i:number)=>(
                        <span key={i} className="px-2 py-1 text-[11px] rounded bg-amber-500/20 border border-amber-400/30 text-amber-200">{m}</span>
                      ))}
                    </div>
                  </div>
                )}
                {/* Answer: render paragraphs for readability */}
                <div className="text-sm text-gray-100 mb-4">
                  {typeof walkthrough.answer === 'string' ? (
                    walkthrough.answer.split(/\n\n+/).map((p:string,i:number)=>(
                      <p key={i} className="mb-3 leading-relaxed">{p}</p>
                    ))
                  ) : (
                    <pre className="whitespace-pre-wrap font-mono text-xs">{JSON.stringify(walkthrough.answer, null, 2)}</pre>
                  )}
                </div>

                {/* Trace steps (if any) */}
                {walkthrough.trace && walkthrough.trace.length>0 && (
                  <div className="mb-4">
                    <h4 className="text-sm mb-2">Trace</h4>
                    <ol className="list-decimal pl-5 text-sm text-gray-200">
                      {walkthrough.trace.map((t:any,i:number)=>(<li key={i} className="mb-2">{t}</li>))}
                    </ol>
                  </div>
                )}

                {/* References: show as expandable cards with excerpt and copy */}
                {walkthrough.references && walkthrough.references.length>0 && (
                  <div>
                    <h4 className="text-sm mb-2">References</h4>
                    <div className="space-y-3">
                      {walkthrough.references.map((r:any,i:number)=> (
                        <div key={i}>
                          <ReferenceCard refData={r} />
                          {r.excerpt && r.excerpt.length < 50 && r.path && (
                            <div className="mt-2 text-xs text-gray-400">Excerpt truncated. <button className="underline" onClick={async ()=>{
                              const content = await fetchFullFile(r.path)
                              if (content) {
                                // show full content in alert for now
                                // eslint-disable-next-line no-alert
                                alert(content.slice(0,2000))
                              } else {
                                // eslint-disable-next-line no-alert
                                alert('Failed to fetch file content')
                              }
                            }}>Fetch full file</button></div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="p-6 bg-[rgba(255,255,255,0.02)] rounded-xl">
            <LogPanel logs={logs} collapsed={collapsed} onToggle={()=>setCollapsed(!collapsed)} />
          </div>
        </section>
      </div>
    </div>
  )
}
