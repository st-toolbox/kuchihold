import React, { useState, useEffect, useRef, useCallback } from "react";
import { html } from "./html.js?v=11";
import { MouthEngine, STAMP_TYPES } from "./mouthEngine.js?v=11";
import * as store from "./store.js?v=11";

const COLORS = ["#ffd166", "#ef476f", "#06d6a0", "#4ea1ff", "#ffffff"];
const OPEN_SCALE = 0.6; // 縦（あ）メーターの表示上限
const SPREAD_SCALE = 0.8; // 横（い）メーターの表示上限
const reachedStyle = { color: "#06231c", background: "#36c6a0", borderColor: "#36c6a0" };
const APP_VERSION = "v14"; // 画面右上に表示。キャッシュ確認用。

// 相対値 → 概算mm（推定）。mmPerRel が未確定なら「—」。
function mmText(rel, mmPerRel) {
  if (rel == null || !mmPerRel) return "—";
  return `約${Math.round(rel * mmPerRel)}mm`;
}

function clampNum(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// 画面幅でモバイル判定（スマホ縦持ちでタブUIに切替）
function useIsMobile() {
  const q = "(max-width: 1000px)";
  const [m, setM] = useState(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(q).matches
      : false
  );
  useEffect(() => {
    const mq = window.matchMedia(q);
    const fn = (e) => setM(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return m;
}

// 「描く」は当面非表示。再開したくなったら SHOW_DRAW を true に。
const SHOW_DRAW = false;
const ST_TABS = [
  ...(SHOW_DRAW ? [{ id: "draw", label: "描く" }] : []),
  { id: "target", label: "目標" },
  { id: "shadow", label: "シャドウ" },
  { id: "view", label: "表示" },
  { id: "save", label: "保存" },
  { id: "patient", label: "患者" },
];
const SELF_TABS = [
  { id: "practice", label: "練習" },
  { id: "patient", label: "患者" },
];

export function App() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const metricsRef = useRef({
    openness: 0,
    spread: 0,
    mmPerRel: 0,
    reachedOpen: false,
    reachedSpread: false,
    reached: false,
    reps: 0,
    shadowMatch: false,
    hasFace: false,
  });
  const sessionStartRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState("st"); // st | self
  const [metrics, setMetrics] = useState(metricsRef.current);

  const [patients, setPatients] = useState(store.listPatients());
  const [activeId, setActiveId] = useState(null);

  // エンジン設定の UI ミラー
  const [tool, setTool] = useState("pen");
  const [stampType, setStampType] = useState("ring");
  const [color, setColor] = useState(COLORS[0]);
  const [penSize, setPenSize] = useState(7);
  const [stampSize, setStampSize] = useState(90);
  const [openTarget, setOpenTarget] = useState(null);
  const [spreadTarget, setSpreadTarget] = useState(null);
  const [settings, setSettings] = useState({
    mirror: true,
    level: false,
    zoom: 1.8, // 顔サイズ基準。大きいほど引き（口元＋周辺が広く映る）
    smoothing: 0.6,
    shadowAlpha: 0.4,
    showLandmarks: true,
    lmOffX: 0,
    lmOffY: 0,
  });
  const [hasShadow, setHasShadow] = useState(false);

  // ---- 起動 ----------------------------------------------------------------
  useEffect(() => {
    const eng = new MouthEngine(canvasRef.current);
    engineRef.current = eng;
    eng.onMetrics = (m) => {
      metricsRef.current = m;
    };
    eng.onError = (e) => setError(e.message);
    eng.setEditable(false);
    // 口角タップ位置合わせのコールバック
    eng.onCalibrate = (dx, dy) =>
      setSettings((s) => ({
        ...s,
        lmOffX: clampNum((s.lmOffX || 0) + dx, -300, 300),
        lmOffY: clampNum((s.lmOffY || 0) + dy, -300, 300),
      }));
    eng.onCalibStep = (step) =>
      setCalib(step == null ? null : step === 0 ? "L" : "R");

    if (!window.isSecureContext) {
      setError(
        "カメラは https または localhost でのみ利用できます。ローカルで開く場合は README の手順でサーバ経由（http://localhost）で開いてください。"
      );
    }

    eng
      .start()
      .then(() => setReady(true))
      .catch(() => {});

    return () => eng.stop();
  }, []);

  // メトリクスは 10Hz で React に反映（再描画を抑制）
  useEffect(() => {
    const id = setInterval(() => setMetrics({ ...metricsRef.current }), 100);
    return () => clearInterval(id);
  }, []);

  // store 購読
  useEffect(() => {
    return store.subscribe(() => setPatients(store.listPatients()));
  }, []);

  // 設定をエンジンへ反映
  useEffect(() => {
    engineRef.current && engineRef.current.setSettings(settings);
  }, [settings]);
  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    e.setTool(tool);
    e.setStampType(stampType);
    e.setColor(color);
    e.setPenSize(penSize);
    e.setStampSize(stampSize);
    e.setOpenTarget(openTarget);
    e.setSpreadTarget(spreadTarget);
  }, [tool, stampType, color, penSize, stampSize, openTarget, spreadTarget]);

  // 手書き編集の可否（「描く」非表示中は無効。誤タッチで線が入らないように）
  useEffect(() => {
    engineRef.current && engineRef.current.setEditable(mode === "st" && SHOW_DRAW);
  }, [mode]);

  // モバイルで「実際に見えている高さ」を CSS 変数に反映（アドレスバー対応・無スクロール化）
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

  // 起動時：カメラ準備ができたら最初に口角タップ位置合わせを表示
  const autoCalibRef = useRef(false);
  useEffect(() => {
    if (ready && !autoCalibRef.current) {
      autoCalibRef.current = true;
      startCalib();
    }
  }, [ready, startCalib]);

  const captureShadow = useCallback(() => {
    eng().captureShadow();
    setHasShadow(true);
  }, []);
  const clearShadow = useCallback(() => {
    eng().clearShadow();
    setHasShadow(false);
  }, []);
  const setOpenFromCurrent = useCallback(() => {
    const v = +metricsRef.current.openness.toFixed(3);
    setOpenTarget(v);
  }, []);
  const setSpreadFromCurrent = useCallback(() => {
    const v = +metricsRef.current.spread.toFixed(3);
    setSpreadTarget(v);
  }, []);

  const savePreset = useCallback(
    (name) => {
      if (!activeId) {
        setError("先に患者（管理番号）を選択してください。");
        return;
      }
      try {
        const preset = eng().getPreset(name);
        store.savePreset(activeId, preset);
      } catch (e) {
        setError(e.message);
      }
    },
    [activeId]
  );

  const loadPreset = useCallback((preset) => {
    eng().loadPreset(preset);
    setOpenTarget(preset.openTarget ?? null);
    setSpreadTarget(preset.spreadTarget ?? null);
    setHasShadow(!!preset.shadow);
  }, []);

  const startSession = useCallback(() => {
    eng().resetReps();
    sessionStartRef.current = performance.now();
    setMetrics({ ...metricsRef.current, reps: 0 });
  }, []);

  const endSession = useCallback(
    (note) => {
      if (!activeId || sessionStartRef.current == null) return;
      const durationSec = (performance.now() - sessionStartRef.current) / 1000;
      store.logSession(activeId, {
        durationSec,
        reps: metricsRef.current.reps,
        note: note || "",
      });
      sessionStartRef.current = null;
    },
    [activeId]
  );

  const activePatient = activeId ? store.getPatient(activeId) : null;
  const isMobile = useIsMobile();
  const [tab, setTab] = useState("target");
  const [calib, setCalib] = useState(null); // null | 'L' | 'R'（口角タップ位置合わせ）

  // パネルへ渡すまとめ（デスクトップ／モバイル共通で使用）
  const toolProps = {
    tool, setTool, stampType, setStampType, color, setColor,
    penSize, setPenSize, stampSize, setStampSize,
    settings, setSettings,
    openTarget, setOpenTarget, setOpenFromCurrent,
    spreadTarget, setSpreadTarget, setSpreadFromCurrent,
    metrics, hasShadow, captureShadow, clearShadow,
    engine: eng, savePreset, hasPatient: !!activeId,
    startCalib, calib,
  };
  const patientProps = { patients, activeId, setActiveId, activePatient, loadPreset, mode, setError };
  const practiceProps = {
    metrics, openTarget, spreadTarget, startSession, endSession,
    hasPatient: !!activeId, sessionActive: sessionStartRef.current != null,
  };

  const tabs = mode === "st" ? ST_TABS : SELF_TABS;
  const effTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const renderSection = (id) => {
    switch (id) {
      case "draw": return html`<${DrawCard} ...${toolProps} />`;
      case "target": return html`<${TargetCard} ...${toolProps} />`;
      case "shadow": return html`<${ShadowCard} ...${toolProps} />`;
      case "view": return html`<${ViewCard} ...${toolProps} />`;
      case "save": return html`<${SaveCard} ...${toolProps} />`;
      case "practice": return html`<${PracticePanel} ...${practiceProps} />`;
      case "patient": return html`<${PatientPanel} ...${patientProps} />`;
      default: return null;
    }
  };

  const stage = html`<${Stage} canvasRef=${canvasRef} metrics=${metrics} ready=${ready} calib=${calib} onSkip=${skipCalib} />`;

  // ---- 描画 ----------------------------------------------------------------
  return html`
    <div className="app">
      <div className="topbar">
        <div className="brand">kuchihold <small>口腔運動ミラートレーニング</small> <span className="ver">${APP_VERSION}</span></div>
        <div className="spacer"></div>
        <div className="mode-switch">
          <button
            className=${mode === "st" ? "active" : ""}
            onClick=${() => setMode("st")}
            title="言語聴覚士が目標を設定・編集するモード"
          >
            ST指導
          </button>
          <button
            className=${mode === "self" ? "active" : ""}
            onClick=${() => setMode("self")}
            title="患者が自分で練習するモード（編集ロック）"
          >
            自主練習
          </button>
        </div>
      </div>

      ${error &&
      html`<div className="error-box">
        ⚠️ ${error} <button className="ghost small" onClick=${() => setError(null)}>閉じる</button>
      </div>`}

      ${isMobile
        ? html`
            <div className="layout mobile">
              <div className="tabbar">
                ${tabs.map(
                  (tb) => html`<button key=${tb.id}
                    className=${effTab === tb.id ? "active" : ""}
                    onClick=${() => setTab(tb.id)}>${tb.label}</button>`
                )}
              </div>
              ${stage}
              <div className="mobile-panel">${renderSection(effTab)}</div>
            </div>
          `
        : html`
            <div className="layout">
              <${PatientPanel} ...${patientProps} />
              ${stage}
              ${mode === "st"
                ? html`<${ToolPanel} ...${toolProps} />`
                : html`<${PracticePanel} ...${practiceProps} />`}
            </div>
          `}
    </div>
  `;
}

// ---- 中央ステージ ----------------------------------------------------------
function Stage({ canvasRef, metrics, ready, calib, onSkip }) {
  const statusText = !ready
    ? "カメラを準備しています…"
    : !metrics.hasFace
    ? "顔が画面に入るように位置を調整してください"
    : "口元を検出中";
  const warn = ready && !metrics.hasFace;
  return html`
    <div className="stage">
      <div className="stage-canvas-wrap">
        <canvas ref=${canvasRef} className="mouth"></canvas>
        ${!calib &&
        html`<div className=${"stage-status" + (warn ? " warn" : "")}>${statusText}</div>`}
        ${calib &&
        html`<button className="calib-skip" onClick=${onSkip}>スキップ ✕</button>`}
        ${calib &&
        html`<div className="calib-banner">
          <span className="step">${calib === "L" ? "①" : "②"}</span>
          画面の自分の<b>${calib === "L" ? "左" : "右"}の口角</b>をタップ
        </div>`}
      </div>
    </div>
  `;
}

// ---- メーター（縦/横 共通）-------------------------------------------------
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

// ---- 左：患者パネル --------------------------------------------------------
function PatientPanel({ patients, activeId, setActiveId, activePatient, loadPreset, mode, setError }) {
  const [newId, setNewId] = useState("");

  const add = () => {
    try {
      const id = store.addPatient(newId);
      setNewId("");
      setActiveId(id);
    } catch (e) {
      setError(e.message);
    }
  };

  return html`
    <div className="side">
      <div className="card">
        <h3>患者（管理番号）</h3>
        <div className="row">
          <input
            placeholder="番号 例: 001"
            value=${newId}
            onChange=${(e) => setNewId(e.target.value)}
            onKeyDown=${(e) => e.key === "Enter" && add()}
            style=${{ flex: 1 }}
          />
          <button className="primary" onClick=${add}>追加</button>
        </div>
        <p className="hint">氏名などの個人情報は登録しません。識別は番号のみ。</p>
        <div className="list" style=${{ marginTop: 8 }}>
          ${patients.length === 0 &&
          html`<div className="muted small">まだ登録がありません。</div>`}
          ${patients.map(
            (p) => html`
              <div
                key=${p.id}
                className=${"patient" + (p.id === activeId ? " active" : "")}
                onClick=${() => setActiveId(p.id)}
              >
                <span className="id">${p.id}</span>
                <span className="meta">記録 ${p.sessions.length} / 目標 ${p.presets.length}</span>
              </div>
            `
          )}
        </div>
      </div>

      ${activePatient &&
      html`
        <div className="card">
          <h3>保存した目標</h3>
          <div className="list">
            ${activePatient.presets.length === 0 &&
            html`<div className="muted small">保存された目標はありません。</div>`}
            ${activePatient.presets.map(
              (pr) => html`
                <div key=${pr.id} className="preset">
                  <div>
                    <div>${pr.name}</div>
                    <div className="muted small">${store.formatDate(pr.createdAt)}</div>
                  </div>
                  <div className="row">
                    <button className="ghost small" onClick=${() => loadPreset(pr)}>読込</button>
                    ${mode === "st" &&
                    html`<button
                      className="ghost small danger"
                      onClick=${() => store.deletePreset(activePatient.id, pr.id)}
                    >
                      削除
                    </button>`}
                  </div>
                </div>
              `
            )}
          </div>
        </div>

        <div className="card">
          <h3>練習の記録</h3>
          <div className="list">
            ${activePatient.sessions.length === 0 &&
            html`<div className="muted small">記録はまだありません。</div>`}
            ${activePatient.sessions.slice(0, 8).map(
              (s) => html`
                <div key=${s.id} className="row between small">
                  <span className="muted">${store.formatDate(s.date)}</span>
                  <span>到達 <b>${s.reps}</b> 回 / ${Math.round(s.durationSec)}秒</span>
                </div>
              `
            )}
          </div>
        </div>
      `}
    </div>
  `;
}

// ---- 右：ST 指導ツール（カードを分割してタブ化にも使えるようにする）---------
function DrawCard(props) {
  const {
    tool, setTool, stampType, setStampType, color, setColor,
    penSize, setPenSize, stampSize, setStampSize, engine,
  } = props;
  return html`
    <div className="card">
      <h3>目標を描く</h3>
      <div className="grid-tools">
        <button className=${tool === "pen" ? "active" : ""} onClick=${() => setTool("pen")}>✏️ ペン</button>
        <button className=${tool === "stamp" ? "active" : ""} onClick=${() => setTool("stamp")}>⭐ スタンプ</button>
        <button className=${tool === "erase" ? "active" : ""} onClick=${() => setTool("erase")}>🩹 消しゴム</button>
        <button onClick=${() => engine().undo()}>↩︎ 一つ戻す</button>
      </div>
      <div className="swatches" style=${{ marginTop: 10 }}>
        ${COLORS.map(
          (c) => html`<div key=${c} className=${"swatch" + (c === color ? " active" : "")}
            style=${{ background: c }} onClick=${() => setColor(c)}></div>`
        )}
      </div>
      ${tool === "pen" &&
      html`<label className="field" style=${{ marginTop: 10 }}>
        線の太さ ${penSize}px
        <input type="range" min="2" max="24" value=${penSize} onChange=${(e) => setPenSize(+e.target.value)} />
      </label>`}
      ${tool === "stamp" &&
      html`<div style=${{ marginTop: 10 }}>
        <label className="field">スタンプ
          <select value=${stampType} onChange=${(e) => setStampType(e.target.value)}>
            ${STAMP_TYPES.map((s) => html`<option key=${s.type} value=${s.type}>${s.label}</option>`)}
          </select>
        </label>
        <label className="field" style=${{ marginTop: 8 }}>大きさ ${stampSize}px
          <input type="range" min="30" max="240" value=${stampSize} onChange=${(e) => setStampSize(+e.target.value)} />
        </label>
      </div>`}
      <div className="row" style=${{ marginTop: 10 }}>
        <button className="ghost small" onClick=${() => engine().clearOverlays()}>すべて消去</button>
      </div>
    </div>
  `;
}

function ShadowCard(props) {
  const { settings, setSettings, metrics, hasShadow, captureShadow, clearShadow } = props;
  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));
  return html`
    <div className="card">
      <h3>
        シャドウ目標（目標の口形）
        ${hasShadow &&
        html`<span className="badge" style=${{ marginLeft: 8, ...(metrics.shadowMatch ? reachedStyle : {}) }}>
          ${metrics.shadowMatch ? "ぴったり" : "ずれ"}
        </span>`}
      </h3>
      <p className="hint">
        目標の形になった瞬間に撮影。半透明で重なり、近づくと緑枠で「ぴったり！」と知らせます。
      </p>
      <div className="row wrap">
        <button className="primary" onClick=${captureShadow}>📸 今の口元を目標に</button>
        <button className="ghost" onClick=${clearShadow} disabled=${!hasShadow}>消去</button>
      </div>
      <label className="field" style=${{ marginTop: 10 }}>
        目標の濃さ ${Math.round(settings.shadowAlpha * 100)}%
        <input type="range" min="10" max="80" value=${Math.round(settings.shadowAlpha * 100)}
          onChange=${(e) => set({ shadowAlpha: +e.target.value / 100 })} />
      </label>
    </div>
  `;
}

function TargetCard(props) {
  const {
    metrics, openTarget, setOpenTarget, setOpenFromCurrent,
    spreadTarget, setSpreadTarget, setSpreadFromCurrent,
  } = props;
  return html`
    <div className="card">
      <h3>運動の目標（あ＝縦 / い＝横）</h3>
      <p className="hint">
        目標の形にして「目標に」を押すと設定。縦・横は別々、両方設定時は同時達成で1回。
      </p>
      <div style=${{ marginTop: 6 }}>
        <div className="row between small"><span>あ（縦の開き）</span>
          <span className="muted">今: ${mmText(metrics.openness, metrics.mmPerRel)} / 目標: ${mmText(openTarget, metrics.mmPerRel)}</span>
        </div>
        <${Meter} value=${metrics.openness} target=${openTarget} scale=${OPEN_SCALE} reached=${metrics.reachedOpen} />
        <div className="row wrap" style=${{ marginTop: 6 }}>
          <button onClick=${setOpenFromCurrent}>今の縦を目標に</button>
          <button className="ghost" onClick=${() => setOpenTarget(null)} disabled=${openTarget == null}>解除</button>
        </div>
      </div>
      <div style=${{ marginTop: 12 }}>
        <div className="row between small"><span>い（横の広がり）</span>
          <span className="muted">今: ${mmText(metrics.spread, metrics.mmPerRel)} / 目標: ${mmText(spreadTarget, metrics.mmPerRel)}</span>
        </div>
        <${Meter} value=${metrics.spread} target=${spreadTarget} scale=${SPREAD_SCALE} reached=${metrics.reachedSpread} />
        <div className="row wrap" style=${{ marginTop: 6 }}>
          <button onClick=${setSpreadFromCurrent}>今の横を目標に</button>
          <button className="ghost" onClick=${() => setSpreadTarget(null)} disabled=${spreadTarget == null}>解除</button>
        </div>
      </div>
      <p className="hint" style=${{ marginTop: 8 }}>
        mm は<b>概算（推定）</b>。正面で計測すると精度が上がります。
      </p>
    </div>
  `;
}

function ViewCard(props) {
  const { settings, setSettings, startCalib, calib } = props;
  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));
  const nudge = (dx, dy) => set({ lmOffX: clampNum((settings.lmOffX || 0) + dx, -120, 120), lmOffY: clampNum((settings.lmOffY || 0) + dy, -120, 120) });
  return html`
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

      <div style=${{ marginTop: 12 }}>
        <div className="row between small">
          <span>点・輪郭の位置合わせ</span>
          <span className="muted">X ${Math.round(settings.lmOffX || 0)} / Y ${Math.round(settings.lmOffY || 0)}px</span>
        </div>
        <button className=${"primary" + (calib ? " active" : "")} style=${{ width: "100%", marginTop: 8 }}
          onClick=${startCalib}>
          ${calib ? (calib === "L" ? "左の口角をタップ…" : "右の口角をタップ…") : "🎯 口角タップで位置合わせ"}
        </button>
        <p className="hint">
          画面の自分の<b>左→右の口角</b>を順にタップすると点・輪郭が合います。
        </p>
        <div className="row between small" style=${{ marginTop: 6 }}>
          <span className="muted">手動微調整</span>
          <button className="ghost small" onClick=${() => set({ lmOffX: 0, lmOffY: 0 })}>リセット</button>
        </div>
        <div className="nudge">
          <button onClick=${() => nudge(0, -3)}>▲</button>
          <div className="row" style=${{ gap: 6 }}>
            <button onClick=${() => nudge(-3, 0)}>◀</button>
            <button onClick=${() => nudge(3, 0)}>▶</button>
          </div>
          <button onClick=${() => nudge(0, 3)}>▼</button>
        </div>
      </div>
    </div>
  `;
}

function SaveCard(props) {
  const { savePreset, hasPatient } = props;
  const [presetName, setPresetName] = useState("");
  return html`
    <div className="card">
      <h3>この目標を保存</h3>
      <div className="row">
        <input placeholder="目標名 例: 口角を上げる" value=${presetName}
          onChange=${(e) => setPresetName(e.target.value)} style=${{ flex: 1 }} />
        <button className="primary" disabled=${!hasPatient}
          onClick=${() => { savePreset(presetName || "目標"); setPresetName(""); }}>保存</button>
      </div>
      ${!hasPatient && html`<p className="hint">保存には患者（管理番号）の選択が必要です。</p>`}
    </div>
  `;
}

function ToolPanel(props) {
  return html`
    <div className="side right">
      ${SHOW_DRAW && html`<${DrawCard} ...${props} />`}
      <${TargetCard} ...${props} />
      <${ShadowCard} ...${props} />
      <${ViewCard} ...${props} />
      <${SaveCard} ...${props} />
    </div>
  `;
}

// ---- 右：自主練習パネル ----------------------------------------------------
function PracticePanel({ metrics, openTarget, spreadTarget, startSession, endSession, hasPatient, sessionActive }) {
  const noTarget = openTarget == null && spreadTarget == null;
  return html`
    <div className="side right">
      ${metrics.shadowMatch &&
      html`<div className="match-banner">✓ ぴったり！</div>`}

      <div className="card">
        <h3>口の形</h3>

        <div className="row between small"><span>あ（縦の開き）</span>
          ${openTarget != null &&
          html`<span className=${"badge"} style=${metrics.reachedOpen ? reachedStyle : {}}>${metrics.reachedOpen ? "到達" : "もう少し"}</span>`}
        </div>
        <${Meter} value=${metrics.openness} target=${openTarget} scale=${OPEN_SCALE} reached=${metrics.reachedOpen} />
        <div className="row between small muted" style=${{ marginTop: 4 }}>
          <span>今: ${mmText(metrics.openness, metrics.mmPerRel)}</span>
          <span>目標: ${mmText(openTarget, metrics.mmPerRel)}</span>
        </div>

        <div className="row between small" style=${{ marginTop: 12 }}><span>い（横の広がり）</span>
          ${spreadTarget != null &&
          html`<span className=${"badge"} style=${metrics.reachedSpread ? reachedStyle : {}}>${metrics.reachedSpread ? "到達" : "もう少し"}</span>`}
        </div>
        <${Meter} value=${metrics.spread} target=${spreadTarget} scale=${SPREAD_SCALE} reached=${metrics.reachedSpread} />
        <div className="row between small muted" style=${{ marginTop: 4 }}>
          <span>今: ${mmText(metrics.spread, metrics.mmPerRel)}</span>
          <span>目標: ${mmText(spreadTarget, metrics.mmPerRel)}</span>
        </div>

        ${noTarget &&
        html`<p className="hint" style=${{ marginTop: 10 }}>
          目標が未設定です。ST指導モードで目標を設定するか、保存した目標を読み込んでください。
        </p>`}
        <p className="hint" style=${{ marginTop: 8 }}>mm は概算（推定値・平均的な目の寸法を基準）です。</p>
      </div>

      <div className="card" style=${{ textAlign: "center" }}>
        <h3>到達回数</h3>
        <div className="rep-count">${metrics.reps}</div>
        <p className="hint">
          ${openTarget != null && spreadTarget != null
            ? "縦・横の両方の目標に達するたびにカウントされます。"
            : "目標の形まで動かすたびにカウントされます。"}
        </p>
      </div>

      <div className="card">
        <h3>セッション</h3>
        ${!sessionActive
          ? html`<button className="primary" style=${{ width: "100%" }} onClick=${startSession}>
              ▶ 練習をはじめる
            </button>`
          : html`<button className="primary" style=${{ width: "100%" }} onClick=${() => endSession("")} disabled=${!hasPatient}>
              ■ 終了して記録する
            </button>`}
        ${!hasPatient &&
        html`<p className="hint">記録には患者（管理番号）の選択が必要です。練習だけならそのまま行えます。</p>`}
      </div>

      <div className="card">
        <p className="hint">
          画面に映る自分の口元と、半透明の目標（シャドウ）や描かれた目印が
          重なるように動かしましょう。鏡を見ながら練習することで運動が
          イメージしやすくなります。
        </p>
      </div>
    </div>
  `;
}
