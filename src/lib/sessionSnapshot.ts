/**
 * 核验会话快照（IndexedDB）。
 *
 * 浏览器误刷新后，操作员不必重新选择两张原图、已查看方位也不丢失：
 * 每次基准或复检分析成功后，把原始 PNG 字节、当前对比阶段与选中方位写入快照；
 * 页面重载时读取快照，仍由现有 PNG 签名校验、原生解码、Canvas 取样与
 * analyzePixels / comparePixels 重建 Analysis、ZoneResult 与差异图，
 * 绝不直接信任快照内的旧判定。
 *
 * 快照带结构版本号：版本不识别或缺图等结构异常一律视为不可恢复，
 * 由调用方清理该快照并回退到正常上传流程。
 *
 * 照明校准状态不属于核验会话，不纳入本快照。
 */

import type { ZoneId } from './detect';

/** 快照结构版本；结构不兼容时递增，旧版本快照将被丢弃 */
export const SNAPSHOT_VERSION = 1;

/** IndexedDB 库名 / 对象仓库 / 记录键，均为本核验会话专用 */
const DB_NAME = 'register-mark-verifier';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';
const RECORD_KEY = 'verify-current';

/** 快照保存时的对比阶段：awaiting 仅有基准 / compared 已完成前后对比 */
export type SnapshotPhase = 'awaiting' | 'compared';

/** 落盘的快照结构（结构化克隆：ArrayBuffer 可直接存入 IndexedDB） */
export interface VerifySnapshot {
  /** 结构版本，不识别则拒绝恢复 */
  version: number;
  /** 基准图原始 PNG 字节 */
  baselinePng: ArrayBuffer;
  /** 复检图原始 PNG 字节；phase 为 awaiting 时为 null */
  recheckPng: ArrayBuffer | null;
  /** 保存时的对比阶段 */
  phase: SnapshotPhase;
  /** 选中的检测区方位；未选方位时为 null */
  selectedId: ZoneId | null;
}

/** 打开（必要时创建）核验会话数据库与对象仓库 */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexeddb-unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error instanceof Error ? request.error : new Error('indexeddb-open-failed'));
    // 浏览器禁用存储等场景下 open 可能直接阻塞失败
    request.onblocked = () => reject(new Error('indexeddb-blocked'));
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = run(tx.objectStore(STORE_NAME));
        request.onsuccess = () => {
          db.close();
          resolve(request.result);
        };
        request.onerror = () => {
          db.close();
          reject(request.error instanceof Error ? request.error : new Error('indexeddb-request-failed'));
        };
      }),
  );
}

/**
 * 写入会话快照。存储不可用（隐私模式 / 配额 / 被禁用）时拒绝，
 * 调用方应静默忽略——快照只用于刷新恢复，不能阻断既有核验流程。
 */
export function saveSnapshot(snapshot: VerifySnapshot): Promise<void> {
  return withStore('readwrite', (store) => store.put(snapshot, RECORD_KEY) as IDBRequest<IDBValidKey>)
    .then(() => undefined);
}

/** 读取会话快照；不存在时返回 null；存储不可用时拒绝 */
export function readSnapshot(): Promise<VerifySnapshot | null> {
  return withStore('readonly', (store) => store.get(RECORD_KEY) as IDBRequest<unknown>).then(
    (raw) => (raw === undefined ? null : (raw as VerifySnapshot)),
  );
}

/** 删除会话快照（操作员主动清除，或快照无法恢复时清理） */
export function clearSnapshot(): Promise<void> {
  return withStore('readwrite', (store) => store.delete(RECORD_KEY) as IDBRequest<undefined>).then(
    () => undefined,
  );
}

/**
 * 结构性校验：只确认快照具备恢复所需的字段与类型。
 * PNG 是否损坏、尺寸是否正确、能否解码取样，均在恢复流水线中重新验证，
 * 旧判定（命中数 / 合格与否）不参与校验也不会被复用。
 */
export function isStructurallyValidSnapshot(value: unknown): value is VerifySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<VerifySnapshot>;
  if (s.version !== SNAPSHOT_VERSION) return false;
  if (!(s.baselinePng instanceof ArrayBuffer) || s.baselinePng.byteLength === 0) return false;
  if (s.phase !== 'awaiting' && s.phase !== 'compared') return false;
  if (s.phase === 'compared' && (!(s.recheckPng instanceof ArrayBuffer) || s.recheckPng.byteLength === 0)) {
    return false;
  }
  if (s.phase === 'awaiting' && s.recheckPng !== null) return false;
  if (
    s.selectedId !== null &&
    s.selectedId !== 'top-left' &&
    s.selectedId !== 'top-right' &&
    s.selectedId !== 'bottom-left' &&
    s.selectedId !== 'bottom-right'
  ) {
    return false;
  }
  return true;
}
