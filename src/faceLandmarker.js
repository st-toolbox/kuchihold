// MediaPipe FaceLandmarker の薄いラッパ。
// WASM とモデルファイルはブラウザから CDN / Google Storage に取得する。
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// 口唇まわりの代表ランドマーク（Face Landmarker 468/478点モデルの index）
export const LIP = {
  cornerL: 61, // 向かって左の口角
  cornerR: 291, // 向かって右の口角
  topOuter: 0, // 上唇の山（外側）
  bottomOuter: 17, // 下唇の底（外側）
  topInner: 13, // 上唇の内側
  bottomInner: 14, // 下唇の内側
};

// 顔の大きさの基準点（口の開閉では動かない＝拡大率を安定させるために使う）。
// 左右の目の外側の角の距離を「顔サイズ」として用いる。
export const EYE = {
  outerR: 33, // 向かって左（被験者の右目）目尻
  innerR: 133, // 被験者の右目 目頭
  outerL: 263, // 向かって右（被験者の左目）目尻
  innerL: 362, // 被験者の左目 目頭
};

// 概算 mm 換算用の解剖学的な基準値（平均）。
//  - 片目の幅（目頭〜目尻）≈ 28.5mm
//  - 左右の目頭間（内眼角間）≈ 32mm
// 距離が分からない単眼カメラでも、毎フレームこれらで校正して大まかな実寸を推定する。
// あくまで推定値（個人差・顔の向き・レンズ歪みで誤差あり）。
export const EYE_WIDTH_MM = 28.5;
export const INNER_CANTHAL_MM = 32;

// 唇の輪郭（Face Mesh の標準ループ）。外側＝唇の外縁、内側＝口の開口部。
const LIP_OUTER = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0,
  37, 39, 40, 185,
];
const LIP_INNER = [
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13,
  82, 81, 80, 191,
];

function loop(lm, idx) {
  const out = [];
  for (const i of idx) {
    const p = lm[i];
    if (p) out.push({ x: p.x, y: p.y });
  }
  return out;
}

let landmarkerPromise = null;

async function build(fileset, delegate) {
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    // tongueOut（舌の突出）ブレンドシェイプを挺舌の自動判定に使う
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  });
}

export function createFaceLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      try {
        // まず GPU。モバイル Safari 等で GPU デリゲートが使えない場合は CPU にフォールバック。
        return await build(fileset, "GPU");
      } catch (e) {
        console.warn("GPU デリゲートに失敗、CPU で再試行します", e);
        return await build(fileset, "CPU");
      }
    })().catch((err) => {
      // 失敗時は次回再試行できるようキャッシュを破棄
      landmarkerPromise = null;
      throw err;
    });
  }
  return landmarkerPromise;
}

/**
 * 1フレームを推論し、口元情報を返す。検出できなければ null。
 * @param {FaceLandmarker} landmarker
 * @param {HTMLVideoElement} video
 * @param {number} tMs  performance.now() のタイムスタンプ
 */
export function detectMouth(landmarker, video, tMs) {
  const res = landmarker.detectForVideo(video, tMs);
  const faces = res && res.faceLandmarks;
  if (!faces || faces.length === 0) return null;
  const lm = faces[0];

  const cl = lm[LIP.cornerL];
  const cr = lm[LIP.cornerR];
  const ti = lm[LIP.topInner];
  const bi = lm[LIP.bottomInner];
  const er = lm[EYE.outerR];
  const el = lm[EYE.outerL];
  const ir = lm[EYE.innerR];
  const il = lm[EYE.innerL];
  if (!cl || !cr || !ti || !bi || !er || !el || !ir || !il) return null;

  // すべて正規化座標 [0,1]（video の表示サイズに対する割合）
  const centerX = (cl.x + cr.x) / 2;
  const centerY = (cl.y + cr.y) / 2;

  // 顔サイズ＝左右の目の外側の距離。口の開閉で変わらないので拡大率の基準に最適。
  // （口幅を基準にすると「い」で広がり「う」で狭まり、ズームが暴れてしまう）
  const faceSize = Math.hypot(el.x - er.x, el.y - er.y) || 0.0001;

  // 傾きは目線の角度から（口の動きの影響を受けない）
  const angle = Math.atan2(el.y - er.y, el.x - er.x);

  // 開口度（あ＝縦の開き）：内側上下唇の距離を顔サイズで正規化
  const openRaw = Math.hypot(ti.x - bi.x, ti.y - bi.y);
  const openness = openRaw / faceSize;

  // 横の広がり（い＝口角を横に引く）：左右口角の距離を顔サイズで正規化。
  // 開閉とは独立して「い」の動きを評価できる。
  const spread = Math.hypot(cr.x - cl.x, cr.y - cl.y) / faceSize;

  // 概算 mm 換算係数：相対値1.0あたりの mm。
  // 「片目幅(28.5mm)」と「目頭間(32mm)」の2基準から mm/正規化単位 を求めて平均し、
  // 毎フレーム校正する（基準を2つにして検出ノイズ・顔の向きに頑健化）。
  const eyeWidth =
    (Math.hypot(er.x - ir.x, er.y - ir.y) +
      Math.hypot(el.x - il.x, el.y - il.y)) /
      2 || 0.0001;
  const innerCanthal = Math.hypot(ir.x - il.x, ir.y - il.y) || 0.0001;
  const px2mm =
    (EYE_WIDTH_MM / eyeWidth + INNER_CANTHAL_MM / innerCanthal) / 2;
  const mmPerRel = faceSize * px2mm;

  // 挺舌（舌の突出）：AIブレンドシェイプ tongueOut のスコア（0..1）
  let tongueOut = 0;
  const bs = res.faceBlendshapes && res.faceBlendshapes[0];
  if (bs && bs.categories) {
    for (const c of bs.categories) {
      if (c.categoryName === "tongueOut") {
        tongueOut = c.score;
        break;
      }
    }
  }

  // 舌の到達目標点。「舌先が点を越えたか」を色の変化で検知するため、
  // 左右は口角の少し外側（肌の上）、上は上唇の山の少し上、下は下唇の少し下に置く。
  // 肌の上に置くと「肌色→舌色」の変化が大きく、判定が安定する。
  const upTop = lm[0] || ti; // 上唇の山
  const upIn = lm[13] || ti; // 上唇内側
  const loOut = lm[17] || bi; // 下唇の底
  const upMid = { x: (upTop.x + upIn.x) / 2, y: (upTop.y + upIn.y) / 2 };
  const EXT_LR = 0.28;
  const targets = {
    left: { x: cl.x + (cl.x - centerX) * EXT_LR, y: cl.y + (cl.y - centerY) * EXT_LR },
    right: { x: cr.x + (cr.x - centerX) * EXT_LR, y: cr.y + (cr.y - centerY) * EXT_LR },
    up: { x: upMid.x + (upMid.x - centerX) * 0.15, y: upMid.y + (upMid.y - centerY) * 0.15 },
    down: {
      x: loOut.x + (loOut.x - centerX) * 0.6,
      y: loOut.y + (loOut.y - centerY) * 0.6,
    },
  };

  // 唇の輪郭と口角（描画用、すべて正規化座標）
  const lips = {
    outer: loop(lm, LIP_OUTER),
    inner: loop(lm, LIP_INNER),
    cornerL: { x: cl.x, y: cl.y },
    cornerR: { x: cr.x, y: cr.y },
    // 口の開口部の中央（内側上下唇の中点）。舌が出ているかの色判定に使う。
    mouthInner: { x: (ti.x + bi.x) / 2, y: (ti.y + bi.y) / 2 },
    targets,
  };

  return { centerX, centerY, faceSize, angle, openness, spread, mmPerRel, tongueOut, lips };
}
