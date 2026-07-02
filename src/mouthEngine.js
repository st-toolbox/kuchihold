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

import { createFaceLandmarker, detectMouth } from "./faceLandmarker.js?v=28";

const INTERNAL_W = 720;
const INTERNAL_H = 960; // 3:4 縦

// シャドウ「ぴったり」判定の許容差（相対値）。縦・横ともこの範囲内なら一致。
const MATCH_TOL_OPEN = 0.05;
const MATCH_TOL_SPREAD = 0.06;

const DEFAULTS = {
  mirror: true, // ミラーセラピー：左右反転
  level: false, // 傾き補正（口角を水平に）— 既定オフ
  zoom: 1.8, // クロップ幅 = 顔サイズ × zoom（大きいほど引き）
  smoothing: 0.6, // 固定の安定度。大きいほど静止時のジッターを抑える（動きの遅れは出にくい）
  shadowAlpha: 0.4,
  showLandmarks: true, // 口角の点・唇の輪郭線を表示
  lmOffX: 0, // 点・輪郭の手動ずれ補正（出力px）
  lmOffY: 0,
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

    // 解析と描画で同じフレームを使うためのバッファ（点・輪郭のズレ防止）
    this.frameCanvas = document.createElement("canvas");
    this.frameCtx = this.frameCanvas.getContext("2d");

    this.settings = { ...DEFAULTS };
    this.landmarker = null;
    this.stream = null;
    this.raf = 0;
    this.running = false;

    // 平滑化された顔ロック変換（source px / rad）
    this.sm = null; // {cx, cy, w, angle}
    this._filters = null; // One Euro Filter（cx,cy,w,angle）
    this.lips = null; // 最新フレームの唇輪郭・口角（描画用）
    this.lastFaceAt = 0;

    // オーバーレイ（INTERNAL_W×INTERNAL_H 座標系で保存）
    this.strokes = []; // {color,size,points:[{x,y}]}
    this.stamps = []; // {type,x,y,size,color}
    this.shadow = null; // {alpha, hasImage} / 画像は shadowCanvas に保持
    this.hasShadow = false;
    // シャドウ撮影時の口の形（縦・横）。現在の形がこれに近いと「ぴったり」と判定。
    this.shadowOpen = null;
    this.shadowSpread = null;
    this.shadowMatch = false;

    // 入力
    this.editable = false;
    this.tool = "pen"; // pen|erase|stamp
    this.stampType = "ring";
    this.color = "#ffd166";
    this.penSize = 7;
    this.stampSize = 90;
    this._drawing = null;

    // 口の形の指標・反復検出
    // openness = あ（縦の開き）、spread = い（横の広がり）。各々に目標を持てる。
    this.openTarget = null; // 0..1 or null（縦）
    this.spreadTarget = null; // 0..1 or null（横）
    this.openness = 0;
    this.spread = 0;
    this.baseOpen = null; // 安静時（戻り位置）の自動追従
    this.baseSpread = null;
    this.mmPerRel = 0; // 相対値1.0あたりの概算mm（片目幅32mm基準）
    this.reachedOpen = false;
    this.reachedSpread = false;
    this.reached = false; // 設定された目標が「すべて」到達
    this.reps = 0;
    this._openState = "closed";

    // 口角タップ位置合わせ
    this._calib = null; // {step, deltas}
    this.tapMarks = []; // タップ位置の一時表示（点線の丸）

    // 舌の到達目標点（描画用）
    this._showTonguePoints = false;

    // 舌リハ：目標点タッチ検知（各点の「基準色からの変化」）＋挺舌（AI判定）＋種目カウント
    this._tongueDetect = false;
    this._tongueExercise = null; // 'protrude'|'lr'|'ud'
    this.tongueReps = 0;
    this.tongueOut = 0; // 挺舌ブレンドシェイプ tongueOut（0..1、平滑化済み）
    this._touch = null; // {left,right,up,down: {base:{r,g,b}, on:bool}}
    this.tongueSig = {
      present: false,
      out: 0,
      touch: { left: false, right: false, up: false, down: false },
    };
    this._lrSide = 0;
    this._udSide = 0;
    this._protArm = true;
    this._tongueFrame = 0;

    // コールバック
    this.onMetrics = null; // ({openness, spread, reachedOpen, reachedSpread, reached, reps, shadowMatch, hasFace})
    this.onRep = null; // (reps)
    this.onError = null; // (Error)
    this.onCalibrate = null; // (dx, dy) 追加すべき補正量
    this.onCalibStep = null; // (step|null)

    this._bindPointer();
  }

  // ---- 起動 / 停止 ---------------------------------------------------------

  async start() {
    if (this.running) return;
    this.sm = null;
    this._filters = null;
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
  setSpreadTarget(v) {
    this.spreadTarget = v;
  }
  setShowTonguePoints(v) {
    this._showTonguePoints = !!v;
  }
  setTongueDetect(v) {
    this._tongueDetect = !!v;
    if (!v) {
      this._touch = null;
      this.tongueOut = 0;
      this.tongueSig = {
        present: false,
        out: 0,
        touch: { left: false, right: false, up: false, down: false },
      };
    }
  }
  setTongueExercise(ex) {
    if (ex !== this._tongueExercise) {
      this._tongueExercise = ex;
      this._resetTongueReps();
    }
  }
  _resetTongueReps() {
    this.tongueReps = 0;
    this._lrSide = 0;
    this._udSide = 0;
    this._protArm = true;
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
    this.shadowOpen = null;
    this.shadowSpread = null;
    this.shadowMatch = false;
  }

  /** 現在の口元（映像のみ・目標は含めない）をシャドウ目標として確定する */
  captureShadow() {
    const sc = this.shadowCanvas.getContext("2d");
    sc.clearRect(0, 0, INTERNAL_W, INTERNAL_H);
    this._drawVideoCrop(sc); // 映像クロップだけを焼き込む
    this.hasShadow = true;
    // 撮影時の口の形を記録し、後で「ぴったり」判定に使う
    this.shadowOpen = this.openness;
    this.shadowSpread = this.spread;
  }

  resetReps() {
    this.reps = 0;
    this._openState = "closed";
    this._resetTongueReps();
  }

  // 目印を含まない、安定化済みの口元クロップを返す（舌の判定用の入力画像）
  snapshotCrop() {
    if (!this.sm) return null;
    const c = this._cropCanvas || (this._cropCanvas = document.createElement("canvas"));
    c.width = INTERNAL_W;
    c.height = INTERNAL_H;
    const cx = c.getContext("2d");
    cx.clearRect(0, 0, INTERNAL_W, INTERNAL_H);
    this._drawVideoCrop(cx);
    return c;
  }

  // 口角タップ位置合わせ開始（左→右の順にタップしてもらう）
  startCalibration() {
    this._calib = { step: 0, deltas: [] };
    this.onCalibStep && this.onCalibStep(0);
  }

  cancelCalibration() {
    this._calib = null;
    this.onCalibStep && this.onCalibStep(null);
  }

  _handleCalibTap(p) {
    this.tapMarks.push({ x: p.x, y: p.y, t: performance.now() }); // タップ印
    if (!this.lips) return; // 顔が検出できている必要がある
    const corner = this._calib.step === 0 ? this.lips.cornerL : this.lips.cornerR;
    const [px, py] = this._project(corner.x, corner.y);
    this._calib.deltas.push([p.x - px, p.y - py]);
    this._calib.step += 1;
    if (this._calib.step >= 2) {
      const d = this._calib.deltas;
      const dx = (d[0][0] + d[1][0]) / 2;
      const dy = (d[0][1] + d[1][1]) / 2;
      this._calib = null;
      this.onCalibrate && this.onCalibrate(dx, dy);
      this.onCalibStep && this.onCalibStep(null);
    } else {
      this.onCalibStep && this.onCalibStep(this._calib.step);
    }
  }

  // ---- プリセット（保存／復元） -------------------------------------------

  getPreset(name) {
    return {
      name: name || "目標",
      strokes: JSON.parse(JSON.stringify(this.strokes)),
      stamps: JSON.parse(JSON.stringify(this.stamps)),
      openTarget: this.openTarget,
      spreadTarget: this.spreadTarget,
      shadow: this.hasShadow ? this.shadowCanvas.toDataURL("image/webp", 0.7) : null,
      shadowOpen: this.shadowOpen,
      shadowSpread: this.shadowSpread,
    };
  }

  loadPreset(preset) {
    this.strokes = JSON.parse(JSON.stringify(preset.strokes || []));
    this.stamps = JSON.parse(JSON.stringify(preset.stamps || []));
    this.openTarget = preset.openTarget ?? null;
    this.spreadTarget = preset.spreadTarget ?? null;
    this.hasShadow = false;
    this.shadowMatch = false;
    this.shadowOpen = preset.shadowOpen ?? null;
    this.shadowSpread = preset.shadowSpread ?? null;
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

    // 現フレームをバッファに固定。解析も描画もこの同じ画像を使うことで、
    // 映像と口角点・輪郭のズレ（検出と描画のフレーム差）をなくす。
    if (this.frameCanvas.width !== v.videoWidth) {
      this.frameCanvas.width = v.videoWidth;
      this.frameCanvas.height = v.videoHeight;
    }
    this.frameCtx.drawImage(v, 0, 0);

    const t = performance.now();
    let mouth = null;
    try {
      mouth = detectMouth(this.landmarker, this.frameCanvas, t);
    } catch {
      mouth = null;
    }

    let hasFace = false;
    if (mouth) {
      hasFace = true;
      this.lastFaceAt = t;
      this.lips = mouth.lips;
      this.mmPerRel = this.mmPerRel
        ? this.mmPerRel + (mouth.mmPerRel - this.mmPerRel) * 0.3
        : mouth.mmPerRel;
      // 挺舌スコア（AI判定）を平滑化
      this.tongueOut += ((mouth.tongueOut || 0) - this.tongueOut) * 0.4;
      this._updateTransform(mouth, v, t);
      this._updateMetrics(mouth.openness, mouth.spread);
    } else {
      this.lips = null;
      this.tongueOut *= 0.9;
    }

    // シャドウ一致判定：現在の口の形が撮影時の形に近いか
    this.shadowMatch =
      this.hasShadow &&
      hasFace &&
      this.shadowOpen != null &&
      Math.abs(this.openness - this.shadowOpen) <= MATCH_TOL_OPEN &&
      Math.abs(this.spread - this.shadowSpread) <= MATCH_TOL_SPREAD;

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, INTERNAL_W, INTERNAL_H);

    if (this.sm) {
      this._drawVideoCrop(ctx); // 安定化した口元（この時点では映像のみ）
      // 目標点タッチ検知（クリーンな映像に対して。2フレームに1回）
      if (this._tongueDetect && this.lips && this.lips.targets) {
        this._tongueFrame++;
        if (this._tongueFrame % 2 === 0) {
          this._updateTongueTouch();
          this._countTongue();
        }
      }
      if (this.hasShadow) {
        ctx.globalAlpha = this.settings.shadowAlpha;
        ctx.drawImage(this.shadowCanvas, 0, 0);
        ctx.globalAlpha = 1;
      }
      if (this.settings.showLandmarks) this._drawLandmarks(ctx); // 口角点・唇輪郭
      this._drawOverlays(ctx); // 手書き＆スタンプの目標
      if (this.shadowMatch) this._drawMatchFeedback(ctx); // ぴったり！
    } else {
      this._drawRawCover(ctx); // まだ顔ロック前：素の映像を表示
    }

    if (this.tapMarks.length) this._drawTapMarks(ctx, t); // タップ印

    if (this.onMetrics) {
      this.onMetrics({
        openness: this.openness,
        spread: this.spread,
        mmPerRel: this.mmPerRel,
        reachedOpen: this.reachedOpen,
        reachedSpread: this.reachedSpread,
        reached: this.reached,
        reps: this.reps,
        shadowMatch: this.shadowMatch,
        tongue: this.tongueSig,
        tongueReps: this.tongueReps,
        hasFace,
      });
    }
  };

  // 目標点タッチ検知：各目標点（口角の少し外・上唇の上・下唇の下）の小さなパッチの
  // 色を監視し、「基準色（触れていない時の色）から大きく変わり、かつ舌らしい色になった」
  // 瞬間を「舌先が届いた」と判定する。
  // 誤反応対策の要：AIの tongueOut（舌が出ている判定）をゲートにし、
  // 舌が出ている間だけタッチを有効化する。口唇の動きだけで唇が点の下に
  // 滑り込んでも、舌が出ていなければ反応しない。
  _updateTongueTouch() {
    const T = this.lips && this.lips.targets;
    if (!T) return;
    if (!this._touch) {
      this._touch = { left: {}, right: {}, up: {}, down: {} };
    }
    const gate = this.tongueOut > 0.1; // 「舌が出ている」ゲート
    const ctx = this.ctx;
    const R = 9; // 検知パッチの半径（出力px）
    let anyOn = false;
    for (const key of ["left", "right", "up", "down"]) {
      const st = this._touch[key];
      const [px, py] = this._project(T[key].x, T[key].y);
      const x0 = Math.round(px) - R;
      const y0 = Math.round(py) - R;
      if (x0 < 0 || y0 < 0 || x0 + 2 * R >= INTERNAL_W || y0 + 2 * R >= INTERNAL_H) {
        st.on = false;
        st.hold = 0;
        continue;
      }
      let data;
      try {
        data = ctx.getImageData(x0, y0, 2 * R, 2 * R).data;
      } catch {
        st.on = false;
        st.hold = 0;
        continue;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
      r /= n;
      g /= n;
      b /= n;
      if (!st.base) {
        st.base = { r, g, b };
        st.on = false;
        st.hold = 0;
        continue;
      }
      if (!gate) {
        // 舌が出ていない間：今そこに見えているもの（肌・唇）を「背景」として
        // 基準色をゆっくり更新。口すぼめ等で唇が点の下に来ても背景として学習される。
        st.base.r += (r - st.base.r) * 0.06;
        st.base.g += (g - st.base.g) * 0.06;
        st.base.b += (b - st.base.b) * 0.06;
        st.on = false;
        st.hold = 0;
        continue;
      }
      const dr = r - st.base.r;
      const dg = g - st.base.g;
      const db = b - st.base.b;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      const sum = r + g + b;
      // 舌らしさ：赤が優勢で、暗すぎ（口腔内の影）・明るすぎ（歯・照明）でない
      const tongueish = r - Math.max(g, b) > 4 && sum > 140 && sum < 720;
      // ヒステリシス：ONは大きな変化を要求、OFFは小さくなるまで維持（チャタリング防止）
      const raw = st.on ? dist > 22 && tongueish : dist > 40 && tongueish;
      // 持続条件：2回連続（約0.13秒）で確定。一瞬のノイズでは反応しない。
      st.hold = raw ? (st.hold || 0) + 1 : 0;
      st.on = st.on ? raw : st.hold >= 2;
      anyOn = anyOn || st.on;
    }
    this.tongueSig = {
      present: anyOn || gate,
      out: this.tongueOut,
      touch: {
        left: !!this._touch.left.on,
        right: !!this._touch.right.on,
        up: !!this._touch.up.on,
        down: !!this._touch.down.on,
      },
    };
  }

  // 次にタッチすべき目標点（脈動リングで示す）
  _nextTargets() {
    const s = new Set();
    if (this._tongueExercise === "lr") {
      if (this._lrSide !== -1) s.add("left");
      if (this._lrSide !== 1) s.add("right");
    } else if (this._tongueExercise === "ud") {
      if (this._udSide !== -1) s.add("up");
      if (this._udSide !== 1) s.add("down");
    }
    return s;
  }

  // 種目ごとの反復カウント（挺舌＝AI判定／左右・上下＝目標点タッチの交互）
  _countTongue() {
    const ex = this._tongueExercise;
    if (!ex) return;
    const t = this.tongueSig.touch || {};
    if (ex === "protrude") {
      // tongueOut（AIの舌突出スコア）で「出す→戻す」を1回と数える
      if (this.tongueOut > 0.5 && this._protArm) {
        this._protArm = false;
        this.tongueReps++;
        this.onRep && this.onRep(this.tongueReps);
      } else if (this.tongueOut < 0.25) {
        this._protArm = true;
      }
    } else if (ex === "lr") {
      // 左右の点へ交互に届いたときだけカウント
      if (t.left && this._lrSide !== -1) {
        this._lrSide = -1;
        this.tongueReps++;
        this.onRep && this.onRep(this.tongueReps);
      } else if (t.right && this._lrSide !== 1) {
        this._lrSide = 1;
        this.tongueReps++;
        this.onRep && this.onRep(this.tongueReps);
      }
    } else if (ex === "ud") {
      if (t.up && this._udSide !== -1) {
        this._udSide = -1;
        this.tongueReps++;
        this.onRep && this.onRep(this.tongueReps);
      } else if (t.down && this._udSide !== 1) {
        this._udSide = 1;
        this.tongueReps++;
        this.onRep && this.onRep(this.tongueReps);
      }
    }
  }

  _updateTransform(mouth, v, t) {
    const cx = mouth.centerX * v.videoWidth;
    const cy = mouth.centerY * v.videoHeight;
    // 拡大率の基準は「顔サイズ（目の間隔）」。口の開閉では変わらないので
    // 「い」「う」でズームが暴れない。
    const face = mouth.faceSize * v.videoWidth;
    const angle = mouth.angle;

    if (!this._filters) {
      const ref = Math.max(1, face);
      this._filters = {
        ref,
        cx: new OneEuroFilter(),
        cy: new OneEuroFilter(),
        face: new OneEuroFilter(),
        angle: new OneEuroFilter(),
      };
      this.sm = { cx, cy, face, angle };
    }

    // smoothing(0..1) を One Euro の minCutoff にマッピング。
    // 大きいほど minCutoff 小＝静止時の微振動を強く除去。
    // beta を高めに固定することで、動いている間は遅れずに即ロック（＝口元が固定）。
    const s = clamp(this.settings.smoothing, 0, 1);
    const minCutoff = 2.6 - 2.2 * s; // 0.4 .. 2.6 (Hz)
    const beta = 0.9;
    const ref = this._filters.ref;
    this._filters.cx.setParams(minCutoff, beta);
    this._filters.cy.setParams(minCutoff, beta);
    // 顔サイズは特に安定させたい（ズームの揺れを防ぐ）ので追従を弱めにする
    this._filters.face.setParams(Math.min(minCutoff, 1.0), 0.2);
    this._filters.angle.setParams(minCutoff, beta * 0.5);

    this.sm.cx = this._filters.cx.filter(cx / ref, t) * ref;
    this.sm.cy = this._filters.cy.filter(cy / ref, t) * ref;
    this.sm.face = this._filters.face.filter(face / ref, t) * ref;
    this.sm.angle = this._filters.angle.filter(angle, t);
  }

  _updateMetrics(openness, spread) {
    // 軽く平滑化
    this.openness += (openness - this.openness) * 0.5;
    this.spread += (spread - this.spread) * 0.5;
    const o = this.openness;
    const s = this.spread;

    // 安静値（戻り位置）を自動追従：低い値はすぐ追従、上昇はゆっくり。
    // → 各自・各軸の「楽な状態」を推定でき、戻り判定が正しく働く（特に「い」）。
    this.baseOpen =
      this.baseOpen == null ? o : o < this.baseOpen ? o : this.baseOpen + (o - this.baseOpen) * 0.002;
    this.baseSpread =
      this.baseSpread == null ? s : s < this.baseSpread ? s : this.baseSpread + (s - this.baseSpread) * 0.002;

    const To = this.openTarget;
    const Ts = this.spreadTarget;
    this.reachedOpen = To != null && o >= To;
    this.reachedSpread = Ts != null && s >= Ts;

    // 各軸の「戻り」しきい値＝安静値 ＋ 目標までの 40%。
    const relO = To != null ? this.baseOpen + 0.4 * (To - this.baseOpen) : null;
    const relS = Ts != null ? this.baseSpread + 0.4 * (Ts - this.baseSpread) : null;

    const anyTarget = To != null || Ts != null;
    const allReached =
      anyTarget && (To == null || o >= To) && (Ts == null || s >= Ts);
    // 「戻った」＝設定軸がすべて戻りしきい値以下
    const released =
      anyTarget && (To == null || o <= relO) && (Ts == null || s <= relS);

    this.reached = allReached;
    // 反復カウント：到達→戻り→到達 のたびに +1
    if (this._openState === "closed" && allReached) {
      this._openState = "open";
      this.reps += 1;
      this.onRep && this.onRep(this.reps);
    } else if (this._openState === "open" && released) {
      this._openState = "closed";
    }
  }

  // 安定化した口元クロップを ctx に描画（映像のみ）
  _drawVideoCrop(ctx) {
    const { mirror, level, zoom } = this.settings;
    const sm = this.sm;
    // クロップ幅 = 顔サイズ × zoom（口の動きに依存しない安定したズーム）
    const cropW = clamp(sm.face * zoom, 40, 100000);
    const scale = INTERNAL_W / cropW;

    ctx.save();
    ctx.translate(INTERNAL_W / 2, INTERNAL_H / 2);
    ctx.scale(mirror ? -scale : scale, scale);
    if (level) ctx.rotate(-sm.angle);
    ctx.translate(-sm.cx, -sm.cy);
    // 解析に使ったのと同じ固定フレームを描画（点・輪郭とズレない）
    ctx.drawImage(this.frameCanvas, 0, 0);
    ctx.restore();
  }

  // タップ位置に点線の丸を一瞬表示（広がりながらフェード）
  _drawTapMarks(ctx, now) {
    const LIFE = 700;
    this.tapMarks = this.tapMarks.filter((m) => now - m.t < LIFE);
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 3;
    for (const m of this.tapMarks) {
      const age = (now - m.t) / LIFE; // 0..1
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = "#ffe14d";
      ctx.beginPath();
      ctx.arc(m.x, m.y, 12 + age * 20, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // シャドウに「ぴったり」合った時のフィードバック（緑の枠）
  _drawMatchFeedback(ctx) {
    ctx.save();
    ctx.strokeStyle = "rgba(54, 198, 160, 0.95)";
    ctx.lineWidth = 12;
    ctx.strokeRect(6, 6, INTERNAL_W - 12, INTERNAL_H - 12);
    ctx.restore();
  }

  // 正規化ランドマーク座標 → 出力キャンバス座標（_drawVideoCrop と同じ変換）
  _project(nx, ny) {
    const v = this.video;
    const sm = this.sm;
    const { mirror, level, zoom } = this.settings;
    const cropW = clamp(sm.face * zoom, 40, 100000);
    const scale = INTERNAL_W / cropW;
    let dx = nx * v.videoWidth - sm.cx;
    let dy = ny * v.videoHeight - sm.cy;
    if (level) {
      const a = -sm.angle;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rx = dx * ca - dy * sa;
      const ry = dx * sa + dy * ca;
      dx = rx;
      dy = ry;
    }
    return [
      INTERNAL_W / 2 + (mirror ? -scale : scale) * dx + (this.settings.lmOffX || 0),
      INTERNAL_H / 2 + scale * dy + (this.settings.lmOffY || 0),
    ];
  }

  // 口唇の輪郭と、舌の到達目標点（黄＝口角、赤＝上下唇）を描画
  _drawLandmarks(ctx) {
    const L = this.lips;
    if (!L) return;
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(80, 230, 255, 0.95)"; // 細い水色の輪郭線
    this._strokeLoop(ctx, L.outer);
    this._strokeLoop(ctx, L.inner);

    const T = L.targets;
    if (T) {
      if (this._showTonguePoints) {
        // 舌リハ：到達目標点（左右＝水色、上下＝赤）。次の目標は脈動、タッチで緑に点灯。
        const touch = this._touch || {};
        const next = this._nextTargets();
        this._drawTargetPoint(ctx, T.left, "#4ea1ff", next.has("left"), touch.left && touch.left.on);
        this._drawTargetPoint(ctx, T.right, "#4ea1ff", next.has("right"), touch.right && touch.right.on);
        this._drawTargetPoint(ctx, T.up, "#ff5b6e", next.has("up"), touch.up && touch.up.on);
        this._drawTargetPoint(ctx, T.down, "#ff5b6e", next.has("down"), touch.down && touch.down.on);
      } else {
        // 口唇リハ：口角の黄色点
        this._drawTargetPoint(ctx, L.cornerL, "#ffe14d", false, false);
        this._drawTargetPoint(ctx, L.cornerR, "#ffe14d", false, false);
      }
    }
    ctx.restore();
  }

  _drawTargetPoint(ctx, p, color, active, hit) {
    const [x, y] = this._project(p.x, p.y);
    ctx.save();
    if (hit) {
      // 舌先が届いた：緑で大きく点灯
      ctx.fillStyle = "#36c6a0";
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, active ? 9 : 6, 0, Math.PI * 2);
    ctx.fill();
    if (active) {
      // 次の目標として強調（脈動するリング）
      const t = (performance.now() % 900) / 900;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 12 + t * 16, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _strokeLoop(ctx, pts) {
    if (!pts || pts.length < 2) return;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = this._project(pts[i].x, pts[i].y);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // 顔ロック前の素の映像（cover）
  _drawRawCover(ctx) {
    const v = this.video;
    if (!v.videoWidth) return;
    const s = Math.max(INTERNAL_W / v.videoWidth, INTERNAL_H / v.videoHeight);
    const dw = v.videoWidth * s;
    const dh = v.videoHeight * s;
    ctx.save();
    ctx.translate(INTERNAL_W / 2, INTERNAL_H / 2);
    ctx.scale(this.settings.mirror ? -1 : 1, 1);
    ctx.drawImage(this.frameCanvas, -dw / 2, -dh / 2, dw, dh);
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
      const p = toLocal(e);
      // 位置合わせ中はタップを補正に使う（描画より優先）
      if (this._calib) {
        e.preventDefault();
        this._handleCalibTap(p);
        return;
      }
      if (!this.editable) return;
      c.setPointerCapture(e.pointerId);
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

// ---- One Euro Filter -------------------------------------------------------
// 「動いている時は遅れずに追従（=口元が固定される）、静止時はジッターを除去」する
// 適応的ローパスフィルタ。EMA の固定平滑化と違い、動きの遅れと微振動を両立して抑える。
// 参考: Casiez et al. "1€ Filter" (2012)

class LowPassFilter {
  constructor() {
    this.initialized = false;
    this.y = 0;
  }
  filter(x, alpha) {
    if (!this.initialized) {
      this.y = x;
      this.initialized = true;
    } else {
      this.y = alpha * x + (1 - alpha) * this.y;
    }
    return this.y;
  }
}

class OneEuroFilter {
  constructor(minCutoff = 1.4, beta = 0.9, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPassFilter();
    this.dx = new LowPassFilter();
    this.lastTime = null;
    this.lastRaw = 0;
  }
  setParams(minCutoff, beta) {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }
  _alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    let dt;
    if (this.lastTime == null) dt = 1 / 60;
    else {
      dt = (t - this.lastTime) / 1000;
      if (!(dt > 0)) dt = 1 / 60;
    }
    this.lastTime = t;
    const dxRaw = this.x.initialized ? (x - this.lastRaw) / dt : 0;
    this.lastRaw = x;
    const edx = this.dx.filter(dxRaw, this._alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(x, this._alpha(cutoff, dt));
  }
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
