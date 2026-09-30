import React, { useState, useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'

function Setting() {
  const [tab, setTab] = useState('general')
  const [theme, setTheme] = useState<'system'|'light'|'dark'>('system')
  const [isDark, setIsDark] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      if (theme === 'dark') setIsDark(true)
      else if (theme === 'light') setIsDark(false)
      else setIsDark(mql.matches)
    }
    apply()
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [theme])

  const bgPage = isDark ? 'bg-[#0f0f12]' : 'bg-[#fbfbfc]'
  const bgWindow = isDark ? 'bg-[#1e1e1f] border-white/[0.08]' : 'bg-white border-black/10'
  const bgSidebar = isDark ? 'bg-[#18181b] border-white/[0.08]' : 'bg-[#fbfbfc] border-[#ececef]'
  const textMain = isDark ? 'text-white' : 'text-[#1d1d1f]'
  const textMuted = isDark ? 'text-[#a1a1aa]' : 'text-[#8e8e93]'
  const cardBorder = isDark ? 'border-white/[0.08] bg-[#26262a]' : 'border-[#ececef] bg-white'
  const rowBorder = isDark ? 'divide-white/[0.06]' : 'divide-[#f0f0f2]'

  return (
    <div className={`min-h-screen p-6 transition-colors ${bgPage}`}>
      <div className={`max-w-[900px] w-full mx-auto min-h-[580px] rounded-xl overflow-hidden flex shadow-[0_8px_32px_rgba(0,0,0,.18)] border ${bgWindow}`}>
        
        <aside className={`w-[220px] flex flex-col p-2 border-r ${bgSidebar}`}>
          <div className={`px-3 py-3 text-[13px] font-bold tracking-tight ${textMain}`}>ImageShot</div>
          <nav className="flex-1 space-y-0.5 mt-2">
            <button onClick={()=>setTab('general')} className={`w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium ${tab==='general' ? (isDark ? 'bg-white/[0.08] text-white font-semibold' : 'bg-[#efeff0] text-[#1d1d1f] font-semibold') : (isDark ? 'text-[#a1a1aa] hover:bg-white/[0.06]' : 'text-[#3a3a3e] hover:bg-[#f0f0f2]')}`}>General</button>
            <button onClick={()=>setTab('screenshots')} className={`w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium ${tab==='screenshots' ? (isDark ? 'bg-white/[0.08] text-white' : 'bg-[#efeff0] text-[#1d1d1f] font-semibold') : (isDark ? 'text-[#a1a1aa] hover:bg-white/[0.06]' : 'text-[#3a3a3e] hover:bg-[#f0f0f2]')}`}>Screenshots</button>
            <button onClick={()=>setTab('shortcuts')} className={`w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium ${tab==='shortcuts' ? (isDark ? 'bg-white/[0.08] text-white' : 'bg-[#efeff0] text-[#1d1d1f] font-semibold') : (isDark ? 'text-[#a1a1aa] hover:bg-white/[0.06]' : 'text-[#3a3a3e] hover:bg-[#f0f0f2]')}`}>Shortcuts</button>
            <button onClick={()=>setTab('about')} className={`w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium ${tab==='about' ? (isDark ? 'bg-white/[0.08] text-white' : 'bg-[#efeff0] text-[#1d1d1f] font-semibold') : (isDark ? 'text-[#a1a1aa] hover:bg-white/[0.06]' : 'text-[#3a3a3e] hover:bg-[#f0f0f2]')}`}>About</button>
          </nav>
          <div className={`p-3 border-t mt-2 ${isDark ? 'border-white/[0.08]' : 'border-[#ececef]'}`}>
            <div className={`text-[11px] font-medium ${textMuted}`}>v0.6.0</div>
            <a href="#" className={`text-[11px] underline ${textMain}`}>Check for updates</a>
          </div>
        </aside>

        <main className={`flex-1 overflow-auto p-[22px] ${isDark ? 'bg-[#1e1e1f]' : 'bg-white'}`}>
          
          {tab==='general' && (
            <>
              <h1 className={`text-[15px] font-bold tracking-tight ${textMain}`}>Appearance</h1>
              <p className={`text-[12.5px] mt-1 ${textMuted}`}>Match Cap to your system theme or pick a fixed look.</p>
              
              {/* EXACT LIKE YOUR SCREENSHOT */}
              <div className={`mt-3 p-3 border rounded-xl flex gap-3 ${isDark ? 'bg-[#1e1e1f] border-white/[0.08]' : 'bg-white border-[#ececef]'}`}>
                {/* SYSTEM - SELECTED */}
                <button onClick={()=>setTheme('system')} className={`flex-1 rounded-xl overflow-hidden border-2 bg-white text-left transition-all ${theme==='system' ? 'border-[#0a84ff]' : 'border-[#e8e8ec] hover:border-[#d1d1d6]'}`}>
                  <div className="p-2 pb-0">
                    <div className="h-[64px] rounded-lg border border-[#e8e8ec] overflow-hidden flex bg-white relative">
                      <div className="flex-1 bg-white p-2.5 flex flex-col justify-center gap-[7px]">
                        <div className="h-[6px] bg-[#e5e5e7] rounded-full w-full"/>
                        <div className="h-[6px] bg-[#e5e5e7] rounded-full w-[62%]"/>
                        <div className="h-[6px] bg-[#e5e5e7] rounded-full w-[88%]"/>
                      </div>
                      <div className="flex-1 bg-black p-2.5 flex flex-col justify-center gap-[7px]">
                        <div className="h-[6px] bg-[#0a0a0a] rounded-full w-full"/>
                        <div className="h-[6px] bg-[#0a0a0a] rounded-full w-full"/>
                        <div className="h-[6px] bg-[#0a0a0a] rounded-full w-full"/>
                      </div>
                      {/* split line */}
                      <div className="absolute inset-y-0 left-1/2 w-px bg-[#e8e8ec] opacity-0"/>
                    </div>
                  </div>
                  <div className={`py-2.5 text-center text-[13px] font-semibold ${theme==='system' ? 'text-[#0a84ff]' : 'text-[#1d1d1f]'}`}>System</div>
                </button>

                {/* LIGHT */}
                <button onClick={()=>setTheme('light')} className={`flex-1 rounded-xl overflow-hidden border-2 bg-white text-left transition-all ${theme==='light' ? 'border-[#0a84ff]' : 'border-[#e8e8ec] hover:border-[#d1d1d6]'}`}>
                  <div className="p-2 pb-0">
                    <div className="h-[64px] rounded-lg border border-[#e8e8ec] bg-white p-2.5 flex flex-col justify-center gap-[7px]">
                      <div className="h-[6px] bg-[#e5e5e7] rounded-full w-[72%]"/>
                      <div className="h-[6px] bg-[#e5e5e7] rounded-full w-[52%]"/>
                      <div className="h-[6px] bg-[#e5e5e7] rounded-full w-[88%]"/>
                    </div>
                  </div>
                  <div className={`py-2.5 text-center text-[13px] font-semibold ${theme==='light' ? 'text-[#0a84ff]' : 'text-[#1d1d1f]'}`}>Light</div>
                </button>

                {/* DARK */}
                <button onClick={()=>setTheme('dark')} className={`flex-1 rounded-xl overflow-hidden border-2 bg-white text-left transition-all ${theme==='dark' ? 'border-[#0a84ff]' : 'border-[#e8e8ec] hover:border-[#d1d1d6]'}`}>
                  <div className="p-2 pb-0">
                    <div className="h-[64px] rounded-lg border border-[#1a1a1a] bg-black p-2.5 flex flex-col justify-center gap-[7px]">
                      <div className="h-[6px] bg-[#2e2e2e] rounded-full w-[72%]"/>
                      <div className="h-[6px] bg-[#2e2e2e] rounded-full w-[52%]"/>
                      <div className="h-[6px] bg-[#2e2e2e] rounded-full w-[88%]"/>
                    </div>
                  </div>
                  <div className={`py-2.5 text-center text-[13px] font-semibold ${theme==='dark' ? 'text-[#0a84ff]' : 'text-[#1d1d1f]'}`}>Dark</div>
                </button>
              </div>

              <h2 className={`mt-6 text-sm font-bold ${textMain}`}>Capture</h2>
              <p className={`text-xs ${textMuted}`}>Behaviour after you capture.</p>
              <div className={`mt-3 border rounded-xl overflow-hidden divide-y ${cardBorder} ${rowBorder}`}>
                <div className="flex items-center justify-between p-4">
                  <div><div className={`text-[13px] font-semibold ${textMain}`}>After capture</div><div className={`text-xs ${textMuted}`}>What happens after capture.</div></div>
                  <select className={`h-7 px-2 rounded-lg border text-xs font-medium ${isDark ? 'bg-[#2a2a2e] border-white/10 text-white' : 'bg-[#f7f7f8] border-[#e5e5e7]'}`}><option>Show in Panel (250×200)</option><option>Open in Editor</option></select>
                </div>
                <div className="flex items-center justify-between p-4"><div><div className={`text-[13px] font-semibold ${textMain}`}>Auto copy</div><div className={`text-xs ${textMuted}`}>Copy automatically</div></div><div className="w-[38px] h-[22px] rounded-full bg-[#e9e9ec] relative"><span className="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow"/></div></div>
                <div className="flex items-center justify-between p-4"><div><div className={`text-[13px] font-semibold ${textMain}`}>Show preview panel</div><div className={`text-xs ${textMuted}`}>CleanShot style panel</div></div><div className="w-[38px] h-[22px] rounded-full bg-[#0a84ff] relative"><span className="absolute top-[2px] left-[2px] w-[18px] h-[18px] bg-white rounded-full shadow translate-x-[16px]"/></div></div>
              </div>
            </>
          )}

          {tab==='screenshots' && (<><h1 className={`text-[15px] font-bold ${textMain}`}>Screenshots</h1><div className={`mt-3 border rounded-xl overflow-hidden divide-y ${cardBorder} ${rowBorder}`}><div className="flex items-center justify-between p-4"><div className={`text-[13px] font-semibold ${textMain}`}>File format</div><select className={`h-7 px-2 border rounded-lg text-xs ${isDark ? 'bg-[#2a2a2e] border-white/10 text-white' : 'bg-[#f7f7f8]'}`}><option>PNG</option><option>JPG</option></select></div></div></>)}
          {tab==='shortcuts' && (<><h1 className={`text-[15px] font-bold ${textMain}`}>Shortcuts</h1><div className={`mt-3 border rounded-xl overflow-hidden divide-y ${cardBorder} ${rowBorder}`}><div className={`flex justify-between p-4 text-sm font-medium ${textMain}`}>Area <kbd className={`px-1.5 py-0.5 rounded text-xs border ${isDark ? 'bg-white/10 border-white/10' : 'bg-[#f0f0f2]'}`}>Alt + Shift + A</kbd></div><div className={`flex justify-between p-4 text-sm font-medium ${textMain}`}>Full page <kbd className={`px-1.5 py-0.5 rounded text-xs border ${isDark ? 'bg-white/10 border-white/10' : 'bg-[#f0f0f2]'}`}>Alt + Shift + F</kbd></div></div></>)}
          {tab==='about' && (<><h1 className={`text-[15px] font-bold ${textMain}`}>About</h1><div className={`mt-3 border rounded-xl overflow-hidden divide-y ${cardBorder} ${rowBorder}`}><div className={`flex justify-between p-4 text-sm ${textMain}`}>Version <span className={`px-2 py-0.5 rounded text-xs font-semibold ${isDark ? 'bg-white/10' : 'bg-[#f0f0f2]'}`}>0.6.0</span></div></div></>)}
        </main>
      </div>
    </div>
  )
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Setting />)