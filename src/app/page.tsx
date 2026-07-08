'use client';
import { useState, useEffect, useRef } from 'react';

const API = '';
// clipはVercel経由だとタイムアウトするためバックエンドに直接送る
// NEXT_PUBLIC_BACKEND_URL 未設定時はローカルデフォルトにフォールバック
const CLIP_API = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

// ── Types ──────────────────────────────────────────────────────────────────

type VideoMeta = {
  video_id: string;
  title: string;
  duration: number;
  uploader: string;
  transcript: string;
  has_transcript: boolean;
};

type ClipCandidate = {
  title: string;
  start_seconds: number;
  end_seconds: number;
  start_time: string;
  end_time: string;
  duration_label: string;
  reason: string;
  buzz_score: number;
  platforms: string[];
};

type Format = '9:16' | '16:9' | '1:1';
type Mode   = 'letterbox' | 'crop';

// ── Format options ─────────────────────────────────────────────────────────

const FORMATS: { id: Format; label: string; sub: string; icon: string }[] = [
  { id: '9:16',  label: '縦型',   sub: 'TikTok / Shorts / Reels', icon: '▐' },
  { id: '16:9',  label: '横型',   sub: 'YouTube 通常動画',          icon: '▬' },
  { id: '1:1',   label: '正方形', sub: 'Instagram 投稿',             icon: '■' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function parseTimeStr(t: string): number {
  const parts = t.split(':').map(Number);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  return (parts[0] ?? 0)*60 + (parts[1] ?? 0);
}

function BuzzBar({ score }: { score: number }) {
  const color = score >= 80 ? '#A855F7' : score >= 60 ? '#6366F1' : '#64748B';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
      <div style={{ flex:1, height:'3px', borderRadius:'2px', background:'rgba(255,255,255,0.08)', overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${score}%`, background:color, borderRadius:'2px', transition:'width 0.6s ease' }} />
      </div>
      <span style={{ fontSize:'12px', fontWeight:700, color, minWidth:'32px', textAlign:'right' }}>{score}</span>
    </div>
  );
}

// ── Mode Toggle (縦型専用) ─────────────────────────────────────────────────

function ModeToggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div style={{ marginTop:'16px', paddingTop:'16px', borderTop:'1px solid var(--bd1)' }}>
      <label className="lbl">縦型表示モード</label>
      <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>
        <button
          onClick={() => setMode('letterbox')}
          className={mode === 'letterbox' ? 'btn-outline-accent' : 'btn-ghost'}
          style={{ fontSize:'12px', padding:'7px 14px' }}
        >
          全体表示（上下黒帯）
        </button>
        <button
          onClick={() => setMode('crop')}
          className={mode === 'crop' ? 'btn-outline-accent' : 'btn-ghost'}
          style={{ fontSize:'12px', padding:'7px 14px' }}
        >
          拡大クロップ
        </button>
      </div>
      <p style={{ fontSize:'11px', color:'var(--t4)', marginTop:'7px', lineHeight:1.5 }}>
        {mode === 'letterbox'
          ? '動画全体を表示。上下に黒帯が入ります（デフォルト）'
          : '画面いっぱいに拡大。YouTube Shorts風。左右が切れる場合があります'}
      </p>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

type Step = 'input' | 'loading_meta' | 'instruct' | 'analyzing' | 'results' | 'manual';
type BackendStatus = 'checking' | 'ok' | 'no_key' | 'error';

export default function Home() {
  const [step,          setStep]          = useState<Step>('input');
  const [url,           setUrl]           = useState('');
  const [meta,          setMeta]          = useState<VideoMeta | null>(null);
  const [instruction,   setInstruction]   = useState('');
  const [format,        setFormat]        = useState<Format>('9:16');
  const [mode,          setMode]          = useState<Mode>('letterbox');
  const [clips,         setClips]         = useState<ClipCandidate[]>([]);
  const [selected,      setSelected]      = useState<ClipCandidate | null>(null);
  const [manualStart,   setManualStart]   = useState('');
  const [manualEnd,     setManualEnd]     = useState('');
  const [useManual,     setUseManual]     = useState(false);
  const [clipUrl,       setClipUrl]       = useState('');
  const [error,         setError]         = useState('');
  const [clipping,      setClipping]      = useState(false);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('checking');
  const [uploadFile,    setUploadFile]    = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function checkBackend(retries = 6) {
    setBackendStatus('checking');
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch('/api/health', { signal: AbortSignal.timeout(60000) });
        const data = await res.json();
        if (data.status === 'warming_up') {
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }
        if (!res.ok) { setBackendStatus('error'); return; }
        setBackendStatus(data.has_anthropic_key === false ? 'no_key' : 'ok');
        return;
      } catch {
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 8000));
          continue;
        }
        setBackendStatus('error');
      }
    }
    setBackendStatus('error');
  }

  useEffect(() => { checkBackend(); }, []);

  async function handleLoadMeta() {
    if (!url.trim()) return;
    setError('');
    setStep('loading_meta');
    try {
      const res = await fetch(`${API}/api/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
        signal: AbortSignal.timeout(280000),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(e.detail ?? '動画情報の取得に失敗しました');
      }
      const data = await res.json();
      setMeta(data);
      setStep('instruct');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('input');
    }
  }

  async function handleAnalyze() {
    if (!meta || !instruction.trim()) return;
    setError('');
    setStep('analyzing');
    try {
      const res = await fetch(`${API}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: meta.video_id,
          transcript: meta.transcript,
          instruction: instruction.trim(),
          format,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.detail ?? 'AI分析に失敗しました');
      }
      const data = await res.json();
      setClips(data.clips ?? []);
      setStep('results');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('instruct');
    }
  }

  async function handleClipUpload() {
    if (!meta || !uploadFile) return;
    const isManualMode = step === 'manual' || useManual;
    const startSec = isManualMode ? parseTimeStr(manualStart) : (selected?.start_seconds ?? 0);
    const endSec   = isManualMode ? parseTimeStr(manualEnd)   : (selected?.end_seconds ?? 0);
    if (endSec <= startSec) { setError('終了時間は開始時間より後にしてください'); return; }

    setError('');
    setClipping(true);
    setClipUrl('');
    try {
      const form = new FormData();
      form.append('video', uploadFile);
      form.append('start', String(startSec));
      form.append('end',   String(endSec));
      form.append('format', format);
      form.append('mode',   mode);
      const res = await fetch(`${CLIP_API}/api/clip-upload`, { method: 'POST', body: form });
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(e.detail ?? '動画生成に失敗しました');
      }
      const blob = await res.blob();
      setClipUrl(URL.createObjectURL(blob));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setClipping(false);
    }
  }

  async function handleClip() {
    if (!meta) return;

    if (backendStatus === 'error') {
      setError('バックエンドに接続できません。ターミナルで bash start.sh を実行してください。');
      return;
    }
    if (backendStatus === 'no_key') {
      setError('ANTHROPIC_API_KEY が設定されていません。backend/.env に本物のAPIキーを記入してください。');
      return;
    }

    const isManualMode = step === 'manual' || useManual;
    const startSec = isManualMode
      ? parseTimeStr(manualStart)
      : (selected?.start_seconds ?? 0);
    const endSec = isManualMode
      ? parseTimeStr(manualEnd)
      : (selected?.end_seconds ?? 0);

    if (endSec <= startSec) {
      setError('終了時間は開始時間より後にしてください');
      return;
    }

    setError('');
    setClipping(true);
    setClipUrl('');
    try {
      const res = await fetch(`${CLIP_API}/api/clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: meta.video_id,
          start: startSec,
          end: endSec,
          format,
          mode,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(e.detail ?? '動画生成に失敗しました');
      }
      const blob = await res.blob();
      const burl = URL.createObjectURL(blob);
      setClipUrl(burl);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setClipping(false);
    }
  }

  function reset() {
    setStep('input');
    setUrl('');
    setMeta(null);
    setInstruction('');
    setClips([]);
    setSelected(null);
    setManualStart('');
    setManualEnd('');
    setUseManual(false);
    setClipUrl('');
    setError('');
    setMode('letterbox');
    setUploadFile(null);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight:'100dvh', background:'var(--bg)', position:'relative', overflow:'hidden' }}>

      {/* Background glow */}
      <div style={{ position:'fixed', inset:0, pointerEvents:'none', zIndex:0 }}>
        <div style={{ position:'absolute', top:'-20%', left:'50%', transform:'translateX(-50%)', width:'800px', height:'600px', borderRadius:'50%', background:'radial-gradient(circle, rgba(124,58,237,0.10) 0%, transparent 65%)', filter:'blur(40px)' }} />
        <div style={{ position:'absolute', bottom:'10%', right:'-10%', width:'400px', height:'400px', borderRadius:'50%', background:'radial-gradient(circle, rgba(168,85,247,0.07) 0%, transparent 70%)', filter:'blur(30px)' }} />
      </div>

      <div style={{ position:'relative', zIndex:1, maxWidth:'760px', margin:'0 auto', padding:'0 24px 80px' }}>

        {/* Header */}
        <header style={{ paddingTop:'48px', paddingBottom:'48px', textAlign:'center' }}>
          <div style={{ display:'inline-flex', alignItems:'center', gap:'10px', marginBottom:'20px', padding:'6px 14px', borderRadius:'20px', background:'var(--ag2)', border:'1px solid rgba(124,58,237,0.28)' }}>
            <div style={{ width:'7px', height:'7px', borderRadius:'50%', background:'var(--accent2)', animation:'pulse-accent 2s ease infinite' }} />
            <span style={{ fontSize:'11px', fontWeight:600, letterSpacing:'0.14em', textTransform:'uppercase', color:'var(--accent3)' }}>AI Powered</span>
          </div>
          <h1 style={{ fontSize:'clamp(28px, 5vw, 42px)', fontWeight:800, letterSpacing:'-0.03em', color:'var(--t1)', lineHeight:1.1, marginBottom:'12px' }}>
            YouTube切り抜き
            <span style={{ display:'block', background:'linear-gradient(90deg, #7C3AED, #A855F7, #C084FC)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', backgroundClip:'text' }}>AIで自動生成</span>
          </h1>
          <p style={{ fontSize:'15px', color:'var(--t3)', maxWidth:'480px', margin:'0 auto', lineHeight:1.6 }}>
            URLを貼って指示するだけ。AIがバズる切り抜き候補を提案します。
          </p>
        </header>

        {/* Backend status banner */}
        {backendStatus === 'error' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '12px 16px', borderRadius: '10px', marginBottom: '20px',
            background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.22)',
          }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#EF4444', flexShrink: 0 }} />
            <p style={{ fontSize: '13px', color: 'rgba(252,165,165,0.9)', flex: 1, lineHeight: 1.5 }}>
              バックエンドが起動していません。ターミナルで <code style={{ background: 'rgba(255,255,255,0.08)', padding: '2px 6px', borderRadius: '4px' }}>bash start.sh</code> を実行してください。
            </p>
            <button
              onClick={() => checkBackend()}
              style={{ fontSize: '12px', padding: '5px 12px', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.35)', background: 'transparent', color: 'rgba(252,165,165,0.8)', cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit' }}
            >
              再確認
            </button>
          </div>
        )}
        {backendStatus === 'no_key' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '12px 16px', borderRadius: '10px', marginBottom: '20px',
            background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.22)',
          }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#F59E0B', flexShrink: 0 }} />
            <p style={{ fontSize: '13px', color: 'rgba(253,211,77,0.9)', flex: 1, lineHeight: 1.5 }}>
              ANTHROPIC_API_KEY が未設定です。<code style={{ background: 'rgba(255,255,255,0.08)', padding: '2px 6px', borderRadius: '4px' }}>backend/.env</code> に本物のAPIキーを設定してください。
            </p>
          </div>
        )}
        {backendStatus === 'ok' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '8px 14px', borderRadius: '8px', marginBottom: '16px',
            background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.18)',
          }}>
            <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#34D399' }} />
            <span style={{ fontSize: '12px', color: 'rgba(52,211,153,0.85)' }}>バックエンド稼働中</span>
          </div>
        )}
        {backendStatus === 'checking' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '8px 14px', borderRadius: '8px', marginBottom: '16px',
            background: 'rgba(100,116,139,0.06)', border: '1px solid rgba(100,116,139,0.15)',
          }}>
            <div className="spinner" style={{ width: '8px', height: '8px' }} />
            <span style={{ fontSize: '12px', color: 'rgba(148,163,184,0.7)' }}>バックエンド起動中（初回は30秒ほどかかります）</span>
            <span style={{ fontSize: '12px', color: 'var(--t4)' }}>バックエンド接続確認中...</span>
          </div>
        )}

        {/* Step indicator */}
        {step !== 'input' && (
          <div className="afi" style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'32px', justifyContent:'center' }}>
            {(['input','instruct','results'] as const).map((s, i) => {
              const idx = ['input','instruct','results'].indexOf(step.replace('loading_meta','input').replace('analyzing','instruct').replace('clipping','results'));
              const done  = i < idx;
              const active = i === idx;
              return (
                <div key={s} style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                  <div style={{
                    width:'24px', height:'24px', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:'11px', fontWeight:700,
                    background: done ? 'var(--accent)' : active ? 'rgba(124,58,237,0.25)' : 'var(--s1)',
                    border: `1px solid ${done ? 'var(--accent)' : active ? 'rgba(124,58,237,0.60)' : 'var(--bd1)'}`,
                    color: done || active ? '#fff' : 'var(--t4)',
                  }}>
                    {done ? '✓' : i + 1}
                  </div>
                  <span style={{ fontSize:'11px', color: active ? 'var(--t2)' : 'var(--t4)', fontWeight: active ? 600 : 400 }}>
                    {['URL入力','AIで分析','候補を選択'][i]}
                  </span>
                  {i < 2 && <div style={{ width:'24px', height:'1px', background:'var(--bd1)' }} />}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Error banner ── */}
        {error && (
          <div className="afi" style={{ padding:'14px 18px', borderRadius:'10px', background:'rgba(239,68,68,0.10)', border:'1px solid rgba(239,68,68,0.25)', color:'rgba(252,165,165,0.90)', fontSize:'13px', marginBottom:'20px', lineHeight:1.5 }}>
            {error}
          </div>
        )}

        {/* ─────────────────────────────
             STEP: URL INPUT
        ───────────────────────────── */}
        {(step === 'input' || step === 'loading_meta') && (
          <div className="au">
            <div className="card" style={{ padding:'32px' }}>
              <label className="lbl">YouTube URL</label>
              <div style={{ display:'flex', gap:'10px' }}>
                <input
                  className="inp"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleLoadMeta()}
                  disabled={step === 'loading_meta'}
                />
                <button
                  className="btn-primary"
                  onClick={handleLoadMeta}
                  disabled={!url.trim() || step === 'loading_meta'}
                  style={{ flexShrink:0, padding:'12px 20px' }}
                >
                  {step === 'loading_meta' ? <><div className="spinner" />解析中</> : '読み込む'}
                </button>
              </div>
              <p style={{ fontSize:'12px', color:'var(--t4)', marginTop:'12px' }}>
                字幕付き動画はより精度の高い候補を生成できます
              </p>
            </div>

            {/* Tips */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'12px', marginTop:'20px' }}>
              {[
                { label:'バズり度スコア', desc:'AIがSNS映えを数値化' },
                { label:'複数候補を提案', desc:'最大5つの切り抜き案' },
                { label:'手動時間指定も', desc:'秒単位で細かく指定可能' },
              ].map(t => (
                <div key={t.label} className="card" style={{ padding:'18px 16px', textAlign:'center' }}>
                  <p style={{ fontSize:'13px', fontWeight:600, color:'var(--t2)', marginBottom:'4px' }}>{t.label}</p>
                  <p style={{ fontSize:'12px', color:'var(--t4)', lineHeight:1.5 }}>{t.desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─────────────────────────────
             STEP: INSTRUCT / FORMAT
        ───────────────────────────── */}
        {(step === 'instruct' || step === 'analyzing') && meta && (
          <div className="au">
            {/* Video card */}
            <div className="card-accent" style={{ padding:'18px 20px', marginBottom:'20px', display:'flex', alignItems:'center', gap:'16px' }}>
              <div style={{ width:'44px', height:'44px', borderRadius:'10px', background:'var(--ag2)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <svg width="20" height="20" fill="none" viewBox="0 0 24 24"><path fill="var(--accent2)" d="M8 5l11 7-11 7V5z"/></svg>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <p style={{ fontSize:'14px', fontWeight:600, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{meta.title}</p>
                <p style={{ fontSize:'12px', color:'var(--t3)', marginTop:'2px' }}>
                  {meta.uploader} · {meta.duration > 0 ? fmtDuration(meta.duration) : '時間不明'}
                  {meta.has_transcript ? ' · 字幕あり' : ' · 字幕なし'}
                </p>
              </div>
              <button className="btn-ghost" onClick={reset} style={{ flexShrink:0, fontSize:'12px' }}>変更</button>
            </div>

            {/* Instruction */}
            <div className="card" style={{ padding:'28px', marginBottom:'16px' }}>
              <label className="lbl">切り抜き指示</label>
              <textarea
                className="inp"
                placeholder="例：バズりそうなシーンを3本切り抜いて / 面白いところを縦型で / 勉強になる部分を抜いて"
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                rows={3}
                style={{ resize:'vertical', lineHeight:1.65, minHeight:'80px' }}
              />
              <div style={{ display:'flex', gap:'6px', flexWrap:'wrap', marginTop:'10px' }}>
                {['バズりそうなところを3本', '面白いシーンを全部', '一番盛り上がる部分'].map(t => (
                  <button
                    key={t}
                    className="btn-ghost"
                    onClick={() => setInstruction(t)}
                    style={{ fontSize:'12px', padding:'6px 12px' }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Format */}
            <div className="card" style={{ padding:'24px 28px', marginBottom:'24px' }}>
              <label className="lbl">出力形式</label>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'10px' }}>
                {FORMATS.map(f => (
                  <button
                    key={f.id}
                    onClick={() => setFormat(f.id)}
                    style={{
                      background: format === f.id ? 'var(--ag2)' : 'var(--s1)',
                      border: `1px solid ${format === f.id ? 'rgba(124,58,237,0.55)' : 'var(--bd1)'}`,
                      borderRadius:'10px', padding:'14px 12px', cursor:'pointer',
                      textAlign:'center', transition:'all 0.16s', fontFamily:'inherit',
                    }}
                  >
                    <div style={{ fontSize:'20px', marginBottom:'6px', opacity: format === f.id ? 1 : 0.4, color: format === f.id ? 'var(--accent2)' : 'var(--t3)' }}>{f.icon}</div>
                    <p style={{ fontSize:'13px', fontWeight:700, color: format === f.id ? 'var(--t1)' : 'var(--t3)', marginBottom:'2px' }}>{f.label}</p>
                    <p style={{ fontSize:'11px', color:'var(--t4)' }}>{f.sub}</p>
                  </button>
                ))}
              </div>
              {(format === '9:16' || format === '1:1') && (
                <ModeToggle mode={mode} setMode={setMode} />
              )}
            </div>

            <button
              className="btn-primary"
              onClick={handleAnalyze}
              disabled={!instruction.trim() || step === 'analyzing'}
              style={{ width:'100%', padding:'14px', justifyContent:'center', fontSize:'15px' }}
            >
              {step === 'analyzing'
                ? <><div className="spinner" />AIが分析中...</>
                : 'AIで候補を生成'}
            </button>

            <div style={{ display:'flex', alignItems:'center', gap:'12px', margin:'16px 0' }}>
              <div style={{ flex:1, height:'1px', background:'var(--bd1)' }} />
              <span style={{ fontSize:'11px', color:'var(--t4)', fontWeight:500 }}>または</span>
              <div style={{ flex:1, height:'1px', background:'var(--bd1)' }} />
            </div>

            <button
              className="btn-ghost"
              onClick={() => setStep('manual')}
              style={{ width:'100%', padding:'13px', justifyContent:'center', fontSize:'14px', color:'var(--t2)' }}
            >
              手動で時間を指定して切り抜く
            </button>
          </div>
        )}

        {/* ─────────────────────────────
             STEP: MANUAL
        ───────────────────────────── */}
        {step === 'manual' && meta && (
          <div className="au">
            {/* Video info bar */}
            <div className="card-accent" style={{ padding:'16px 20px', marginBottom:'24px', display:'flex', alignItems:'center', gap:'12px' }}>
              <div style={{ width:'40px', height:'40px', borderRadius:'10px', background:'var(--ag2)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24"><path fill="var(--accent2)" d="M8 5l11 7-11 7V5z"/></svg>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <p style={{ fontSize:'14px', fontWeight:600, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{meta.title}</p>
                <p style={{ fontSize:'12px', color:'var(--t3)', marginTop:'2px' }}>{meta.uploader} · 全尺 {fmtDuration(meta.duration)}</p>
              </div>
              <button className="btn-ghost" onClick={reset} style={{ flexShrink:0, fontSize:'12px' }}>最初から</button>
            </div>

            <div className="card" style={{ padding:'28px', marginBottom:'16px' }}>
              <label className="lbl">切り抜き範囲</label>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'14px', marginBottom:'8px' }}>
                <div>
                  <label className="lbl">開始時間</label>
                  <input
                    className="inp"
                    placeholder="例: 1:23 または 83"
                    value={manualStart}
                    onChange={e => setManualStart(e.target.value)}
                  />
                </div>
                <div>
                  <label className="lbl">終了時間</label>
                  <input
                    className="inp"
                    placeholder="例: 2:45 または 165"
                    value={manualEnd}
                    onChange={e => setManualEnd(e.target.value)}
                  />
                </div>
              </div>
              <p style={{ fontSize:'12px', color:'var(--t4)', lineHeight:1.6 }}>
                「分:秒」または秒数で入力。動画の全尺は {fmtDuration(meta.duration)} です。
              </p>

              {/* Preview duration */}
              {manualStart && manualEnd && (() => {
                const s = parseTimeStr(manualStart);
                const e = parseTimeStr(manualEnd);
                const dur = e - s;
                if (dur <= 0) return (
                  <p style={{ fontSize:'12px', color:'var(--red)', marginTop:'10px' }}>終了時間は開始時間より後にしてください</p>
                );
                return (
                  <div style={{ marginTop:'12px', padding:'10px 14px', borderRadius:'8px', background:'var(--ag2)', border:'1px solid rgba(124,58,237,0.22)', display:'inline-flex', gap:'8px', alignItems:'center' }}>
                    <span style={{ fontSize:'12px', color:'var(--accent3)', fontWeight:600 }}>切り抜き尺: {fmtDuration(dur)}</span>
                  </div>
                );
              })()}
            </div>

            {/* Format */}
            <div className="card" style={{ padding:'22px 24px', marginBottom:'24px' }}>
              <label className="lbl">出力形式</label>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'10px' }}>
                {FORMATS.map(f => (
                  <button
                    key={f.id}
                    onClick={() => setFormat(f.id)}
                    style={{
                      background: format === f.id ? 'var(--ag2)' : 'var(--s1)',
                      border: `1px solid ${format === f.id ? 'rgba(124,58,237,0.55)' : 'var(--bd1)'}`,
                      borderRadius:'10px', padding:'14px 10px', cursor:'pointer',
                      textAlign:'center', transition:'all 0.16s', fontFamily:'inherit',
                    }}
                  >
                    <div style={{ fontSize:'18px', marginBottom:'5px', color: format === f.id ? 'var(--accent2)' : 'var(--t4)' }}>{f.icon}</div>
                    <p style={{ fontSize:'13px', fontWeight:700, color: format === f.id ? 'var(--t1)' : 'var(--t3)', marginBottom:'2px' }}>{f.label}</p>
                    <p style={{ fontSize:'10px', color:'var(--t4)' }}>{f.sub}</p>
                  </button>
                ))}
              </div>
              {(format === '9:16' || format === '1:1') && (
                <ModeToggle mode={mode} setMode={setMode} />
              )}
            </div>

            <button
              className="btn-primary"
              onClick={handleClip}
              disabled={clipping || !manualStart || !manualEnd || parseTimeStr(manualEnd) <= parseTimeStr(manualStart)}
              style={{ width:'100%', padding:'15px', justifyContent:'center', fontSize:'15px' }}
            >
              {clipping ? <><div className="spinner" />動画を生成中...</> : '切り抜きを生成（YouTube URL）'}
            </button>

            {/* Upload alternative */}
            <div className="card" style={{ padding:'20px 24px', marginTop:'12px', background:'rgba(245,158,11,0.05)', border:'1px solid rgba(245,158,11,0.20)' }}>
              <p style={{ fontSize:'13px', color:'rgba(253,211,77,0.85)', marginBottom:'12px', lineHeight:1.5 }}>
                ⚠️ サーバーIPがYouTubeにブロックされる場合は、動画を手動でダウンロードしてアップロードしてください
              </p>
              <input ref={fileInputRef} type="file" accept="video/*" style={{ display:'none' }}
                onChange={e => setUploadFile(e.target.files?.[0] ?? null)} />
              <div style={{ display:'flex', gap:'10px', alignItems:'center', flexWrap:'wrap' }}>
                <button className="btn-ghost" onClick={() => fileInputRef.current?.click()}
                  style={{ fontSize:'13px', padding:'8px 16px' }}>
                  {uploadFile ? `📁 ${uploadFile.name}` : '動画ファイルを選択'}
                </button>
                {uploadFile && (
                  <button className="btn-primary"
                    onClick={handleClipUpload}
                    disabled={clipping || !manualStart || !manualEnd || parseTimeStr(manualEnd) <= parseTimeStr(manualStart)}
                    style={{ fontSize:'13px', padding:'8px 16px' }}>
                    {clipping ? <><div className="spinner" />生成中...</> : 'アップロードして切り抜き'}
                  </button>
                )}
              </div>
            </div>

            {clipUrl && (
              <div className="afi card-accent" style={{ padding:'24px', marginTop:'20px', textAlign:'center' }}>
                <p style={{ fontSize:'14px', fontWeight:700, color:'var(--t1)', marginBottom:'6px' }}>生成完了</p>
                <p style={{ fontSize:'13px', color:'var(--t3)', marginBottom:'18px' }}>MP4ファイルをダウンロードしてください</p>
                <a
                  href={clipUrl}
                  download="clip.mp4"
                  className="btn-primary"
                  style={{ display:'inline-flex', textDecoration:'none' }}
                >
                  MP4をダウンロード
                </a>
                <button
                  className="btn-ghost"
                  onClick={() => { setClipUrl(''); setManualStart(''); setManualEnd(''); }}
                  style={{ display:'block', margin:'12px auto 0', fontSize:'12px' }}
                >
                  別の範囲を切り抜く
                </button>
              </div>
            )}
          </div>
        )}

        {/* ─────────────────────────────
             STEP: RESULTS
        ───────────────────────────── */}
        {step === 'results' && meta && (
          <div className="au">
            {/* Video info bar */}
            <div className="card-accent" style={{ padding:'14px 18px', marginBottom:'24px', display:'flex', alignItems:'center', gap:'12px' }}>
              <p style={{ fontSize:'13px', color:'var(--t2)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{meta.title}</p>
              <button className="btn-ghost" onClick={() => setStep('instruct')} style={{ fontSize:'12px', flexShrink:0 }}>指示を変更</button>
              <button className="btn-ghost" onClick={reset} style={{ fontSize:'12px', flexShrink:0 }}>最初から</button>
            </div>

            {/* Clip candidates */}
            <p className="lbl" style={{ marginBottom:'14px' }}>切り抜き候補 — {clips.length}件</p>
            <div style={{ display:'flex', flexDirection:'column', gap:'10px', marginBottom:'28px' }}>
              {clips.map((c, i) => {
                const isSelected = !useManual && selected?.start_seconds === c.start_seconds;
                return (
                  <div
                    key={i}
                    className="card"
                    onClick={() => { setSelected(c); setUseManual(false); }}
                    style={{
                      padding:'20px', cursor:'pointer',
                      border: `1px solid ${isSelected ? 'rgba(124,58,237,0.55)' : 'var(--bd1)'}`,
                      background: isSelected ? 'rgba(124,58,237,0.08)' : 'var(--s1)',
                      transition:'all 0.16s',
                    }}
                  >
                    <div style={{ display:'flex', alignItems:'flex-start', gap:'14px' }}>
                      {/* Rank */}
                      <div style={{
                        width:'32px', height:'32px', borderRadius:'8px', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center',
                        background: isSelected ? 'var(--ag2)' : 'var(--s2)',
                        border: `1px solid ${isSelected ? 'rgba(124,58,237,0.40)' : 'var(--bd1)'}`,
                        fontSize:'13px', fontWeight:700, color: isSelected ? 'var(--accent2)' : 'var(--t3)',
                      }}>
                        {i + 1}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <p style={{ fontSize:'14px', fontWeight:700, color:'var(--t1)', marginBottom:'6px' }}>{c.title}</p>
                        <div style={{ display:'flex', gap:'12px', marginBottom:'10px', flexWrap:'wrap' }}>
                          <span style={{ fontSize:'12px', color:'var(--t3)' }}>{c.start_time} – {c.end_time}</span>
                          <span style={{ fontSize:'12px', color:'var(--t4)' }}>尺 {c.duration_label}</span>
                          <div style={{ display:'flex', gap:'4px', flexWrap:'wrap' }}>
                            {c.platforms?.map(p => (
                              <span key={p} style={{ fontSize:'10px', fontWeight:600, letterSpacing:'0.06em', padding:'2px 8px', borderRadius:'20px', background:'rgba(124,58,237,0.14)', color:'var(--accent3)', border:'1px solid rgba(124,58,237,0.22)' }}>{p}</span>
                            ))}
                          </div>
                        </div>
                        <p style={{ fontSize:'12px', color:'var(--t3)', lineHeight:1.55, marginBottom:'10px' }}>{c.reason}</p>
                        <div>
                          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'4px' }}>
                            <span style={{ fontSize:'10px', fontWeight:600, letterSpacing:'0.12em', textTransform:'uppercase', color:'var(--t4)' }}>バズり度</span>
                          </div>
                          <BuzzBar score={c.buzz_score} />
                        </div>
                      </div>
                      {isSelected && (
                        <div style={{ width:'20px', height:'20px', borderRadius:'50%', background:'var(--accent)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                          <svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Manual time input */}
            <div className="card" style={{ padding:'22px 24px', marginBottom:'20px' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'14px' }}>
                <label className="lbl" style={{ margin:0 }}>手動で時間を指定</label>
                <button
                  className={useManual ? 'btn-outline-accent' : 'btn-ghost'}
                  onClick={() => setUseManual(!useManual)}
                  style={{ fontSize:'12px', padding:'6px 12px' }}
                >
                  {useManual ? '手動指定 ON' : '手動で指定する'}
                </button>
              </div>
              {useManual && (
                <div className="afi" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'12px' }}>
                  <div>
                    <label className="lbl">開始時間</label>
                    <input className="inp" placeholder="例: 1:23 または 83" value={manualStart} onChange={e => setManualStart(e.target.value)} />
                  </div>
                  <div>
                    <label className="lbl">終了時間</label>
                    <input className="inp" placeholder="例: 2:15 または 135" value={manualEnd} onChange={e => setManualEnd(e.target.value)} />
                  </div>
                </div>
              )}
            </div>

            {/* Format toggle */}
            <div className="card" style={{ padding:'18px 24px', marginBottom:'24px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'12px', flexWrap:'wrap' }}>
                <span className="lbl" style={{ margin:0, minWidth:'max-content' }}>出力形式</span>
                <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>
                  {FORMATS.map(f => (
                    <button
                      key={f.id}
                      onClick={() => setFormat(f.id)}
                      className={format === f.id ? 'btn-outline-accent' : 'btn-ghost'}
                      style={{ fontSize:'12px', padding:'7px 14px' }}
                    >
                      {f.label} ({f.id})
                    </button>
                  ))}
                </div>
              </div>
              {(format === '9:16' || format === '1:1') && (
                <ModeToggle mode={mode} setMode={setMode} />
              )}
            </div>

            {/* Generate button */}
            <button
              className="btn-primary"
              onClick={handleClip}
              disabled={clipping || (!selected && !useManual) || (useManual && (!manualStart || !manualEnd))}
              style={{ width:'100%', padding:'15px', justifyContent:'center', fontSize:'15px' }}
            >
              {clipping ? <><div className="spinner" />動画を生成中...</> : '切り抜きを生成（YouTube URL）'}
            </button>

            {/* Upload alternative */}
            <div className="card" style={{ padding:'20px 24px', marginTop:'12px', background:'rgba(245,158,11,0.05)', border:'1px solid rgba(245,158,11,0.20)' }}>
              <p style={{ fontSize:'13px', color:'rgba(253,211,77,0.85)', marginBottom:'12px', lineHeight:1.5 }}>
                ⚠️ サーバーIPがYouTubeにブロックされる場合は、動画を手動でダウンロードしてアップロードしてください
              </p>
              <input ref={fileInputRef} type="file" accept="video/*" style={{ display:'none' }}
                onChange={e => setUploadFile(e.target.files?.[0] ?? null)} />
              <div style={{ display:'flex', gap:'10px', alignItems:'center', flexWrap:'wrap' }}>
                <button className="btn-ghost" onClick={() => fileInputRef.current?.click()}
                  style={{ fontSize:'13px', padding:'8px 16px' }}>
                  {uploadFile ? `📁 ${uploadFile.name}` : '動画ファイルを選択'}
                </button>
                {uploadFile && (
                  <button className="btn-primary"
                    onClick={handleClipUpload}
                    disabled={clipping || (!selected && !useManual) || (useManual && (!manualStart || !manualEnd))}
                    style={{ fontSize:'13px', padding:'8px 16px' }}>
                    {clipping ? <><div className="spinner" />生成中...</> : 'アップロードして切り抜き'}
                  </button>
                )}
              </div>
            </div>

            {/* Download */}
            {clipUrl && (
              <div className="afi card-accent" style={{ padding:'24px', marginTop:'20px', textAlign:'center' }}>
                <p style={{ fontSize:'14px', fontWeight:700, color:'var(--t1)', marginBottom:'6px' }}>生成完了</p>
                <p style={{ fontSize:'13px', color:'var(--t3)', marginBottom:'18px' }}>動画のダウンロードボタンを押してください</p>
                <a
                  href={clipUrl}
                  download="clip.mp4"
                  className="btn-primary"
                  style={{ display:'inline-flex', textDecoration:'none' }}
                >
                  MP4をダウンロード
                </a>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <p style={{ textAlign:'center', fontSize:'11px', color:'var(--t4)', marginTop:'60px', lineHeight:1.7 }}>
          個人・開発目的専用 — 著作権を持つ動画または許諾を得た動画のみ使用してください
        </p>
      </div>
    </div>
  );
}
