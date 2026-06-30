// 舌の状態を「見本登録方式」で判定する分類器。
// MobileNet（特徴抽出）＋ KNN分類器（その場学習）を使う。
// ライブラリ（TensorFlow.js / mobilenet / knn-classifier）は使用時に動的読込。
// すべて端末内・サーバ送信なし。

const LIBS = [
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js",
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/knn-classifier@1.2.6/dist/knn-classifier.min.js",
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js",
];

let mobilenetModel = null;
let knn = null;
let loadingPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("読み込みに失敗: " + src));
    document.head.appendChild(s);
  });
}

async function ensureLibs() {
  if (window.tf && window.mobilenet && window.knnClassifier) return;
  for (const src of LIBS) {
    // 既に読み込み済みのものはスキップ
    if (
      (src.includes("tfjs") && window.tf) ||
      (src.includes("knn") && window.knnClassifier) ||
      (src.includes("mobilenet") && window.mobilenet)
    )
      continue;
    await loadScript(src);
  }
}

export function tongueReady() {
  return !!(mobilenetModel && knn);
}

export function loadTongue() {
  if (mobilenetModel && knn) return Promise.resolve();
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    await ensureLibs();
    if (!window.tf || !window.mobilenet || !window.knnClassifier)
      throw new Error("AIライブラリの読み込みに失敗しました（ネットワークをご確認ください）。");
    knn = window.knnClassifier.create();
    // alpha 0.5 / version 2：軽量モデルでモバイルでも動かしやすい
    mobilenetModel = await window.mobilenet.load({ version: 2, alpha: 0.5 });
  })().catch((e) => {
    loadingPromise = null;
    throw e;
  });
  return loadingPromise;
}

export function addTongueExample(canvas, classId) {
  if (!mobilenetModel || !knn || !canvas) return;
  const logits = mobilenetModel.infer(canvas, true);
  knn.addExample(logits, classId);
  logits.dispose();
}

export async function classifyTongue(canvas) {
  if (!mobilenetModel || !knn || !canvas) return null;
  const counts = knn.getClassExampleCount();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < 1) return null;
  const k = Math.max(1, Math.min(5, total));
  const logits = mobilenetModel.infer(canvas, true);
  try {
    return await knn.predictClass(logits, k); // {label, confidences}
  } finally {
    logits.dispose();
  }
}

export function tongueCounts() {
  return knn ? knn.getClassExampleCount() : {};
}

export function clearTongueClass(classId) {
  try {
    knn && knn.clearClass(classId);
  } catch {
    /* 例が無いクラスは無視 */
  }
}

export function resetTongue() {
  if (knn && window.knnClassifier) knn = window.knnClassifier.create();
}
