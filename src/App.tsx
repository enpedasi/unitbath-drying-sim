import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, Box, Check, ChevronDown, CircleHelp, DoorOpen, Expand, Fan, Gauge, Info, Layers, Maximize2, Minus, Mouse, Move, Pause, Play, Plus, RotateCcw, Shirt, SlidersHorizontal, Square, Wind, X } from 'lucide-react';
import { SceneEngine } from './scene/SceneEngine';
import type { ColorMode, DisplayMode, View } from './scene/SceneEngine';
import { VECTOR_MOTION_SCALE } from './scene/vectorMotion';
import { DEFAULT_SETTINGS, roomWidth } from './simulation/model';
import type { FlowField, Settings } from './simulation/model';
import { FlowSession } from './simulation/session';
import { createFlowFailure, flowFailureMessage } from './simulation/errors';
import type { FlowFailure } from './simulation/errors';

function FloorPlan({ large = false }: { large?: boolean }) {
  return <span className={`floor-plan ${large ? 'large' : ''}`} aria-hidden="true"><span /><i /><b /></span>;
}

export default function App() {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [playing, setPlaying] = useState(true), [speed, setSpeed] = useState(1);
  const [mode, setMode] = useState<DisplayMode>('vectors'), [view, setView] = useState<View>('quarter');
  const [colorMode, setColorMode] = useState<ColorMode>('speed');
  const [simulationReset, setSimulationReset] = useState(0);
  const session = useRef<FlowSession | null>(null);
  const playback = useRef({ playing, speed }); playback.current = { playing, speed };
  const latestSettings = useRef(settings); latestSettings.current = settings;
  const [walls, setWalls] = useState(true), [showFlow, setShowFlow] = useState(true);
  const [field, setField] = useState<FlowField | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [help, setHelp] = useState(false), [elapsed, setElapsed] = useState(0);
  const [lastFailure, setLastFailure] = useState<FlowFailure | null>(null);
  const resumeAfterError = useRef(true);
  const [toast, setToast] = useState(''), [retry, setRetry] = useState(0);
  const canvasHost = useRef<HTMLDivElement>(null), scene = useRef<SceneEngine | null>(null), viewer = useRef<HTMLElement>(null);
  const labels = useRef(new Map<string, HTMLElement>()), helpDialog = useRef<HTMLDialogElement>(null);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(s => ({ ...s, [key]: value }));
  const stopForError = (message: string) => {
    resumeAfterError.current = playback.current.playing;
    setPlaying(false); setLoading(false); setError(message);
  };
  const reportFlowFailure = (failure: FlowFailure) => {
    setLastFailure(failure);
    console.error('[UB Airflow] 計算を停止しました', failure);
    stopForError(flowFailureMessage(failure));
  };

  useEffect(() => {
    if (!canvasHost.current) return;
    try {
      const engine = new SceneEngine(canvasHost.current, settings, labels.current);
      engine.onTick = setElapsed; engine.onAdvance = dt => session.current?.tick(dt); scene.current = engine;
      const onContextLost = (event: Event) => { event.preventDefault(); stopForError('3D表示が中断されました。「再試行」で再開してください。'); };
      engine.renderer.domElement.addEventListener('webglcontextlost', onContextLost);
      return () => { engine.renderer.domElement.removeEventListener('webglcontextlost', onContextLost); engine.dispose(); scene.current = null; };
    } catch { stopForError('3D表示を開始できませんでした。ブラウザーのハードウェアアクセラレーションを確認してください。'); }
    // The engine survives configuration changes; only a retry recreates WebGL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry]);

  useEffect(() => { scene.current?.setSettings(settings); session.current?.setFan(settings); }, [settings, retry]);

  useEffect(() => {
    if (!scene.current) return;
    scene.current.clearFlow(); setField(null); setLoading(true); setError(''); setElapsed(0);
    let lastMetrics = -Infinity;
    const timer = window.setTimeout(() => {
      try {
        const worker = new Worker(new URL('./simulation/flow.worker.ts', import.meta.url), { type: 'module' });
        const current = new FlowSession(worker, latestSettings.current, result => {
          scene.current?.setField(result);
          if (performance.now() - lastMetrics > 400 || result.time === 0) { setField(result); lastMetrics = performance.now(); }
          setLoading(false);
        }, reportFlowFailure);
        session.current = current;
        current.setPlayback(playback.current.playing, playback.current.speed);
      } catch (cause) {
        reportFlowFailure(createFlowFailure('worker-error', String(cause), latestSettings.current, 0));
      }
    }, 120);
    return () => { window.clearTimeout(timer); session.current?.dispose(); session.current = null; };
  }, [settings.size, settings.clothes, settings.door, retry, simulationReset]);

  useEffect(() => {
    scene.current?.setOptions({ playing, speed, mode, walls, flow: showFlow, colorMode });
    session.current?.setPlayback(playing, speed);
  }, [playing, speed, mode, walls, showFlow, colorMode, retry]);
  useEffect(() => { if (help) helpDialog.current?.showModal(); else helpDialog.current?.close(); }, [help]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 3200); return () => clearTimeout(id); }, [toast]);

  const setCamera = (next: View) => { scene.current?.setView(next); setView(next); };
  const reset = () => { setSettings({ ...DEFAULT_SETTINGS }); setPlaying(true); setSpeed(1); setMode('vectors'); setWalls(true); setShowFlow(true); setColorMode('speed'); setSimulationReset(n => n + 1); setCamera('quarter'); };
  const retrySimulation = () => { setError(''); setPlaying(resumeAfterError.current); setRetry(n => n + 1); };
  const downloadFailure = () => {
    if (!lastFailure) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(lastFailure, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url;
    a.download = `UB気流_診断_${lastFailure.occurredAt.replace(/[:.]/g, '-')}.json`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const screenshot = () => {
    if (!scene.current) return;
    const a = document.createElement('a'); a.download = `UB気流_${settings.size}畳_${settings.clothes}枚_戸${settings.door}%.png`; a.href = scene.current.screenshot(); a.click(); setToast('3DビューをPNG画像で保存しました');
  };
  const fullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await viewer.current?.requestFullscreen(); }
    catch { setToast('このブラウザーでは全画面表示を利用できません'); }
  };
  const metrics = field?.metrics;
  const status = error ? 'エラーで停止' : loading ? '流れを計算中' : playing ? 'シミュレーション中' : '一時停止中';
  const labelRef = (name: string) => (el: HTMLDivElement | null) => { if (el) labels.current.set(name, el); else labels.current.delete(name); };

  return <div className="app">
    <header className="app-header">
      <a className="brand" href="./" aria-label="UB Airflow Studio ホーム"><span className="brand-mark"><Wind size={24} strokeWidth={2.2} /></span><span>UB <strong>Airflow</strong><span className="brand-studio">STUDIO</span></span></a>
      <nav aria-label="メインナビゲーション"><span className="nav-active"><Box size={16} />シミュレーター</span><button onClick={() => setHelp(true)}><CircleHelp size={16} />使い方</button></nav>
      <span className="header-note"><span className="status-dot" />ブラウザーで動く、3D気流シミュレーション</span>
    </header>

    <main>
      <div className="page-heading"><div><div className="eyebrow">BATHROOM AIRFLOW SIMULATOR</div><h1>空気の流れを、見えるかたちに。</h1><p>干し方や換気の条件を変えて、ユニットバスの風の通り道を見つけよう。</p></div><button className="model-badge" onClick={() => setHelp(true)}><Box size={15} />時間変化する3D気流モデル<Info size={14} /></button></div>

      <div className="workspace">
        <aside className="controls-panel" aria-label="シミュレーション条件">
          <div className="panel-heading"><span><SlidersHorizontal size={17} />シミュレーション条件</span><span className="small-tag">SETTINGS</span></div>
          <section className="control-section room-control">
            <div className="section-label"><span><Square size={16} />ユニットバスのサイズ</span><span className="step-number">01</span></div>
            <div className="size-options">
              {([3, 4.5] as const).map(size => <button key={size} className={`size-option ${settings.size === size ? 'selected' : ''}`} aria-pressed={settings.size === size} onClick={() => update('size', size)}><span className="size-check">{settings.size === size && <Check size={10} strokeWidth={3} />}</span><FloorPlan large={size === 4.5} /><span className="size-title">{size === 4.5 ? '4.5' : '3'}<small>畳</small></span><span className="size-dimensions">{roomWidth(size).toFixed(1)} × 2.7 m</span></button>)}
            </div>
            <p className="control-note">天井高 2.25 m・物干しポール 1本</p>
          </section>
          <section className="control-section">
            <div className="section-label"><span><Shirt size={17} />洗濯物の数</span><span className="step-number">02</span></div>
            <div className="laundry-setting"><span className="subtle">ポールに干す衣類</span><div className="stepper"><button aria-label="洗濯物を減らす" disabled={settings.clothes === 0} onClick={() => update('clothes', settings.clothes - 1)}><Minus size={15} /></button><output aria-live="polite">{settings.clothes}<small>枚</small></output><button aria-label="洗濯物を増やす" disabled={settings.clothes === 12} onClick={() => update('clothes', settings.clothes + 1)}><Plus size={15} /></button></div></div>
            <input className="range" type="range" min="0" max="12" value={settings.clothes} aria-label="洗濯物の数" aria-valuetext={`${settings.clothes}枚`} onChange={e => update('clothes', +e.target.value)} style={{ '--fill': `${settings.clothes / 12 * 100}%` } as React.CSSProperties} />
            <div className="range-scale"><span>0枚</span><span>12枚</span></div>
          </section>
          <section className="control-section">
            <div className="section-label"><span><DoorOpen size={17} />戸の開き具合</span><span className="step-number">03</span></div>
            <div className="door-setting"><span className="subtle">スライド式ドア</span><output className="big-value">{settings.door}<small>%</small></output></div>
            <input className="range" type="range" min="0" max="100" step="5" value={settings.door} aria-label="戸の開閉度" aria-valuetext={`${settings.door}%`} onChange={e => update('door', +e.target.value)} style={{ '--fill': `${settings.door}%` } as React.CSSProperties} />
            <div className="range-scale"><span>閉じる</span><span>全開</span></div>
            <div className="door-presets">{[0, 25, 50, 100].map(value => <button key={value} aria-pressed={settings.door === value} onClick={() => update('door', value)}>{value}%</button>)}</div>
          </section>
          <section className="control-section fan-control">
            <div className="section-label"><span><Fan size={17} />サーキュレーター</span><span className="step-number">04</span></div>
            <div className={`fan-option ${settings.fan ? 'on' : ''}`}><span className="fan-icon"><Fan size={25} /></span><div><strong>UBの外から送風</strong><span>送風の勢い・向きを調整できます</span></div><button className="switch" role="switch" aria-label="サーキュレーターの送風" aria-checked={settings.fan} onClick={() => update('fan', !settings.fan)}><span /></button></div>
            <div className={`fan-adjustments ${!settings.fan ? 'inactive' : ''}`}>
              <label><span>送風の強さ<output>{settings.fanSpeed.toFixed(1)} m/s</output></span><input className="range" type="range" min="0.5" max="3" step="0.1" value={settings.fanSpeed} aria-label="送風の強さ" disabled={!settings.fan} onChange={e => update('fanSpeed', +e.target.value)} style={{ '--fill': `${(settings.fanSpeed - 0.5) / 2.5 * 100}%` } as React.CSSProperties} /></label>
              <label><span>左右の向き<output>{settings.fanYaw === 0 ? '正面' : `${settings.fanYaw < 0 ? '左' : '右'} ${Math.abs(settings.fanYaw)}°`}</output></span><input className="range" type="range" min="-40" max="40" step="5" value={settings.fanYaw} aria-label="送風の左右角度" disabled={!settings.fan} onChange={e => update('fanYaw', +e.target.value)} style={{ '--fill': `${(settings.fanYaw + 40) / 80 * 100}%` } as React.CSSProperties} /><div className="range-scale"><span>UBに向かって左</span><span>右</span></div></label>
              <label><span>上向きの角度<output>{settings.fanTilt}°</output></span><input className="range" type="range" min="0" max="45" step="5" value={settings.fanTilt} aria-label="送風の上向き角度" disabled={!settings.fan} onChange={e => update('fanTilt', +e.target.value)} style={{ '--fill': `${settings.fanTilt / 45 * 100}%` } as React.CSSProperties} /></label>
              <p className="control-note">送風設定は、それまでの流れを引き継ぎます。</p>
            </div>
            <div className="ventilation-note"><span className="vent-icon"><Wind size={18} /></span><div><strong>換気扇は常にON<span>稼働中</span></strong><p>天井の換気口から空気を排出します</p></div></div>
          </section>
          <button className="reset-settings" onClick={reset}><RotateCcw size={14} />条件を初期値に戻す</button>
        </aside>

        <div className="simulation-column">
          <section className="viewer" ref={viewer} aria-label="3Dビュー">
            <div className="viewer-topbar"><div className="viewer-title"><Box size={17} /><strong>3Dビュー</strong><span className="divider" /><span className="viewer-size">{settings.size}畳 / {roomWidth(settings.size).toFixed(1)} × 2.7 m</span></div><div className="viewer-display-controls"><label className="field-color">色<select aria-label="気流の着色" value={colorMode} onChange={e => setColorMode(e.target.value as ColorMode)}><option value="speed">風速</option><option value="vorticity">回転の強さ</option></select></label><div className="display-tabs" aria-label="空気の表示方法"><button className={mode === 'vectors' ? 'active' : ''} aria-pressed={mode === 'vectors'} onClick={() => { setMode('vectors'); setShowFlow(true); }}><ArrowRight size={14} />全体矢印</button><button className={mode === 'streamlines' ? 'active' : ''} aria-pressed={mode === 'streamlines'} onClick={() => { setMode('streamlines'); setShowFlow(true); }}><Wind size={14} />流線</button><button className={mode === 'trails' ? 'active' : ''} aria-pressed={mode === 'trails'} onClick={() => { setMode('trails'); setShowFlow(true); }}><Wind size={14} />軌跡</button><button className={mode === 'particles' ? 'active' : ''} aria-pressed={mode === 'particles'} onClick={() => { setMode('particles'); setShowFlow(true); }}><Activity size={14} />粒子</button></div></div></div>
            <div className="scene-viewport" ref={canvasHost}>
              <div className="scene-status"><span className={`live-indicator ${loading ? 'loading' : ''} ${!playing ? 'paused' : ''}`} />{status}<span className="live-label">{loading ? 'SOLVING' : playing ? 'LIVE' : 'PAUSED'}</span></div>
              <div className="scene-actions"><button className={walls ? 'active' : ''} title="透過壁の表示を切り替え" aria-label="透過壁の表示" aria-pressed={walls} onClick={() => setWalls(!walls)}><Layers size={17} /></button><button title="3Dビューを画像で保存" aria-label="3Dビューを画像で保存" onClick={screenshot}><ArrowDownToLine size={17} /></button><button title="全画面表示" aria-label="全画面表示" onClick={fullscreen}><Expand size={17} /></button></div>
              <div className="scene-label vent-label" ref={labelRef('exhaust')}><span className="label-dot green" />換気口<span className="label-chip">ON</span><span>{field ? `↑ ${Math.round(field.diagnostics.exhaustOutflow * 3600)} m³/h` : '計算中'}</span></div>
              <div className="scene-label laundry-label" ref={labelRef('laundry')}><Shirt size={12} />洗濯物<span>{settings.clothes}枚</span></div>
              <div className="scene-label fan-label" ref={labelRef('fan')}><Fan size={12} />サーキュレーター<span className={`label-chip ${!settings.fan ? 'off' : 'blue'}`}>{settings.fan ? 'ON' : 'OFF'}</span></div>
              <div className="dimension-label" ref={labelRef('size')}>2.7 m</div>
              {error && <div className="scene-error" role="alert"><Info size={24} /><p>{error}</p><button onClick={retrySimulation}>再試行</button></div>}
              <div className="flow-legend"><div><span>{colorMode === 'speed' ? '風速' : '回転の強さ'}</span><span>{colorMode === 'speed' ? 'm/s' : 's⁻¹'}</span></div><div className={`gradient-bar ${colorMode}`} /><div className="legend-ticks"><span>0</span><span>{colorMode === 'speed' ? '0.4' : '1.5'}</span><span>{colorMode === 'speed' ? '0.8+' : '3.0+'}</span></div></div>
              <div className="view-tools"><div className="view-presets"><button aria-label="クォータービュー" title="クォータービュー" className={view === 'quarter' ? 'active' : ''} onClick={() => setCamera('quarter')}><Box size={16} /><span>クォーター</span></button><button aria-label="真上から俯瞰" title="真上から俯瞰" className={view === 'top' ? 'active' : ''} onClick={() => setCamera('top')}><Square size={15} /><span>俯瞰</span></button><button aria-label="正面から見る" title="正面から見る" className={view === 'front' ? 'active' : ''} onClick={() => setCamera('front')}><DoorOpen size={16} /><span>正面</span></button></div><span className="divider" /><button aria-label="縮小" title="縮小" onClick={() => scene.current?.zoom(1 / 1.2)}><Minus size={17} /></button><button aria-label="拡大" title="拡大" onClick={() => scene.current?.zoom(1.2)}><Plus size={17} /></button><button aria-label="視点をリセット" title="視点をリセット" onClick={() => setCamera('quarter')}><Maximize2 size={16} /></button></div>
              <span className="cutaway-note">天井・手前の壁を透過表示</span>
            </div>
            <div className="playback-bar"><div className="playback-controls"><button className="play-button" onClick={() => setPlaying(!playing)} aria-label={playing ? '一時停止' : '再生'}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button><button className="restart-button" title="計算を最初からやり直す" aria-label="計算を最初からやり直す" onClick={() => setSimulationReset(n => n + 1)}><RotateCcw size={15} /></button><span className="simulation-time">{String(Math.floor(elapsed / 60)).padStart(2, '0')}:{((Math.floor(elapsed * 10) % 600) / 10).toFixed(1).padStart(4, '0')}</span><span className="divider" /><label className="speed-select"><select aria-label="再生速度" value={speed} onChange={e => setSpeed(+e.target.value)}><option value="0.5">0.5×</option><option value="1">1.0×</option><option value="2">2.0×</option></select><ChevronDown size={12} /></label><span className="time-note">計算上の経過時間</span></div><label className="flow-checkbox"><input type="checkbox" checked={showFlow} onChange={e => setShowFlow(e.target.checked)} />気流を表示</label></div>
            <p className="flow-explanation">{mode === 'vectors' ? `全体矢印：風速に比例して風下へ動きます（移動表示 ${VECTOR_MOTION_SCALE}倍）。灰色の点は等間隔の観測位置、色は${colorMode === 'speed' ? '風速' : '回転の強さ'}です。各点の近くで繰り返し、無風の点は動きません。` : mode === 'streamlines' ? '流線：室内全域の等間隔の位置から、現在の風向をたどった線です。線上の矢印が下流方向を示します。' : mode === 'trails' ? '軌跡（補助表示）：粒子が直近約3秒で通った道です。部屋全体の流れや停滞は「全体矢印」で確認できます。' : '粒子（補助表示）：空間全体に配置し、計算上の時間と風速に合わせて動きます。粒子の密度は流量を表しません。'}</p>
            <div className="interaction-hint"><span><Mouse size={12} />ドラッグで回転</span><span><Move size={12} />右ドラッグで移動</span><span><Maximize2 size={12} />スクロールで拡大・縮小</span><span className="touch-hint">タッチで回転・2本指で拡大縮小</span></div>
          </section>

          <div className="metrics-grid" aria-live="polite" aria-busy={loading}>
            <div className="metric-card"><div className="metric-top"><span>UB内の平均風速</span><span className="metric-icon blue"><Wind size={18} /></span></div><div className="metric-value">{metrics ? metrics.meanSpeed.toFixed(3) : '—'}<span>m/s</span></div><p>浴室内の流速を空間平均</p></div>
            <div className="metric-card"><div className="metric-top"><span>1時間あたりの換気回数</span><span className="metric-icon teal"><Fan size={18} /></span></div><div className="metric-value">{metrics ? metrics.airChanges.toFixed(1) : '—'}<span>回 / h</span></div><p>想定排気量 <strong>{metrics ? Math.round(metrics.exhaust) : '—'} m³/h</strong> による目安</p></div>
            <div className="metric-card"><div className="metric-top"><span>空気が滞留するエリア</span><span className="metric-icon amber"><Gauge size={18} /></span></div><div className="metric-value">{metrics ? Math.round(metrics.stagnant) : '—'}<span>%</span><span className="metric-caption">空気領域に対する割合</span></div><p>風速 0.005 m/s 未満の領域</p></div>
            <div className="metric-card"><div className="metric-top"><span>UB内の回転の強さ</span><span className="metric-icon violet"><RotateCcw size={18} /></span></div><div className="metric-value">{metrics ? metrics.meanVorticity.toFixed(3) : '—'}<span>s⁻¹</span></div><p>渦度の平均・回転とせん断の指標</p></div>
          </div>
          <div className="insight"><span className="insight-icon"><Info size={17} /></span><p>{settings.door === 0 ? '戸が閉じていると、給気はドア下の隙間に限られます。開き具合を変えて、空気の通り道を比べてみましょう。' : settings.clothes >= 9 ? '洗濯物の間隔が狭くなっています。枚数を減らしたときの風の通り方と比較してみましょう。' : settings.fan ? '送風の向きを変えて、流れの発達を観察できます。「回転の強さ」に切り替えると、渦度の高い場所が見えます。' : '送風なしでは換気扇による流れを表示します。「全体矢印」で室内全域の風向を、「流線」で通り道を確認できます。時間が経てば部屋を一周する循環ができるとは限りません。'}</p></div>
          {lastFailure && <details className="failure-details"><summary>直前の計算エラーの詳細</summary><p>{flowFailureMessage(lastFailure)}</p><p>最終計算時刻：{lastFailure.time.toFixed(2)} 秒{lastFailure.settings && ` ／ ${lastFailure.settings.size}畳・衣類${lastFailure.settings.clothes}枚・戸${lastFailure.settings.door}%`}</p><button onClick={downloadFailure}><ArrowDownToLine size={14} />診断情報を保存</button><pre>{JSON.stringify(lastFailure, null, 2)}</pre></details>}
        </div>
      </div>
      <footer className="page-footer"><span><Info size={13} />換気・送風による流れの時間変化を観察するモデルです。実測値・乾燥時間を保証するものではありません。</span><button onClick={() => setHelp(true)}>モデルと操作について<ArrowRight size={13} /></button></footer>
    </main>
    {toast && <div role="status" className="toast"><Check size={16} />{toast}</div>}
    <dialog ref={helpDialog} className="help-dialog" onCancel={() => setHelp(false)} onClick={e => { if (e.target === helpDialog.current) setHelp(false); }}>
      <div className="dialog-header"><div><span className="eyebrow">QUICK GUIDE</span><h2>風の通り道を、探してみよう。</h2></div><button aria-label="使い方を閉じる" onClick={() => setHelp(false)}><X size={20} /></button></div>
      <div className="dialog-body"><h3>3Dビューの操作</h3><p>左ドラッグで回転、右ドラッグで平行移動、ホイールで拡大・縮小できます。タッチ操作では1本指で回転、2本指で移動・拡大縮小。「俯瞰」で真上から、「クォーター」で斜め上から見渡せます。</p><h3>条件を変えて比較</h3><p>3畳（1.8 × 2.7 m）／4.5畳（2.7 × 2.7 m）、衣類0〜12枚、戸の開度0〜100%、室外サーキュレーターのON／OFF・送風速度・左右／上下の向きを変更できます。換気扇は常時ONです。送風設定を変えても流れを引き継ぎます。サイズ・衣類数・戸の開度を変えると、形状が変わるため0秒から計算し直します。</p><h3>流れと色の見方</h3><p>基本表示の「全体矢印」は、UBと戸の前の空間を等間隔の観測点で表示します。灰色の点は観測位置で、風がほぼゼロの点も残ります。矢印は計算した風向へ、風速に比例して進みます。微風を見やすくするため、矢印の移動表示だけを一律{VECTOR_MOTION_SCALE}倍にしています。短いガイド線の上で消えて繰り返す表示で、部屋全体の観測位置は保たれます。無風の点は動きません。ガイド線の長さは見やすさのため補正しており、粒子の移動距離ではありません。風速は色の凡例でも比較できます。流線の開始点も全域に等間隔で配置し、給排気口だけを増やす処理はありません。軌跡・粒子は移動の様子を見る補助表示です。粒子は空間全体に配置して計算した速度場に沿って動かすため、動いた後の粒子密度は均一とは限らず、流量も表しません。</p><p>風速表示では青から緑、黄へ変わるほど速い流れです。「回転の強さ」では渦度を色にします。渦度は局所的な回転やせん断を示し、大きな渦の存在を単独で証明するものではありません。「流線」はその時点の風向を長い線でたどり、矢印で下流方向を示します。弱い流れも待たずに確認できますが、粒子が実際に通った経路や将来の予測ではありません。「軌跡」は粒子が直近に通った道です。時間が経てば部屋全体に一つの循環ができるとは限りません。時計・粒子・風速場・矢印は同じ計算時間に連動し、一時停止するとすべて止まります。再生倍率は0.5〜2倍で、端末の性能により進行が遅くなる場合があります。</p><h3>計算モデルと前提</h3><p>約11.25 cmの3D格子で、非圧縮Navier–Stokes方程式を近似する非定常計算です。運動量の移流、空気の粘性、衣類の抵抗、圧力補正を各時間ステップで計算します。送風機の近くだけに力を加え、流れが室内へ運ばれます。回転を見せるための人工的な渦の力は加えていません。天井の換気口を実際の流出口として扱い、粒子は開口面に到達してから排出されます。天井や壁の透過は表示上の処理で、開口以外を空気が通り抜けることはありません。</p><p>換気扇の全開時排気量を90 m³/h、戸を閉じた時を19.8 m³/hと仮定し、開度に応じて補間します。戸の下には15 mmの給気隙間があります。これらは実機の仕様ではなく、比較用の仮定です。送風速度もモデル上の目標値です。格子より小さい乱流、ファンの羽根による旋回、温湿度、蒸発、布の変形、乾燥時間は再現していません。数値拡散や格子の粗さの影響があり、実機との検証が必要です。</p><p className="source-note">圧力補正の考え方：<a href="https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu" target="_blank" rel="noreferrer">NVIDIA GPU Gems</a>。表示：<a href="https://threejs.org/docs/" target="_blank" rel="noreferrer">Three.js</a>。</p><button className="dialog-done" onClick={() => setHelp(false)}>シミュレーションをはじめる<ArrowRight size={16} /></button></div>
    </dialog>
  </div>;
}
