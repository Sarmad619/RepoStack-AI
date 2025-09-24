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

export default function App(){
  const [repo, setRepo] = useState('')
  const [logs, setLogs] = useState<string[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [analysis, setAnalysis] = useState<any>(null)
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
          </div>

          <div className="p-6 bg-[rgba(255,255,255,0.02)] rounded-xl">
            <LogPanel logs={logs} collapsed={collapsed} onToggle={()=>setCollapsed(!collapsed)} />
          </div>
        </section>
      </div>
    </div>
  )
}
