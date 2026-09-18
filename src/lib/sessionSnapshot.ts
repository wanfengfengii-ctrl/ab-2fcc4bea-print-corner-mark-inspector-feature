/**
 * 套准角标核验会话快照（IndexedDB）。
 *
 * 工位核验常因浏览器误刷新中断：每次基准或复检分析成功后，页面把**原始 PNG 字节、
 * 当前对比阶段与选中方位**写入本快照；页面重新加载时读回快照，再重新走
 * PNG 签名校验 → 浏览器原生解码 → Canvas 取样 → 纯函数分析（analyzePixels /
 * comparePixels）重建 Analysis、ZoneResult 与差异图。
 *
 * 快照**不保存任何判定结果**，恢复时不直接信任旧判定；照明校准状态也不纳入快照。
 * 所有读写经同一个 Promise 队列串行化，避免连续保存 / 清除的事务乱序。
 */
import { hasPngSignature, ZONES, type ZoneId } from './detect';

/** 快照结构标识；不识别的格式一律视为损坏快照 */
export const SNAPSHOT_FORMAT = 'register-mark-verify-session';
/** 快照结构版本；未来不兼容演进时递增，旧版本恢复时降级而不猜测字段含义 */
export const SNAPSHOT_VERSION = 1;

export const SESSION_DB_NAME = 'register-mark-verifier';
export const SESSION_DB_VERSION = 1;
export const SESSION_STORE = 'verify-sessions';
export const SESSION_KEY = 'current';

/** 快照中的对比阶段：awaiting 已固定基准待复检 / compared 已完成复检对比 */
export type SavedComparePhase = 'awaiting' | 'compared';

/**
 * 落盘的核验会话快照。判定结果（Analysis / ZoneResult / Comparison）不在其中，
 * 恢复时由原始 PNG 重新解码、取样、分析得到。
 */
export interface VerifySnapshot {
  format: typeof SNAPSHOT_FORMAT;
  version: typeof SNAPSHOT_VERSION;
  /** 写入时间（毫秒），仅用于排查，恢复逻辑不依赖该值 */
  savedAt: number;
  /** 基准图原始 PNG 字节 */
  baselinePng: ArrayBuffer;
  baselineName: string;
  phase: SavedComparePhase;
  /** 刷新前选中的检测方位；未选中时为 null */
  selectedId: ZoneId | null;
  /** phase 为 compared 时必须存在复检图原始 PNG 字节 */
  recheckPng?: ArrayBuffer;
  recheckName?: string;
}

export type SnapshotLoadOutcome =
  | { outcome: 'ready'; snapshot: VerifySnapshot }
  /** 没有保存过会话（首次访问） */
  | { outcome: 'missing' }
  /** 浏览器存储不可用（如禁用 IndexedDB / 隐私模式写入被拒） */
  | { outcome: 'unavailable' }
  /** 快照结构不识别：缺图、版本不识别、字段类型错误等 */
  | { outcome: 'invalid' };

const ZONE_IDS: ReadonlySet<string> = new Set(ZONES.map((z) => z.id));

function isNonEmptyArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer && value.byteLength >= 8;
}

/** PNG 必须带完整 8 字节签名，否则属于损坏快照 */
function hasValidPngHead(buffer: ArrayBuffer): boolean {
  return hasPngSignature(new Uint8Array(buffer, 0, 8));
}

/**
 * 校验 IndexedDB 读回的原始记录是否为当前版本可识别的完整快照。
 * 纯函数（不触碰浏览器 API），任何字段不符都返回 null，由调用方清除并降级。
 */
export function validateSnapshot(raw: unknown): VerifySnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.format !== SNAPSHOT_FORMAT || record.version !== SNAPSHOT_VERSION) return null;
  if (record.phase !== 'awaiting' && record.phase !== 'compared') return null;
  if (
    record.selectedId !== null &&
    (typeof record.selectedId !== 'string' || !ZONE_IDS.has(record.selectedId))
  ) {
    return null;
  }
  if (!isNonEmptyArrayBuffer(record.baselinePng) || !hasValidPngHead(record.baselinePng)) {
    return null;
  }
  if (record.phase === 'compared') {
    if (!isNonEmptyArrayBuffer(record.recheckPng) || !hasValidPngHead(record.recheckPng)) {
      return null;
    }
  }

  const snapshot: VerifySnapshot = {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    savedAt: typeof record.savedAt === 'number' ? record.savedAt : 0,
    baselinePng: record.baselinePng,
    baselineName: typeof record.baselineName === 'string' ? record.baselineName : '',
    phase: record.phase,
    selectedId: record.selectedId as ZoneId | null,
  };
  if (record.phase === 'compared') {
    snapshot.recheckPng = record.recheckPng as ArrayBuffer;
    snapshot.recheckName = typeof record.recheckName === 'string' ? record.recheckName : '';
  }
  return snapshot;
}

function openSessionDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'));
    request.onblocked = () => reject(new Error('IndexedDB 被阻塞'));
  });
}

/**
 * 所有快照读写共用的串行队列：保存与清除可能由 React 副作用连续触发，
 * 事务按入队顺序提交，避免后写的删除 / 保存乱序。
 */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** 读取并校验当前会话快照；存储不可用或记录损坏时给出明确分类 */
export function loadSessionSnapshot(): Promise<SnapshotLoadOutcome> {
  return serialize(async (): Promise<SnapshotLoadOutcome> => {
    let db: IDBDatabase;
    try {
      db = await openSessionDatabase();
    } catch {
      return { outcome: 'unavailable' };
    }
    try {
      const raw = await new Promise<unknown>((resolve, reject) => {
        try {
          const tx = db.transaction(SESSION_STORE, 'readonly');
          const request = tx.objectStore(SESSION_STORE).get(SESSION_KEY);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        } catch (error) {
          reject(error);
        }
      });
      if (raw === undefined || raw === null) return { outcome: 'missing' };
      const snapshot = validateSnapshot(raw);
      return snapshot ? { outcome: 'ready', snapshot } : { outcome: 'invalid' };
    } catch {
      return { outcome: 'unavailable' };
    } finally {
      db.close();
    }
  });
}

/** 写入（覆盖）当前会话快照；存储不可用时返回 false，不影响内存中的核验流程 */
export function saveSessionSnapshot(snapshot: VerifySnapshot): Promise<boolean> {
  return serialize(async () => {
    let db: IDBDatabase;
    try {
      db = await openSessionDatabase();
    } catch {
      return false;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE, 'readwrite');
        tx.objectStore(SESSION_STORE).put(snapshot, SESSION_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return true;
    } catch {
      return false;
    } finally {
      db.close();
    }
  });
}

/** 删除当前会话快照；存储不可用或本无记录时静默结束 */
export function clearSessionSnapshot(): Promise<void> {
  return serialize(async () => {
    let db: IDBDatabase;
    try {
      db = await openSessionDatabase();
    } catch {
      return;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SESSION_STORE, 'readwrite');
        tx.objectStore(SESSION_STORE).delete(SESSION_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      // 清除失败不阻塞：后续正常上传会覆盖快照，缺失时读取也只会得到空记录
    } finally {
      db.close();
    }
  });
}
