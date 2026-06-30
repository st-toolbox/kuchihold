// 患者ごとの記録を localStorage に保存する軽量ストア。
//
// 個人情報を保持しない方針：氏名は扱わず「管理番号」で識別する。
// 目標プリセット（手書き／スタンプ／開口度目標／シャドウ画像）と
// 練習セッションのログを患者番号ごとに保存する。
//
// 注意：これはプロトタイプ用のローカル保存です。実運用では端末内の
// 暗号化保存やサーバ同期、バックアップ方針の検討が必要です（proposal.md 参照）。

const KEY = "kuchihold.v1";

/**
 * @typedef {Object} Preset   保存された目標一式
 * @property {string} id
 * @property {string} name
 * @property {Array}  strokes  手書きストローク（顔ロック正規化座標）
 * @property {Array}  stamps   スタンプ
 * @property {number|null} openTarget  開口度の目標値(0..1)
 * @property {string|null} shadow      シャドウ画像(dataURL) または null
 * @property {number} createdAt
 *
 * @typedef {Object} Session  練習セッションのログ
 * @property {string} id
 * @property {number} date
 * @property {number} durationSec
 * @property {number} reps     目標到達回数
 * @property {string} note
 *
 * @typedef {Object} Patient
 * @property {string} id        管理番号（文字列）
 * @property {string} note      自由メモ（個人情報は入れない運用）
 * @property {number} createdAt
 * @property {Preset[]} presets
 * @property {Session[]} sessions
 */

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { patients: [] };
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.patients)) return { patients: [] };
    return data;
  } catch {
    return { patients: [] };
  }
}

function save(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    // 容量超過（シャドウ画像が大きい等）を握りつぶさず通知する
    console.error("保存に失敗しました", e);
    throw e;
  }
}

let cache = load();
const listeners = new Set();

function emit() {
  cache = { ...cache };
  for (const fn of listeners) fn(cache);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return cache;
}

function uid(prefix) {
  // Date.now/Math.random に頼らずカウンタ＋時刻文字列で一意化
  uid._n = (uid._n || 0) + 1;
  return `${prefix}_${performance.now().toFixed(3).replace(".", "")}_${uid._n}`;
}

export function listPatients() {
  return [...cache.patients].sort((a, b) => a.id.localeCompare(b.id, "ja"));
}

export function getPatient(id) {
  return cache.patients.find((p) => p.id === id) || null;
}

export function addPatient(id, note = "") {
  const trimmed = String(id).trim();
  if (!trimmed) throw new Error("管理番号を入力してください");
  if (cache.patients.some((p) => p.id === trimmed))
    throw new Error("その管理番号は既に存在します");
  cache.patients.push({
    id: trimmed,
    note,
    createdAt: stamp(),
    presets: [],
    sessions: [],
  });
  save(cache);
  emit();
  return trimmed;
}

export function removePatient(id) {
  cache.patients = cache.patients.filter((p) => p.id !== id);
  save(cache);
  emit();
}

export function updatePatientNote(id, note) {
  const p = getPatient(id);
  if (!p) return;
  p.note = note;
  save(cache);
  emit();
}

export function savePreset(patientId, preset) {
  const p = getPatient(patientId);
  if (!p) throw new Error("患者が選択されていません");
  const record = {
    id: uid("preset"),
    name: preset.name || "目標",
    strokes: preset.strokes || [],
    stamps: preset.stamps || [],
    openTarget: preset.openTarget ?? null,
    spreadTarget: preset.spreadTarget ?? null,
    shadow: preset.shadow ?? null,
    shadowOpen: preset.shadowOpen ?? null,
    shadowSpread: preset.shadowSpread ?? null,
    createdAt: stamp(),
  };
  p.presets.unshift(record);
  save(cache);
  emit();
  return record;
}

export function deletePreset(patientId, presetId) {
  const p = getPatient(patientId);
  if (!p) return;
  p.presets = p.presets.filter((x) => x.id !== presetId);
  save(cache);
  emit();
}

export function logSession(patientId, session) {
  const p = getPatient(patientId);
  if (!p) return;
  p.sessions.unshift({
    id: uid("sess"),
    date: stamp(),
    durationSec: Math.round(session.durationSec || 0),
    reps: session.reps || 0,
    note: session.note || "",
  });
  // ログは直近 100 件に丸める
  p.sessions = p.sessions.slice(0, 100);
  save(cache);
  emit();
}

// 環境で Date.now が使えない場合に備えたタイムスタンプ。
// ブラウザ上では通常の Date が使える。
function stamp() {
  try {
    return new Date().getTime();
  } catch {
    return Math.round(performance.now());
  }
}

export function formatDate(ms) {
  try {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(
      d.getHours()
    )}:${p(d.getMinutes())}`;
  } catch {
    return "—";
  }
}
