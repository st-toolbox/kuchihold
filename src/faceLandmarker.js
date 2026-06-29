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
  if (!cl || !cr || !ti || !bi) return null;

  // すべて正規化座標 [0,1]（video の表示サイズに対する割合）
  const centerX = (cl.x + cr.x) / 2;
  const centerY = (cl.y + cr.y) / 2;
  const dx = cr.x - cl.x;
  const dy = cr.y - cl.y;
  const width = Math.hypot(dx, dy); // 口幅（正規化）
  const angle = Math.atan2(dy, dx); // 顔の傾き（ラジアン）

  // 開口度：内側上下唇の距離を口幅で正規化（顔の大きさに依存しない指標）
  const openRaw = Math.hypot(ti.x - bi.x, ti.y - bi.y);
  const openness = width > 0 ? openRaw / width : 0;

  return { centerX, centerY, width, angle, openness };
}
