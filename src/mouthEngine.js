// 口元安定化トレーニング・エンジン（フレームワーク非依存）。
//
// 役割：
//  1. インカメラ映像を取得し、MediaPipe で口唇ランドマークを検出する。
//  2. 口元を「顔ロック座標系」に変換し、EMA 平滑化して拡大表示する。
//     → 顔や体が動いても表示はブレず、口元だけが大きく安定して映る。
//  3. その座標系の上に、手書き／スタンプの目標とシャドウ（目標の口形）を重ねる。
//     → 目標は「自分の顔に書き込まれている」ように追従する。
//  4. 開口度を計測し、目標到達（=反復）を検出してログに使えるようにする。
//
// 顔ロック座標系がこの設計の肝：クロップ枠は顔の位置・大きさ（・任意で傾き）に
// ロックするが、唇の開閉そのものはロックしない。だから口の動きは見えるのに
// 全体像はブレない。重ねた目標も同じ座標系なので自動的に顔へ追従する。

import { createFaceLandmarker, detectMouth } from "./faceLandmarker.js";

const INTERNAL_W = 720;
const INTERNAL_H = 960; // 3:4 縦

const DEFAULTS = {
  mirror: true, // ミラーセラピー：左右反転
  level: false, // 傾き補正（口角を水平に）— 既定オフ
  zoom: 2.6, // クロップ幅 = 口幅 × zoom（大きいほど引き）
  smoothing: 0.78, // 位置・大きさの平滑化（0..0.95、大きいほど安定）
  shadowAlpha: 0.4,
};

export class MouthEngine {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = INTERNAL_W;
    canvas.height = INTERNAL_H;
    this.ctx = canvas.getContext("2d");

    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;

    this.shadowCanvas = document.createElement("canvas");
    this.shadowCanvas.width = INTERNAL_W;
    this.shadowCanvas.height = INTERNAL_H;

    this.settings = { ...DEFAULTS };
    this.landmarker = null;
    this.stream = null;
    this.raf = 0;
    this.running = false;

    // 平滑化された顔ロック変換（source px / rad）
    this.sm = null; // {cx, cy, w, angle}
    this.lastFaceAt = 0;

    // オーバーレイ（INTERNAL_W×INTERNAL_H 座標系で保存）
    this.strokes = []; // {color,size,points:[{x,y}]}
    this.stamps = []; // {type,x,y,size,color}
    this.shadow = null; // {alpha, hasImage} / 画像は shadowCanvas に保持
    this.hasShadow = false;

    // 入力
    this.editable = false;
    this.tool = "pen"; // pen|erase|stamp
    this.stampType = "ring";
    this.color = "#ffd166";
    this.penSize = 7;
    this.stampSize = 90;
    this._drawing = null;

    // 開口度・反復検出
    this.openTarget = null; // 0..1 or null
    this.openness = 0;
    this.reached = false;
    this.reps = 0;
    this._openState = "closed";

    // コールバック
    this.onMetrics = null; // ({openness, reached, reps, hasFace})
    this.onRep = null; // (reps)
    this.onError = null; // (Error)

    this._bindPointer();
  }

  // ---- 起動 / 停止 ---------------------------------------------------------

  async start() {
    if (this.running) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      this.landmarker = await createFaceLandmarker();
      this.running = true;
      this._loop();
    } catch (err) {
      this.onError && this.onError(normalizeError(err));
      throw err;
    }
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  // ---- 設定 ---------------------------------------------------------------

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
  }
  setEditable(v) {
    this.editable = !!v;
  }
  setTool(t) {
    this.tool = t;
  }
  setStampType(t) {
    this.stampType = t;
  }
  setColor(c) {
    this.color = c;
  }
  setPenSize(n) {
    this.penSize = n;
  }
  setStampSize(n) {
    this.stampSize = n;
  }
  setOpenTarget(v) {
    this.openTarget = v;
  }

  // ---- オーバーレイ操作 ----------------------------------------------------

  undo() {
    // スタンプと手書きを混在で「最後の操作」順に戻すのは複雑なので、
    // ここではスタンプ→手書きの順で末尾を取り除く簡易版。
    if (this.stamps.length) this.stamps.pop();
    else if (this.strokes.length) this.strokes.pop();
  }

  clearOverlays() {
    this.strokes = [];
    this.stamps = [];
  }

  clearShadow() {
    this.hasShadow = false;
  }

  /** 現在の口元（映像のみ・目標は含めない）をシャドウ目標として確定する */
  captureShadow() {
    const sc = this.shadowCanvas.getContext("2d");
    sc.clearRect(0, 0, INTERNAL_W, INTERNAL_H);
    this._drawVideoCrop(sc); // 映像クロップだけを焼き込む
    this.hasShadow = true;
  }

  resetReps() {
    this.reps = 0;
    this._openState = "closed";
  }

  // ---- プリセット（保存／復元） -------------------------------------------

  getPreset(name) {
    return {
      name: name || "目標",
      strokes: JSON.parse(JSON.stringify(this.strokes)),
      stamps: JSON.parse(JSON.stringify(this.stamps)),
      openTarget: this.openTarget,
      shadow: this.hasShadow ? this.shadowCanvas.toDataURL("image/webp", 0.7) : null,
    };
  }

  loadPreset(preset) {
    this.strokes = JSON.parse(JSON.stringify(preset.strokes || []));
    this.stamps = JSON.parse(JSON.stringify(preset.stamps || []));
    this.openTarget = preset.openTarget ?? null;
    this.hasShadow = false;
    if (preset.shadow) {
      const img = new Image();
      img.onload = () => {
        const sc = this.shadowCanvas.getContext("2d");
        sc.clearRect(0, 0, INTERNAL_W, INTERNAL_H);
        sc.drawImage(img, 0, 0, INTERNAL_W, INTERNAL_H);
        this.hasShadow = true;
      };
      img.src = preset.shadow;
    }
  }

  // ---- 描画ループ ---------------------------------------------------------

  _loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this._loop);
    const v = this.video;
    if (!v.videoWidth) return;

    const t = performance.now();
    let mouth = null;
    try {
      mouth = detectMouth(this.landmarker, v, t);
    } catch {
      mouth = null;
    }

    let hasFace = false;
    if (mouth) {
      hasFace = true;
      this.lastFaceAt = t;
      this._updateTransform(mouth, v);
      this._updateOpenness(mouth.openness);
    }

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, INTERNAL_W, INTERNAL_H);

    if (this.sm) {
      this._drawVideoCrop(ctx); // 安定化した口元
      if (this.hasShadow) {
        ctx.globalAlpha = this.settings.shadowAlpha;
        ctx.drawImage(this.shadowCanvas, 0, 0);
        ctx.globalAlpha = 1;
      }
      this._drawOverlays(ctx); // 手書き＆スタンプの目標
    } else {
      this._drawRawCover(ctx); // まだ顔ロック前：素の映像を表示
    }

    if (this.onMetrics) {
      this.onMetrics({
        openness: this.openness,
        reached: this.reached,
        reps: this.reps,
        hasFace,
      });
    }
  };

  _updateTransform(mouth, v) {
    const cx = mouth.centerX * v.videoWidth;
    const cy = mouth.centerY * v.videoHeight;
    const w = mouth.width * v.videoWidth;
    const angle = mouth.angle;
    if (!this.sm) {
      this.sm = { cx, cy, w, angle };
      return;
    }
    const a = clamp(this.settings.smoothing, 0, 0.95);
    const k = 1 - a;
    this.sm.cx += (cx - this.sm.cx) * k;
    this.sm.cy += (cy - this.sm.cy) * k;
    this.sm.w += (w - this.sm.w) * k;
    // 角度は連続性のため差分を正規化
    let d = angle - this.sm.angle;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    this.sm.angle += d * k;
  }

  _updateOpenness(openness) {
    // 軽く平滑化
    this.openness += (openness - this.openness) * 0.5;
    const T = this.openTarget;
    if (T == null) {
      this.reached = false;
      return;
    }
    this.reached = this.openness >= T;
    // ヒステリシス付きで反復をカウント
    const exit = Math.max(0, T * 0.55);
    if (this._openState === "closed" && this.openness >= T) {
      this._openState = "open";
      this.reps += 1;
      this.onRep && this.onRep(this.reps);
    } else if (this._openState === "open" && this.openness <= exit) {
      this._openState = "closed";
    }
  }

  // 安定化した口元クロップを ctx に描画（映像のみ）
  _drawVideoCrop(ctx) {
    const { mirror, level, zoom } = this.settings;
    const sm = this.sm;
    const cropW = clamp(sm.w * zoom, 40, 100000);
    const scale = INTERNAL_W / cropW;

    ctx.save();
    ctx.translate(INTERNAL_W / 2, INTERNAL_H / 2);
    ctx.scale(mirror ? -scale : scale, scale);
    if (level) ctx.rotate(-sm.angle);
    ctx.translate(-sm.cx, -sm.cy);
    ctx.drawImage(this.video, 0, 0, this.video.videoWidth, this.video.videoHeight);
    ctx.restore();
  }

  // 顔ロック前の素の映像（cover）
  _drawRawCover(ctx) {
    const v = this.video;
    const s = Math.max(INTERNAL_W / v.videoWidth, INTERNAL_H / v.videoHeight);
    const dw = v.videoWidth * s;
    const dh = v.videoHeight * s;
    ctx.save();
    ctx.translate(INTERNAL_W / 2, INTERNAL_H / 2);
    ctx.scale(this.settings.mirror ? -1 : 1, 1);
    ctx.drawImage(v, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  _drawOverlays(ctx) {
    for (const st of this.strokes) {
      if (st.points.length < 1) continue;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(st.points[0].x, st.points[0].y);
      for (let i = 1; i < st.points.length; i++)
        ctx.lineTo(st.points[i].x, st.points[i].y);
      if (st.points.length === 1) ctx.lineTo(st.points[0].x + 0.1, st.points[0].y);
      ctx.stroke();
    }
    for (const s of this.stamps) drawStamp(ctx, s);
  }

  // ---- ポインタ入力（手書き／スタンプ） ------------------------------------

  _bindPointer() {
    const c = this.canvas;
    const toLocal = (e) => {
      const r = c.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / r.width) * INTERNAL_W,
        y: ((e.clientY - r.top) / r.height) * INTERNAL_H,
      };
    };
    c.addEventListener("pointerdown", (e) => {
      if (!this.editable) return;
      c.setPointerCapture(e.pointerId);
      const p = toLocal(e);
      if (this.tool === "pen") {
        this._drawing = { color: this.color, size: this.penSize, points: [p] };
        this.strokes.push(this._drawing);
      } else if (this.tool === "stamp") {
        this.stamps.push({
          type: this.stampType,
          x: p.x,
          y: p.y,
          size: this.stampSize,
          color: this.color,
        });
      } else if (this.tool === "erase") {
        this._eraseAt(p);
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (!this.editable || !this._drawing) return;
      this._drawing.points.push(toLocal(e));
    });
    const end = () => {
      this._drawing = null;
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
  }

  _eraseAt(p) {
    // スタンプ優先で近いものを削除、無ければ近いストロークを削除
    const hitR = 60;
    for (let i = this.stamps.length - 1; i >= 0; i--) {
      const s = this.stamps[i];
      if (Math.hypot(s.x - p.x, s.y - p.y) < Math.max(hitR, s.size / 2)) {
        this.stamps.splice(i, 1);
        return;
      }
    }
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < hitR)) {
        this.strokes.splice(i, 1);
        return;
      }
    }
  }
}

// ---- スタンプ描画 ----------------------------------------------------------

export const STAMP_TYPES = [
  { type: "ring", label: "○ 円" },
  { type: "dot", label: "● 点" },
  { type: "line", label: "― 目標ライン" },
  { type: "cross", label: "✕ 印" },
  { type: "up", label: "▲ ここまで" },
];

function drawStamp(ctx, s) {
  const r = s.size / 2;
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = Math.max(4, s.size * 0.09);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  switch (s.type) {
    case "dot":
      ctx.beginPath();
      ctx.arc(s.x, s.y, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "ring":
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case "line":
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y);
      ctx.lineTo(s.x + r, s.y);
      ctx.stroke();
      break;
    case "cross":
      ctx.beginPath();
      ctx.moveTo(s.x - r * 0.7, s.y - r * 0.7);
      ctx.lineTo(s.x + r * 0.7, s.y + r * 0.7);
      ctx.moveTo(s.x + r * 0.7, s.y - r * 0.7);
      ctx.lineTo(s.x - r * 0.7, s.y + r * 0.7);
      ctx.stroke();
      break;
    case "up":
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x + r * 0.7, s.y + r * 0.5);
      ctx.lineTo(s.x - r * 0.7, s.y + r * 0.5);
      ctx.closePath();
      ctx.stroke();
      break;
    default:
      break;
  }
  ctx.restore();
}

// ---- ユーティリティ --------------------------------------------------------

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function normalizeError(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return new Error(
      "カメラの使用が許可されませんでした。ブラウザのカメラ許可を確認してください。"
    );
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return new Error("利用できるカメラが見つかりませんでした。");
  if (name === "NotReadableError")
    return new Error("カメラを他のアプリが使用中の可能性があります。");
  return err instanceof Error ? err : new Error(String(err));
}

export { INTERNAL_W, INTERNAL_H };
