import React, { useState, useEffect, useRef, useCallback } from "react";
import { html } from "./html.js?v=27";
import { MouthEngine } from "./mouthEngine.js?v=27";
import * as store from "./store.js?v=27";

const OPEN_SCALE = 0.6; // 縦（あ）メーターの表示上限
const SPREAD_SCALE = 0.8; // 横（い）メーターの表示上限
const reachedStyle = { color: "#06231c", background: "#36c6a0", borderColor: "#36c6a0" };
const APP_VERSION = "v27";

const TONGUE_EXERCISES = [
  { id: "protrude", label: "挺舌（前に出す）" },
  { id: "lr", label: "左右反復" },
  { id: "ud", label: "上下反復" },
];
const tongueExLabel = (id) => (TONGUE_EXERCISES.find((e) => e.id === id) || {}).label || id;

const DEFAULT_SETTINGS = {
  mirror: true,
  level: false,
  zoom: 1.8,
  smoothing: 0.6,
  showLandmarks: true,
  lmOffX: 0,
  lmOffY: 0,
};

const LIPS_TABS = [
  { id: "setup", label: "初期設定" },
  { id: "patient", label: "患者" },
  { id: "target", label: "目標" },
  { id: "rhythm", label: "リズム" },
  { id: "view", label: "詳細" },
];
const TONGUE_TABS = [
  { id: "setup", label: "初期設定" },
  { id: "patient", label: "患者" },
  { id: "tongue", label: "舌の目標" },
  { id: "rhythm", label: "リズム" },
  { id: "view", label: "詳細" },
];

function mmText(rel, mmPerRel) {
  if (rel == null || !mmPerRel) return "—";
  return `約${Math.round(rel * mmPerRel)}mm`;
}
function clampNum(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function useIsMobile() {
  const q = "(max-width: 1000px)";
  const [m, setM] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q).matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia(q);
    const fn = (e) => setM(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return m;
}

export function App() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const metricsRef = useRef({
    openness: 0, spread: 0, mmPerRel: 0,
    reachedOpen: false, reachedSpread: false, reached: false,
    reps: 0, shadowMatch: false, hasFace: false,
    tongue: { present: false, out: 0, touch: { left: false, right: false, up: false, down: false } },
    tongueReps: 0,
  });
  const sessionStartRef = useRef(null);
  const audioCtxRef = useRef(null);
  const autoCalibRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [error, setError] = useState(null);
  const [rehab, setRehab] = useState("lips"); // lips | tongue（リハ種別の根本切替）
  const [mode, setMode] = useState("setup"); // setup | train
  const [tab, setTab] = useState("setup");
  const [metrics, setMetrics] = useState(metricsRef.current);

  const [openTarget, setOpenTarget] = useState(null);
  const [spreadTarget, setSpreadTarget] = useState(null);
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [calib, setCalib] = useState(null); // null | 'L' | 'R'

  const [bpm, setBpm] = useState(60);
  const [rhythmOn, setRhythmOn] = useState(false);
  const [rhythmPhase, setRhythmPhase] = useState(0); // 0=閉じる 1=開く

  const [slots, setSlots] = useState(store.getSlots());
  const [sessionActive, setSessionActive] = useState(false);

  // 舌（色検出方式）
  const [tongueExercise, setTongueExercise] = useState(null); // 'protrude'|'lr'|'ud'

  // ---- 起動 ----------------------------------------------------------------
  useEffect(() => {
    const eng = new MouthEngine(canvasRef.current);
    engineRef.current = eng;
    eng.onMetrics = (m) => {
      metricsRef.current = m;
    };
    eng.onError = (e) => setError(e.message);
    eng.setEditable(false);
    eng.onCalibrate = (dx, dy) =>
      setSettings((s) => ({
        ...s,
        lmOffX: clampNum((s.lmOffX || 0) + dx, -300, 300),
        lmOffY: clampNum((s.lmOffY || 0) + dy, -300, 300),
      }));
    eng.onCalibStep = (step) => setCalib(step == null ? null : step === 0 ? "L" : "R");

    if (!window.isSecureContext) {
      setError("カメラは https または http://localhost でのみ利用できます。");
    }
    eng.start().then(() => setReady(true)).catch(() => {});
    return () => eng.stop();
  }, []);

  // 起動ウォッチドッグ：一定時間 ready にならなければ「固まった」ではなく
  // 再読み込み等の手を打てるよう、案内を表示する（カメラ許可・通信の失敗対策）。
  useEffect(() => {
    if (ready) {
      setStalled(false);
      return;
    }
    const id = setTimeout(() => setStalled(true), 12000);
    return () => clearTimeout(id);
  }, [ready]);

  useEffect(() => {
    const id = setInterval(() => setMetrics({ ...metricsRef.current }), 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => store.subscribe(() => setSlots(store.getSlots())), []);

  // 設定をエンジンへ反映
  useEffect(() => {
    engineRef.current && engineRef.current.setSettings(settings);
  }, [settings]);
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.setOpenTarget(openTarget);
    e.setSpreadTarget(spreadTarget);
  }, [openTarget, spreadTarget]);

  // 舌リハ：色検出ON＋種目設定＋ガイド点（水色/赤）表示
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    const on = rehab === "tongue";
    e.setShowTonguePoints(on);
    e.setTongueDetect(on);
    e.setTongueExercise(on ? tongueExercise : null);
  }, [rehab, tongueExercise]);

  // モバイルで実際に見える高さを反映（無スクロール化）
  useEffect(() => {
    const setH = () =>
      document.documentElement.style.setProperty("--apph", window.innerHeight + "px");
    setH();
    window.addEventListener("resize", setH);
    window.addEventListener("orientationchange", setH);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", setH);
    return () => {
      window.removeEventListener("resize", setH);
      window.removeEventListener("orientationchange", setH);
      if (window.visualViewport) window.visualViewport.removeEventListener("resize", setH);
    };
  }, []);

  // ---- リズム（メトロノーム：音＋視覚）-------------------------------------
  const playClick = useCallback((phase) => {
    try {
      let ctx = audioCtxRef.current;
      if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtxRef.current = ctx;
      }
      if (ctx.state === "suspended") ctx.resume();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = phase ? 880 : 620;
      o.connect(g);
      g.connect(ctx.destination);
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.start(t);
      o.stop(t + 0.13);
    } catch {
      /* 音が出せない環境は無視 */
    }
  }, []);

  useEffect(() => {
    if (!rhythmOn) return;
    let phase = 0;
    const beat = () => {
      phase ^= 1;
      setRhythmPhase(phase);
      playClick(phase);
    };
    beat();
    const id = setInterval(beat, Math.max(300, 60000 / bpm));
    return () => clearInterval(id);
  }, [rhythmOn, bpm, playClick]);

  // ---- 操作ハンドラ --------------------------------------------------------
  const eng = () => engineRef.current;
  const startCalib = useCallback(() => {
    setCalib("L");
    eng().startCalibration();
  }, []);
  const skipCalib = useCallback(() => {
    eng().cancelCalibration();
    setCalib(null);
  }, []);
  useEffect(() => {
    if (ready && !autoCalibRef.current) {
      autoCalibRef.current = true;
      startCalib();
    }
  }, [ready, startCalib]);

  const setOpenFromCurrent = useCallback(() => setOpenTarget(+metricsRef.current.openness.toFixed(3)), []);
  const setSpreadFromCurrent = useCallback(() => setSpreadTarget(+metricsRef.current.spread.toFixed(3)), []);

  const startSession = useCallback(() => {
    eng().resetReps(); // 口唇・舌の反復をリセット
    sessionStartRef.current = performance.now();
    setSessionActive(true);
    setMetrics({ ...metricsRef.current, reps: 0, tongueReps: 0 });
  }, []);
  const endSession = useCallback(() => {
    sessionStartRef.current = null;
    setSessionActive(false);
  }, []);

  // ---- スロット（設定の保存／読み込み）-------------------------------------
  const currentConfig = () => ({
    rehab,
    openTarget,
    spreadTarget,
    bpm,
    tongueExercise,
    settings: { ...settings },
  });
  const applyConfig = (cfg) => {
    if (!cfg) return;
    if (cfg.rehab) setRehab(cfg.rehab);
    setOpenTarget(cfg.openTarget ?? null);
    setSpreadTarget(cfg.spreadTarget ?? null);
    setBpm(cfg.bpm ?? 60);
    setTongueExercise(cfg.tongueExercise ?? null);
    setSettings((s) => ({ ...s, ...(cfg.settings || {}) }));
  };

  const activeReached = openTarget != null || spreadTarget != null ? metrics.reached : false;

  // ---- パネル分配 ----------------------------------------------------------
  const common = {
    settings, setSettings, metrics,
    openTarget, setOpenTarget, setOpenFromCurrent,
    spreadTarget, setSpreadTarget, setSpreadFromCurrent,
    bpm, setBpm, rhythmOn, setRhythmOn,
    calib, startCalib,
    slots, currentConfig, applyConfig,
    setError, rehab,
    tongueExercise, setTongueExercise,
  };
  const tabs = rehab === "tongue" ? TONGUE_TABS : LIPS_TABS;
  const effTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const renderSection = (id) => {
    switch (id) {
      case "setup": return html`<${SetupCard} ...${common} />`;
      case "patient": return html`<${PatientCard} ...${common} />`;
      case "target": return html`<${TargetCard} ...${common} />`;
      case "tongue": return html`<${TongueCard} ...${common} />`;
      case "rhythm": return html`<${RhythmCard} ...${common} />`;
      case "view": return html`<${ViewCard} ...${common} />`;
      default: return null;
    }
  };

  return html`
    <div className="app">
      <div className="topbar">
        <div className="brand">kuchihold <span className="ver">${APP_VERSION}</span></div>
        <div className="spacer"></div>
        <div className="mode-switch">
          <button className=${rehab === "lips" ? "active" : ""} onClick=${() => setRehab("lips")}>口唇リハ</button>
          <button className=${rehab === "tongue" ? "active" : ""} onClick=${() => setRehab("tongue")}>舌リハ</button>
        </div>
        <div className="mode-switch">
          <button className=${mode === "setup" ? "active" : ""} onClick=${() => setMode("setup")}>設定</button>
          <button className=${mode === "train" ? "active" : ""} onClick=${() => setMode("train")}>訓練</button>
        </div>
      </div>

      ${error &&
      html`<div className="error-box">
        ⚠️ ${error} <button className="ghost small" onClick=${() => setError(null)}>閉じる</button>
      </div>`}

      <div className=${"layout " + mode}>
        ${mode === "setup" &&
        html`<div key="tabs" className="tabbar">
          ${tabs.map(
            (tb) => html`<button key=${tb.id} className=${effTab === tb.id ? "active" : ""}
              onClick=${() => setTab(tb.id)}>${tb.label}</button>`
          )}
        </div>`}

        <${Stage}
          key="stage"
          canvasRef=${canvasRef}
          ready=${ready}
          stalled=${stalled}
          metrics=${metrics}
          mode=${mode}
          calib=${calib}
          onSkip=${skipCalib}
          rhythmOn=${rhythmOn}
          rhythmPhase=${rhythmPhase}
          openTarget=${openTarget}
          spreadTarget=${spreadTarget}
          reached=${activeReached}
          sessionActive=${sessionActive}
          startSession=${startSession}
          endSession=${endSession}
          rehab=${rehab}
          tongueExercise=${tongueExercise}
        />

        ${mode === "setup" &&
        html`<div key="panel" className="mobile-panel">${renderSection(effTab)}</div>`}
      </div>
    </div>
  `;
}

// ---- 中央ステージ（常時マウント：カメラ要素を安定させる）------------------
function Stage(props) {
  const {
    canvasRef, ready, stalled, metrics, mode, calib, onSkip,
    rhythmOn, rhythmPhase, openTarget, spreadTarget, reached,
    sessionActive, startSession, endSession,
    rehab, tongueExercise,
  } = props;
  const statusText = !ready
    ? "カメラを準備しています…"
    : !metrics.hasFace
    ? "顔が画面に入るように調整してください"
    : "口元を検出中";
  const warn = ready && !metrics.hasFace;
  const train = mode === "train";

  return html`
    <div className=${"stage " + mode}>
      <div className=${"stage-canvas-wrap" + (train && reached ? " reached" : "")}>
        <canvas ref=${canvasRef} className="mouth"></canvas>

        ${!calib && !train &&
        html`<div className=${"stage-status" + (warn ? " warn" : "")}>${statusText}</div>`}

        ${!ready && stalled &&
        html`<div className="stage-stalled">
          <div className="msg">
            カメラの準備に時間がかかっています。<br />
            カメラの許可を「許可」にして、ページを再読み込みしてください。
          </div>
          <button className="primary" onClick=${() => window.location.reload()}>🔄 再読み込み</button>
        </div>`}

        ${calib &&
        html`<button className="calib-skip" onClick=${onSkip}>スキップ ✕</button>`}
        ${calib &&
        html`<div className="calib-banner">
          <span className="step">${calib === "L" ? "①" : "②"}</span>
          画面の自分の<b>${calib === "L" ? "左" : "右"}の口角</b>をタップ
        </div>`}

        ${rhythmOn &&
        html`<div className=${"rhythm-cue " + (rhythmPhase ? "open" : "close")}>
          <div className="rhythm-ring"></div>
          <div className="rhythm-text">${rhythmPhase ? "開く" : "閉じる"}</div>
        </div>`}

        ${train &&
        html`<${TrainOverlay}
          metrics=${metrics} openTarget=${openTarget} spreadTarget=${spreadTarget}
          sessionActive=${sessionActive} startSession=${startSession} endSession=${endSession}
          rehab=${rehab} tongueExercise=${tongueExercise}
        />`}
      </div>
    </div>
  `;
}

// ---- 訓練オーバーレイ（カメラ上に大きく表示）------------------------------
function TrainOverlay(props) {
  const {
    metrics, openTarget, spreadTarget, sessionActive, startSession, endSession,
    rehab, tongueExercise,
  } = props;
  const tongueMode = rehab === "tongue" && tongueExercise != null;
  const hasTarget = tongueMode || openTarget != null || spreadTarget != null;
  const tg = metrics.tongue || {};
  const touch = tg.touch || {};
  const reps = tongueMode ? metrics.tongueReps || 0 : metrics.reps;
  const tongueHit =
    tongueExercise === "protrude"
      ? (tg.out || 0) > 0.5
      : tongueExercise === "lr"
      ? touch.left || touch.right
      : touch.up || touch.down;
  const tongueState =
    tongueExercise === "protrude"
      ? (tg.out || 0) > 0.5
        ? "舌が出ています！"
        : "舌を前に出しましょう"
      : tongueExercise === "lr"
      ? "水色の点に舌先をタッチ"
      : "赤い点に舌先をタッチ";

  return html`
    <div className="train-overlay">
      <div className="train-top">
        ${tongueMode
          ? html`<div className=${"train-tongue" + (tongueHit ? " hit" : "")}>
              <span className="muted">舌の種目</span>
              <b>${tongueExLabel(tongueExercise)}</b>
              <span className="now">${tongueState}</span>
            </div>`
          : html`
            ${openTarget != null &&
            html`<div className="train-meter">
              <span>あ</span><${Meter} value=${metrics.openness} target=${openTarget} scale=${OPEN_SCALE} reached=${metrics.reachedOpen} />
            </div>`}
            ${spreadTarget != null &&
            html`<div className="train-meter">
              <span>い</span><${Meter} value=${metrics.spread} target=${spreadTarget} scale=${SPREAD_SCALE} reached=${metrics.reachedSpread} />
            </div>`}`}
      </div>

      <div className="train-reps">
        <div className="num">${reps}</div>
        <div className="lbl">回</div>
      </div>

      <div className="train-controls">
        ${!sessionActive
          ? html`<button className="primary big" onClick=${startSession}>▶ はじめる</button>`
          : html`<button className="big" onClick=${endSession}>■ 終了</button>`}
      </div>

      ${!hasTarget &&
      html`<div className="train-hint">「設定」で目標（口唇 or 舌）を設定すると、ここに表示されます。</div>`}
    </div>
  `;
}

// ---- メーター --------------------------------------------------------------
function Meter({ value, target, scale, reached }) {
  const pct = Math.min(100, (value / scale) * 100);
  const tPct = target != null ? Math.min(100, (target / scale) * 100) : null;
  return html`
    <div className=${"meter" + (reached ? " meter-reached" : "")}>
      <div className="fill" style=${{ width: pct + "%" }}></div>
      ${tPct != null && html`<div className="target" style=${{ left: tPct + "%" }}></div>`}
    </div>
  `;
}

// ---- 初期設定（口角の位置合わせ）------------------------------------------
function SetupCard({ settings, calib, startCalib }) {
  return html`
    <div className="side">
      <div className="card">
        <h3>初期設定 — 口角の位置合わせ</h3>
        <p className="hint">
          カメラに顔を正面で映し、ボタンを押して画面の自分の<b>左→右の口角</b>を順にタップします。
          点・輪郭が口元にぴったり合うよう自動調整されます。
        </p>
        <button className=${"primary" + (calib ? " active" : "")} style=${{ width: "100%" }}
          onClick=${startCalib}>
          ${calib ? (calib === "L" ? "① 左の口角をタップ…" : "② 右の口角をタップ…") : "🎯 位置合わせを開始"}
        </button>
        <div className="row between small muted" style=${{ marginTop: 8 }}>
          <span>現在の補正</span>
          <span>X ${Math.round(settings.lmOffX || 0)} / Y ${Math.round(settings.lmOffY || 0)}px</span>
        </div>
        <p className="hint">細かな調整は「詳細」タブの手動補正でも行えます。</p>
      </div>
    </div>
  `;
}

// ---- 患者（5×10 スロット）--------------------------------------------------
function PatientCard({ slots, currentConfig, applyConfig, setError }) {
  const [sel, setSel] = useState(null);
  const [name, setName] = useState("");
  const selected = sel != null ? slots[sel] : null;

  const onSave = () => {
    try {
      store.saveSlot(sel, name || (selected && selected.name) || `No.${sel + 1}`, currentConfig());
      setName("");
    } catch (e) {
      setError(e.message);
    }
  };

  return html`
    <div className="side">
      <div className="card">
        <h3>患者スロット（タップで選択）</h3>
        <div className="slot-grid">
          ${slots.map(
            (s, i) => html`<button key=${i}
              className=${"slot" + (s ? " filled" : "") + (sel === i ? " sel" : "")}
              onClick=${() => { setSel(i); setName(s ? s.name : ""); }}>
              ${s ? s.name : i + 1}
            </button>`
          )}
        </div>
      </div>

      ${sel != null &&
      html`<div className="card">
        <h3>スロット ${sel + 1}</h3>
        ${selected
          ? html`<div className="muted small">保存日 ${store.formatDate(selected.savedAt)}</div>`
          : html`<div className="muted small">空きスロット</div>`}
        <div className="row" style=${{ marginTop: 8 }}>
          <input placeholder="名前（番号など）" value=${name}
            onChange=${(e) => setName(e.target.value)} style=${{ flex: 1 }} />
        </div>
        <div className="row wrap" style=${{ marginTop: 8 }}>
          <button className="primary" onClick=${onSave}>${selected ? "上書き保存" : "ここに保存"}</button>
          <button onClick=${() => applyConfig(selected && selected.config)} disabled=${!selected}>読み込み</button>
          <button className="ghost danger" onClick=${() => store.clearSlot(sel)} disabled=${!selected}>消去</button>
        </div>
        <p className="hint">「保存」で現在の目標・位置合わせ・表示・リズム設定をまとめて保存します。</p>
      </div>`}
    </div>
  `;
}

// ---- 目標 ------------------------------------------------------------------
function TargetCard(props) {
  const {
    metrics, openTarget, setOpenTarget, setOpenFromCurrent,
    spreadTarget, setSpreadTarget, setSpreadFromCurrent,
  } = props;
  const mpr = metrics.mmPerRel;
  const relFromMm = (mm) => (mpr ? mm / mpr : null);

  const axis = (label, sub, value, target, setTarget, setFromCur, scale, reached) => html`
    <div style=${{ marginTop: 6 }}>
      <div className="row between small">
        <span>${label}（${sub}）</span>
        <span className="muted">今 ${mmText(value, mpr)} / 目標 ${mmText(target, mpr)}</span>
      </div>
      <${Meter} value=${value} target=${target} scale=${scale} reached=${reached} />
      <div className="row wrap" style=${{ marginTop: 6 }}>
        <button onClick=${setFromCur}>今の値を目標に</button>
        <label className="inline-mm">
          mm
          <input type="number" min="0" step="1"
            value=${target != null && mpr ? Math.round(target * mpr) : ""}
            onChange=${(e) => {
              const r = relFromMm(+e.target.value);
              setTarget(r == null || !e.target.value ? null : +r.toFixed(3));
            }}
            disabled=${!mpr} style=${{ width: 64 }} />
        </label>
        <button className="ghost" onClick=${() => setTarget(null)} disabled=${target == null}>解除</button>
      </div>
    </div>
  `;

  return html`
    <div className="side">
      <div className="card">
        <h3>運動の目標（あ＝縦 / い＝横）</h3>
        ${axis("あ", "縦の開き", metrics.openness, openTarget, setOpenTarget, setOpenFromCurrent, OPEN_SCALE, metrics.reachedOpen)}
        ${axis("い", "横の広がり", metrics.spread, spreadTarget, setSpreadTarget, setSpreadFromCurrent, SPREAD_SCALE, metrics.reachedSpread)}
        <p className="hint" style=${{ marginTop: 8 }}>
          「今の値を目標に」＝患者にその形をしてもらいボタン。mm欄に直接入力も可（概算・推定）。
        </p>
      </div>
    </div>
  `;
}

// ---- リズム ----------------------------------------------------------------
function RhythmCard({ bpm, setBpm, rhythmOn, setRhythmOn }) {
  return html`
    <div className="side">
      <div className="card">
        <h3>リズム（テンポ提示）</h3>
        <p className="hint">
          音と画面の合図で運動のテンポを示します。「開く／閉じる」に合わせて軽快に動かしましょう。
        </p>
        <button className=${"primary" + (rhythmOn ? " active" : "")} style=${{ width: "100%" }}
          onClick=${() => setRhythmOn(!rhythmOn)}>
          ${rhythmOn ? "■ リズムを止める" : "▶ リズムを開始"}
        </button>
        <label className="field" style=${{ marginTop: 12 }}>
          テンポ ${bpm} BPM（1拍 ${(60 / bpm).toFixed(1)} 秒）
          <input type="range" min="30" max="120" value=${bpm}
            onChange=${(e) => setBpm(+e.target.value)} />
        </label>
        <p className="hint">「訓練」画面でも、このリズムが合図として表示されます。</p>
      </div>
    </div>
  `;
}

// ---- 舌の種目（目標点タッチ＋AI挺舌判定で自動カウント。準備不要）----------
function TongueCard(props) {
  const { tongueExercise, setTongueExercise, metrics } = props;
  const tg = metrics.tongue || {};
  const touch = tg.touch || {};
  const outPct = Math.round((tg.out || 0) * 100);
  const dot = (on, label) => html`
    <span className="badge" style=${on ? reachedStyle : {}}>${label}</span>
  `;
  return html`
    <div className="side">
      <div className="card">
        <h3>舌の種目を選ぶ</h3>
        <div className="list">
          ${TONGUE_EXERCISES.map(
            (e) => html`<button key=${e.id}
              className=${"row between" + (tongueExercise === e.id ? " active" : "")}
              style=${{ textAlign: "left" }}
              onClick=${() => setTongueExercise(tongueExercise === e.id ? null : e.id)}>
              <span>${e.label}</span>${tongueExercise === e.id ? html`<span>✓</span>` : ""}
            </button>`
          )}
        </div>
        <p className="hint" style=${{ marginTop: 8 }}>
          <b style=${{ color: "#4ea1ff" }}>水色の点（口角の少し外）</b>に舌先が届くと左右のカウント、
          <b style=${{ color: "#ff5b6e" }}>赤い点（上唇の上・下唇の下）</b>で上下のカウント。
          挺舌はAIが舌の突出を自動判定します。<b>タップなどの準備は不要</b>、届くと点が緑に光ります。
        </p>
      </div>

      <div className="card">
        <h3>動作チェック（今の検出状態）</h3>
        <div className="row between small">
          <span>挺舌（舌の突出・AI判定）</span>
          <span className="badge" style=${(tg.out || 0) > 0.5 ? reachedStyle : {}}>${outPct}%</span>
        </div>
        <div className="row between small" style=${{ marginTop: 8 }}>
          <span>点へのタッチ</span>
          <span className="row" style=${{ gap: 4 }}>
            ${dot(touch.left, "左")} ${dot(touch.right, "右")} ${dot(touch.up, "上")} ${dot(touch.down, "下")}
          </span>
        </div>
        <p className="hint" style=${{ marginTop: 8 }}>
          舌を出して点に触れてみて、ここが反応するか確認できます。反応が悪ければ照明を明るくしてください。
        </p>
      </div>
    </div>
  `;
}

// ---- 詳細（映像の安定化・表示）--------------------------------------------
function ViewCard(props) {
  const { settings, setSettings } = props;
  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));
  const nudge = (dx, dy) =>
    set({
      lmOffX: clampNum((settings.lmOffX || 0) + dx, -120, 120),
      lmOffY: clampNum((settings.lmOffY || 0) + dy, -120, 120),
    });
  return html`
    <div className="side">
      <div className="card">
        <h3>映像の安定化・表示</h3>
        <div className="row wrap">
          <button className=${settings.mirror ? "active" : ""} onClick=${() => set({ mirror: !settings.mirror })}>鏡表示</button>
          <button className=${settings.level ? "active" : ""} onClick=${() => set({ level: !settings.level })}>傾き補正</button>
          <button className=${settings.showLandmarks ? "active" : ""} onClick=${() => set({ showLandmarks: !settings.showLandmarks })}>口元の輪郭</button>
        </div>
        <label className="field" style=${{ marginTop: 10 }}>
          ズーム（小さいほど寄り／大きいほど引き）
          <input type="range" min="1" max="3.5" step="0.1" value=${settings.zoom}
            onChange=${(e) => set({ zoom: +e.target.value })} />
        </label>
        <label className="field">
          口元の固定の強さ ${Math.round(settings.smoothing * 100)}
          <input type="range" min="20" max="95" value=${Math.round(settings.smoothing * 100)}
            onChange=${(e) => set({ smoothing: +e.target.value / 100 })} />
        </label>
        <div className="row between small" style=${{ marginTop: 12 }}>
          <span>点・輪郭の手動補正</span>
          <span className="muted">X ${Math.round(settings.lmOffX || 0)} / Y ${Math.round(settings.lmOffY || 0)}px</span>
        </div>
        <div className="nudge">
          <button onClick=${() => nudge(0, -3)}>▲</button>
          <div className="row" style=${{ gap: 6 }}>
            <button onClick=${() => nudge(-3, 0)}>◀</button>
            <button className="ghost small" onClick=${() => set({ lmOffX: 0, lmOffY: 0 })}>リセット</button>
            <button onClick=${() => nudge(3, 0)}>▶</button>
          </div>
          <button onClick=${() => nudge(0, 3)}>▼</button>
        </div>
      </div>
    </div>
  `;
}
