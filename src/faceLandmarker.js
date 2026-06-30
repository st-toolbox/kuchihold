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
  outerR: 33, // 向かって左（被験者の右目）外側
  outerL: 263, // 向かって右（被験者の左目）外側
};

let landmarkerPromise = null;

async function build(fileset, delegate) {
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: false,
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
  if (!cl || !cr || !ti || !bi || !er || !el) return null;

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

  return { centerX, centerY, faceSize, angle, openness, spread };
}
