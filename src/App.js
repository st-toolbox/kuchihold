import React, { useState, useEffect, useRef, useCallback } from "react";
import { html } from "./html.js";
import { MouthEngine, STAMP_TYPES } from "./mouthEngine.js";
import * as store from "./store.js";

const COLORS = ["#ffd166", "#ef476f", "#06d6a0", "#4ea1ff", "#ffffff"];
const OPEN_SCALE = 0.6; // 開口度メーターの表示上限（顔サイズ基準の openness のおおよその最大）

export function App() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const metricsRef = useRef({ openness: 0, reached: false, reps: 0, hasFace: false });
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
  const [settings, setSettings] = useState({
    mirror: true,
    level: false,
    zoom: 1.8, // 顔サイズ基準。大きいほど引き（口元＋周辺が広く映る）
    smoothing: 0.6,
    shadowAlpha: 0.4,
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
    eng.setEditable(true);

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
  }, [tool, stampType, color, penSize, stampSize, openTarget]);

  // モードによって編集可否を切り替え
  useEffect(() => {
    engineRef.current && engineRef.current.setEditable(mode === "st");
  }, [mode]);

  // ---- 操作ハンドラ --------------------------------------------------------
  const eng = () => engineRef.current;

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

  // ---- 描画 ----------------------------------------------------------------
  return html`
    <div className="app">
      <div className="topbar">
        <div className="brand">kuchihold <small>口腔運動ミラートレーニング</small></div>
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

      <div className="layout">
        <${PatientPanel}
          patients=${patients}
          activeId=${activeId}
          setActiveId=${setActiveId}
          activePatient=${activePatient}
          loadPreset=${loadPreset}
          mode=${mode}
          setError=${setError}
        />

        <${Stage} canvasRef=${canvasRef} metrics=${metrics} openTarget=${openTarget} ready=${ready} />

        ${mode === "st"
          ? html`<${ToolPanel}
              tool=${tool} setTool=${setTool}
              stampType=${stampType} setStampType=${setStampType}
              color=${color} setColor=${setColor}
              penSize=${penSize} setPenSize=${setPenSize}
              stampSize=${stampSize} setStampSize=${setStampSize}
              settings=${settings} setSettings=${setSettings}
              openTarget=${openTarget} setOpenTarget=${setOpenTarget}
              setOpenFromCurrent=${setOpenFromCurrent}
              hasShadow=${hasShadow} captureShadow=${captureShadow} clearShadow=${clearShadow}
              engine=${eng}
              savePreset=${savePreset}
              hasPatient=${!!activeId}
            />`
          : html`<${PracticePanel}
              metrics=${metrics}
              openTarget=${openTarget}
              startSession=${startSession}
              endSession=${endSession}
              hasPatient=${!!activeId}
              sessionActive=${sessionStartRef.current != null}
            />`}
      </div>
    </div>
  `;
}

// ---- 中央ステージ ----------------------------------------------------------
function Stage({ canvasRef, metrics, openTarget, ready }) {
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
        <div className=${"stage-status" + (warn ? " warn" : "")}>${statusText}</div>
      </div>
    </div>
  `;
}

// ---- 開口度メーター --------------------------------------------------------
function OpenMeter({ openness, openTarget, reached }) {
  const pct = Math.min(100, (openness / OPEN_SCALE) * 100);
  const tPct = openTarget != null ? Math.min(100, (openTarget / OPEN_SCALE) * 100) : null;
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

// ---- 右：ST 指導ツール -----------------------------------------------------
function ToolPanel(props) {
  const {
    tool, setTool, stampType, setStampType, color, setColor,
    penSize, setPenSize, stampSize, setStampSize,
    settings, setSettings, openTarget, setOpenTarget, setOpenFromCurrent,
    hasShadow, captureShadow, clearShadow, engine, savePreset, hasPatient,
  } = props;
  const [presetName, setPresetName] = useState("");

  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));

  return html`
    <div className="side right">
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
            (c) => html`<div
              key=${c}
              className=${"swatch" + (c === color ? " active" : "")}
              style=${{ background: c }}
              onClick=${() => setColor(c)}
            ></div>`
          )}
        </div>
        ${tool === "pen" &&
        html`<label className="field" style=${{ marginTop: 10 }}>
          線の太さ ${penSize}px
          <input type="range" min="2" max="24" value=${penSize}
            onChange=${(e) => setPenSize(+e.target.value)} />
        </label>`}
        ${tool === "stamp" &&
        html`<div style=${{ marginTop: 10 }}>
          <label className="field">
            スタンプ
            <select value=${stampType} onChange=${(e) => setStampType(e.target.value)}>
              ${STAMP_TYPES.map((s) => html`<option key=${s.type} value=${s.type}>${s.label}</option>`)}
            </select>
          </label>
          <label className="field" style=${{ marginTop: 8 }}>
            大きさ ${stampSize}px
            <input type="range" min="30" max="240" value=${stampSize}
              onChange=${(e) => setStampSize(+e.target.value)} />
          </label>
        </div>`}
        <div className="row" style=${{ marginTop: 10 }}>
          <button className="ghost small" onClick=${() => engine().clearOverlays()}>すべて消去</button>
        </div>
      </div>

      <div className="card">
        <h3>シャドウ目標（目標の口形）</h3>
        <p className="hint">
          患者が目標の形まで口を動かせた瞬間に撮影すると、その口形が半透明で
          重なり、次回からの目標になります。
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

      <div className="card">
        <h3>開口度の目標</h3>
        <div className="row wrap">
          <button onClick=${setOpenFromCurrent}>今の開きを目標に</button>
          <button className="ghost" onClick=${() => setOpenTarget(null)} disabled=${openTarget == null}>解除</button>
        </div>
        <div className="muted small" style=${{ marginTop: 8 }}>
          現在の目標：${openTarget == null ? "なし" : openTarget.toFixed(2)}
        </div>
      </div>

      <div className="card">
        <h3>映像の安定化</h3>
        <div className="row wrap">
          <button className=${settings.mirror ? "active" : ""} onClick=${() => set({ mirror: !settings.mirror })}>
            鏡表示
          </button>
          <button className=${settings.level ? "active" : ""} onClick=${() => set({ level: !settings.level })}>
            傾き補正
          </button>
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
        <p className="hint">
          口元が画面の中央に固定され、手ブレや顔の移動があっても止まって見えます。
          細かく震える場合は数値を上げ、追従が遅いと感じる場合は下げてください。
        </p>
      </div>

      <div className="card">
        <h3>この目標を保存</h3>
        <div className="row">
          <input placeholder="目標名 例: 口角を上げる" value=${presetName}
            onChange=${(e) => setPresetName(e.target.value)} style=${{ flex: 1 }} />
          <button className="primary" disabled=${!hasPatient}
            onClick=${() => { savePreset(presetName || "目標"); setPresetName(""); }}>
            保存
          </button>
        </div>
        ${!hasPatient && html`<p className="hint">保存には患者（管理番号）の選択が必要です。</p>`}
      </div>
    </div>
  `;
}

// ---- 右：自主練習パネル ----------------------------------------------------
function PracticePanel({ metrics, openTarget, startSession, endSession, hasPatient, sessionActive }) {
  return html`
    <div className="side right">
      <div className="card">
        <h3>開き具合</h3>
        <${OpenMeter} openness=${metrics.openness} openTarget=${openTarget} reached=${metrics.reached} />
        <div className="row between" style=${{ marginTop: 10 }}>
          <span className="muted">目標到達</span>
          <span className=${"badge"} style=${metrics.reached ? { color: "#06231c", background: "#36c6a0", borderColor: "#36c6a0" } : {}}>
            ${metrics.reached ? "到達！" : "もう少し"}
          </span>
        </div>
      </div>

      <div className="card" style=${{ textAlign: "center" }}>
        <h3>到達回数</h3>
        <div className="rep-count">${metrics.reps}</div>
        <p className="hint">目標の開きまで動かすたびにカウントされます。</p>
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
