import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  analyzePixels,
  buildZoneDiffRgba,
  comparePixels,
  hasPngSignature,
  HIT_THRESHOLD,
  IMAGE_SIZE,
  ZONE_SIZE,
  type Analysis,
  type Comparison,
  type UploadStage,
  type Zone,
  type ZoneDiff,
  type ZoneId,
  type ZoneResult,
} from '../lib/detect';
import type { DiffClass } from '../lib/detect';
import {
  clearSessionSnapshot,
  loadSessionSnapshot,
  saveSessionSnapshot,
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  type SavedComparePhase,
  type VerifySnapshot,
} from '../lib/sessionSnapshot';

interface UploadError {
  title: string;
  detail: string;
}

/** 已成功分析的原图来源（原始 PNG 字节 + 文件名），用于写入会话快照 */
interface ImageSource {
  bytes: ArrayBuffer;
  name: string;
}

/**
 * 复检图处理流水线各阶段（与普通单图上传一致）：
 * signature（格式）→ decode（解码）→ size（尺寸）→ sample（取样）。
 * 复检失败时按阶段给出提示，且固定的基准图保持不变。
 */
type RecheckStage = UploadStage;

interface RecheckFailure extends UploadError {
  stage: RecheckStage;
}

/**
 * 叠加框按原始像素坐标等比映射到预览图，仅作可视化。
 * 采样始终发生在原始 1024×1024 像素上，预览缩放不影响采样坐标。
 */
function zoneBoxStyle(zone: Zone): CSSProperties {
  return {
    left: `${(zone.x0 / IMAGE_SIZE) * 100}%`,
    top: `${(zone.y0 / IMAGE_SIZE) * 100}%`,
    width: `${((zone.x1 - zone.x0 + 1) / IMAGE_SIZE) * 100}%`,
    height: `${((zone.y1 - zone.y0 + 1) / IMAGE_SIZE) * 100}%`,
  };
}

/**
 * 审阅裁片：把检测区 32×32 原始像素逐块复制到一张 32×32 画布，
 * 再由 CSS 以最近邻（image-rendering: pixelated）放大。
 * 数据直接取自上传时已采样的像素缓冲，切换选区不会重新解码文件。
 */
function ZoneCrop({ pixels, zone }: { pixels: Uint8ClampedArray; zone: Zone }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.createImageData(ZONE_SIZE, ZONE_SIZE);
    for (let y = 0; y < ZONE_SIZE; y += 1) {
      for (let x = 0; x < ZONE_SIZE; x += 1) {
        const src = ((zone.y0 + y) * IMAGE_SIZE + (zone.x0 + x)) * 4;
        const dst = (y * ZONE_SIZE + x) * 4;
        imageData.data[dst] = pixels[src];
        imageData.data[dst + 1] = pixels[src + 1];
        imageData.data[dst + 2] = pixels[src + 2];
        imageData.data[dst + 3] = pixels[src + 3];
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }, [pixels, zone]);

  return (
    <canvas
      ref={canvasRef}
      width={ZONE_SIZE}
      height={ZONE_SIZE}
      className="review-crop"
      data-testid="review-crop"
      aria-label={`${zone.label}检测区 32×32 原始像素裁片（最近邻放大）`}
    />
  );
}

/**
 * 复检差异图：把单区 32×32 分类结果（恢复命中 / 新增缺失等）写入画布，
 * 再以最近邻放大。分类由纯函数按两张图相同原始坐标逐像素计算。
 */
function DiffCrop({ diff }: { diff: ZoneDiff }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rgba = buildZoneDiffRgba(diff);
    ctx.putImageData(new ImageData(rgba, ZONE_SIZE, ZONE_SIZE), 0, 0);
  }, [diff]);

  return (
    <canvas
      ref={canvasRef}
      width={ZONE_SIZE}
      height={ZONE_SIZE}
      className="review-crop"
      data-testid="review-diff-crop"
      aria-label={`${diff.zone.label}检测区复检前后 32×32 差异图（绿色恢复命中、红色新增缺失，最近邻放大）`}
    />
  );
}

function GapReview({ result }: { result: ZoneResult }) {
  const { gapBounds, edgeGaps, misses } = result;
  return (
    <div className="review-detail">
      <div className="review-bounds" data-testid="review-gap-bounds">
        {gapBounds
          ? `缺口范围：x ${gapBounds.minX}–${gapBounds.maxX}，y ${gapBounds.minY}–${gapBounds.maxY}（未命中 ${misses} 像素）`
          : '缺口范围：无缺口（1024 个像素全部命中）'}
      </div>
      <ul className="edge-counts">
        <li data-testid="review-edge-top">上边缺口：{edgeGaps.top}</li>
        <li data-testid="review-edge-bottom">下边缺口：{edgeGaps.bottom}</li>
        <li data-testid="review-edge-left">左边缺口：{edgeGaps.left}</li>
        <li data-testid="review-edge-right">右边缺口：{edgeGaps.right}</li>
      </ul>
    </div>
  );
}

/** 复检差异图的分类图例 */
const DIFF_LEGEND: ReadonlyArray<{ cls: DiffClass; label: string; testid: string }> = [
  { cls: 'same-hit', label: '两次均命中', testid: 'diff-legend-same-hit' },
  { cls: 'same-miss', label: '两次均缺失', testid: 'diff-legend-same-miss' },
  { cls: 'recovered', label: '恢复命中', testid: 'diff-legend-recovered' },
  { cls: 'new-gap', label: '新增缺失', testid: 'diff-legend-new-gap' },
];

/**
 * 单张图像 → 原始 PNG 字节、已采样像素与分析结果。失败时返回带阶段标识的错误，
 * 普通单图上传与复检图上传共用同一套阶段语义。
 *
 * 普通上传传入 File；刷新后恢复传入由快照 PNG 字节重建的 Blob（type 固定为
 * image/png，已在读取快照时校验过签名，仍重新走完整解码流水线而非信任旧判定）。
 */
async function loadAnalyzedImage(
  source: Blob,
): Promise<
  | { ok: true; bytes: ArrayBuffer; pixels: Uint8ClampedArray; analysis: Analysis }
  | { ok: false; stage: UploadStage; error: UploadError }
> {
  // 1) 文件头校验：仅接受 PNG
  let head: Uint8Array;
  let bytes: ArrayBuffer;
  try {
    bytes = await source.arrayBuffer();
    head = new Uint8Array(bytes.slice(0, 8));
  } catch {
    return {
      ok: false,
      stage: 'signature',
      error: { title: '读取失败', detail: '无法读取所选文件的文件头，请重新选择图片。' },
    };
  }
  if (!hasPngSignature(head)) {
    return {
      ok: false,
      stage: 'signature',
      error: { title: '格式不支持', detail: '仅接受 PNG 文件，所选文件的文件头不是 PNG。' },
    };
  }

  // 2) 浏览器原生解码
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
  } catch {
    return {
      ok: false,
      stage: 'decode',
      error: { title: '解码失败', detail: '浏览器无法解码该 PNG，文件可能已损坏。' },
    };
  }

  // 3) 尺寸必须恰为 1024×1024
  if (bitmap.width !== IMAGE_SIZE || bitmap.height !== IMAGE_SIZE) {
    const { width, height } = bitmap;
    bitmap.close();
    return {
      ok: false,
      stage: 'size',
      error: {
        title: '尺寸不符',
        detail: `图像尺寸为 ${width}×${height}，要求恰为 ${IMAGE_SIZE}×${IMAGE_SIZE}。`,
      },
    };
  }

  // 4) 在原始分辨率上采样像素（不随预览缩放改变坐标）
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_SIZE;
  canvas.height = IMAGE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return {
      ok: false,
      stage: 'sample',
      error: { title: '环境异常', detail: '无法创建 Canvas 2D 上下文，无法读取原始像素。' },
    };
  }
  try {
    ctx.drawImage(bitmap, 0, 0);
  } catch {
    bitmap.close();
    return {
      ok: false,
      stage: 'sample',
      error: {
        title: '环境异常',
        detail: 'Canvas 像素采样失败，当前浏览器环境不允许绘制该图像。',
      },
    };
  }
  bitmap.close();
  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
  } catch {
    return {
      ok: false,
      stage: 'sample',
      error: {
        title: '环境异常',
        detail: 'Canvas 像素采样失败，当前浏览器环境不允许读取图像像素。',
      },
    };
  }

  return { ok: true, bytes, pixels, analysis: analyzePixels(pixels, IMAGE_SIZE, IMAGE_SIZE) };
}

/** 复检阶段的中文名称，用于失败提示指出原失败阶段 */
const STAGE_LABEL: Record<RecheckStage, string> = {
  signature: '格式校验',
  decode: '图像解码',
  size: '尺寸校验',
  sample: '像素取样',
};

/**
 * 套准角标核验页。
 *
 * 注意：本组件在切换到“扫描照明校准”工作台时保持挂载（仅隐藏），
 * 因此返回核验页时原上传图片、判定与已选证据仍保持可用。
 *
 * 复检对比流程：首张有效图完成检测后即固定为基准（idle）；操作员可上传一张
 * 同尺寸 PNG 作为复检图，页面先进入 awaiting（待复检）、成功后进入 compared
 * （完成对比）。基准始终保留；取消对比回到当前单图结果。
 */
export default function VerifyPage() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<UploadError | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [selectedId, setSelectedId] = useState<ZoneId | null>(null);
  // 当前分析所用的原始 RGBA 像素缓冲；切换审阅选区时直接复用，不重新解码
  const pixelsRef = useRef<Uint8ClampedArray | null>(null);
  // 当前基准图的原始 PNG 字节，用于写入会话快照（刷新后据此重建，不保存判定）
  const baselineSourceRef = useRef<ImageSource | null>(null);
  // 单调递增序号，防止连续上传时旧异步结果覆盖新状态
  const requestSeq = useRef(0);
  // 审阅区容器：键盘打开证据后把焦点移入，让键盘与读屏用户感知新内容出现
  const reviewRef = useRef<HTMLElement | null>(null);
  // 单调递增的聚焦请求序号；键盘激活选区时递增，渲染完成后由副作用执行聚焦
  const [reviewFocusTick, setReviewFocusTick] = useState(0);

  // 复检对比状态：idle 未启用（普通单图结果）/ awaiting 已固定基准、待复检 / compared 完成对比
  const [comparePhase, setComparePhase] = useState<'idle' | 'awaiting' | 'compared'>('idle');
  const [recheckPreviewUrl, setRecheckPreviewUrl] = useState<string | null>(null);
  const [recheckFileName, setRecheckFileName] = useState('');
  const [recheckError, setRecheckError] = useState<RecheckFailure | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  // 当前复检图的原始 PNG 字节；仅在 compared 阶段存在，与快照内容保持一致
  const recheckSourceRef = useRef<ImageSource | null>(null);
  const recheckSeq = useRef(0);

  // 刷新恢复：loading 读取并重建快照中 / ready 已就绪或确认无快照 / failed 快照损坏
  const [recovery, setRecovery] = useState<
    | { status: 'loading' }
    | { status: 'ready' }
    | { status: 'failed'; reason: string }
  >({ status: 'loading' });
  // 是否存在可由操作员主动删除的已保存会话快照（控制“清除已保存会话”入口）
  const [hasSavedSession, setHasSavedSession] = useState(false);
  // 快照恢复完成时置位：恢复本身不重写快照（内容一致，避免一次无谓的大图写入）
  const skipNextPersistRef = useRef(false);
  // 快照保存纪元：清除 / 替换基准时递增，使在途的旧保存结果不再回写界面状态
  const persistEpochRef = useRef(0);

  // 键盘打开/切换证据后，待审阅区渲染完成再把焦点移入（鼠标点选不抢焦点）
  useEffect(() => {
    if (reviewFocusTick === 0) return;
    reviewRef.current?.focus();
  }, [reviewFocusTick]);

  /**
   * 把当前基准（及 compared 阶段的复检图）原始 PNG、对比阶段与选中方位写入快照。
   * 判定结果不纳入快照；照明校准状态也不在其中。存储不可用时仅不显示清除入口，
   * 内存中的核验流程不受影响。
   */
  const persistSnapshot = (
    phase: SavedComparePhase,
    selection: ZoneId | null,
    baseline: ImageSource,
    recheck: ImageSource | null,
  ) => {
    const snapshot: VerifySnapshot = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      savedAt: Date.now(),
      baselinePng: baseline.bytes,
      baselineName: baseline.name,
      phase,
      selectedId: selection,
    };
    if (phase === 'compared' && recheck) {
      snapshot.recheckPng = recheck.bytes;
      snapshot.recheckName = recheck.name;
    }
    const epoch = persistEpochRef.current;
    void saveSessionSnapshot(snapshot).then((stored) => {
      // 等待写入期间若会话已被清除 / 替换，本次结果不再影响界面
      if (epoch === persistEpochRef.current) setHasSavedSession(stored);
    });
  };

  // 基准 / 复检 / 阶段 / 选中方位任一变化后，以渲染后的最终状态统一重写快照。
  // 这样保存的选中方位始终与当前阶段一致，且在恢复完成前不写入（快照即其来源）。
  useEffect(() => {
    if (recovery.status !== 'ready') return;
    if (!analysis || !baselineSourceRef.current) return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    if (comparePhase === 'idle') return;
    persistSnapshot(
      comparePhase === 'compared' ? 'compared' : 'awaiting',
      selectedId,
      baselineSourceRef.current,
      comparePhase === 'compared' ? recheckSourceRef.current : null,
    );
    // persistSnapshot 为组件内稳定闭包，依赖列表只保留参与快照的状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recovery.status, analysis, comparePhase, selectedId]);

  /** 页面加载：读取快照并经既有解码、取样、分析函数重建，不直接信任旧判定 */
  useEffect(() => {
    let cancelled = false;
    const restoreSeq = ++requestSeq.current;

    /** 重建流水线失败时给出带原失败阶段的说明（签名/解码/尺寸/取样） */
    const failRestore = (kind: '基准' | '复检', stage: UploadStage, detail: string) => {
      void clearSessionSnapshot().then(() => {
        if (cancelled) return;
        setHasSavedSession(false);
        setRecovery({
          status: 'failed',
          reason: `保存的${kind} PNG 在${STAGE_LABEL[stage]}阶段失败：${detail} 无法恢复该会话，已清除快照，请重新上传图片。`,
        });
      });
    };

    const applyRestored = async (snapshot: VerifySnapshot) => {
      // 基准图：重新走签名校验 → 原生解码 → 尺寸校验 → 取样 → analyzePixels
      const baselineResult = await loadAnalyzedImage(
        new Blob([snapshot.baselinePng], { type: 'image/png' }),
      );
      if (cancelled || restoreSeq !== requestSeq.current) return;
      if (!baselineResult.ok) {
        failRestore('基准', baselineResult.stage, baselineResult.error.detail);
        return;
      }

      // 复检图（如有）独立走同一套流水线；任一步失败都不展示旧对比判定
      let recheckPixels: Uint8ClampedArray | null = null;
      let recheckSource: ImageSource | null = null;
      if (snapshot.phase === 'compared') {
        const recheckResult = await loadAnalyzedImage(
          new Blob([snapshot.recheckPng!], { type: 'image/png' }),
        );
        if (cancelled || restoreSeq !== requestSeq.current) return;
        if (!recheckResult.ok) {
          failRestore('复检', recheckResult.stage, recheckResult.error.detail);
          return;
        }
        recheckPixels = recheckResult.pixels;
        recheckSource = { bytes: recheckResult.bytes, name: snapshot.recheckName ?? '' };
        recheckSourceRef.current = recheckSource;
      }

      // 全部重建成功后再一次性提交状态，避免“正在恢复”期间露出半成品结果
      const baselineBlob = new Blob([baselineResult.bytes], { type: 'image/png' });
      pixelsRef.current = baselineResult.pixels;
      baselineSourceRef.current = { bytes: baselineResult.bytes, name: snapshot.baselineName };
      setAnalysis(baselineResult.analysis);
      setFileName(snapshot.baselineName);
      setPreviewUrl(URL.createObjectURL(baselineBlob));
      setSelectedId(snapshot.selectedId);
      if (snapshot.phase === 'compared' && recheckPixels && recheckSource) {
        setComparison(comparePixels(baselineResult.pixels, recheckPixels, IMAGE_SIZE, IMAGE_SIZE));
        setComparePhase('compared');
        setRecheckFileName(recheckSource.name);
        setRecheckPreviewUrl(URL.createObjectURL(new Blob([recheckSource.bytes], { type: 'image/png' })));
      } else {
        setComparePhase('awaiting');
      }
      // 恢复写入的状态与快照内容一致：跳过紧接着的一次统一保存
      skipNextPersistRef.current = true;
      setHasSavedSession(true);
      setRecovery({ status: 'ready' });
    };

    void loadSessionSnapshot().then((loaded) => {
      if (cancelled) return;
      if (loaded.outcome === 'ready') {
        void applyRestored(loaded.snapshot);
      } else if (loaded.outcome === 'invalid') {
        // 快照结构不识别或缺图：清理后降级到初始上传态，并说明原因
        void clearSessionSnapshot().then(() => {
          if (!cancelled) {
            setHasSavedSession(false);
            setRecovery({
              status: 'failed',
              reason: '保存的会话快照已损坏或版本不识别，已清除。请重新上传图片。',
            });
          }
        });
      } else {
        // missing（首次访问）或 unavailable（浏览器禁用存储）：既有流程不受阻
        setHasSavedSession(false);
        setRecovery({ status: 'ready' });
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const clearResult = () => {
    setAnalysis(null);
    setError(null);
    setSelectedId(null);
    pixelsRef.current = null;
    baselineSourceRef.current = null;
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    // 普通上传会替换基准，任何进行中或已完成的复检对比一并清除
    recheckSeq.current += 1;
    setComparePhase('idle');
    setRecheckError(null);
    setComparison(null);
    setRecheckFileName('');
    recheckSourceRef.current = null;
    setRecheckPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
  };

  const handleFile = async (file: File) => {
    const seq = ++requestSeq.current;
    // 快照损坏降级后操作员重新上传：恢复阶段到此结束，后续按普通流程保存新会话
    setRecovery((current) => (current.status === 'failed' ? { status: 'ready' } : current));
    // 任何新上传都先清除旧结果（含上一次选区与裁片）
    clearResult();
    setFileName(file.name);
    // 普通上传会替换基准：旧快照先删除，新基准分析成功后再由统一副作用写入。
    // 上传失败时不重写，刷新后与当前界面一致回到初始上传态，而不是复活旧基准。
    persistEpochRef.current += 1;
    setHasSavedSession(false);
    void clearSessionSnapshot();

    const result = await loadAnalyzedImage(file);
    if (seq !== requestSeq.current) return;
    if (!result.ok) {
      setError(result.error);
      return;
    }
    pixelsRef.current = result.pixels;
    baselineSourceRef.current = { bytes: result.bytes, name: file.name };
    setAnalysis(result.analysis);
    // 首张有效图完成检测后固定为基准，进入待复检阶段
    setComparePhase('awaiting');
    setPreviewUrl(URL.createObjectURL(file));
    // 快照由状态变化后的统一副作用写入（只含基准 PNG、阶段、选中方位）
  };

  /** 复检图上传：基准保持不变，只更新复检状态；失败指出原失败阶段 */
  const handleRecheckFile = async (file: File) => {
    const seq = ++recheckSeq.current;
    setRecheckError(null);
    setRecheckFileName(file.name);
    setComparePhase('awaiting');
    setComparison(null);

    const result = await loadAnalyzedImage(file);
    if (seq !== recheckSeq.current) return;
    if (!result.ok) {
      const stageLabel = STAGE_LABEL[result.stage];
      // 旧对比已失效：释放上一张复检预览的对象 URL（失败期间不展示复检图）
      recheckSourceRef.current = null;
      setRecheckPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      setRecheckError({
        stage: result.stage,
        title: result.error.title,
        detail: `复检图在${stageLabel}阶段失败：${result.error.detail} 调整前基准图已保留，可重新选择复检图。`,
      });
      // 阶段已退回待复检，统一副作用会把快照回退为只含基准的版本，
      // 刷新后不会复活这张失败的复检图
      return;
    }
    if (!pixelsRef.current || !baselineSourceRef.current) return;
    recheckSourceRef.current = { bytes: result.bytes, name: file.name };
    setComparison(
      comparePixels(pixelsRef.current, result.pixels, IMAGE_SIZE, IMAGE_SIZE),
    );
    setRecheckPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    setComparePhase('compared');
    // 快照由阶段变化后的统一副作用写入（基准 + 复检两张原始 PNG、阶段、选中方位）
  };

  /** 取消对比：丢弃复检图，回到固定基准的当前单图结果 */
  const cancelComparison = () => {
    recheckSeq.current += 1;
    setComparison(null);
    setRecheckError(null);
    setRecheckFileName('');
    recheckSourceRef.current = null;
    setComparePhase(analysis ? 'awaiting' : 'idle');
    setRecheckPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    // 阶段变化后的统一副作用会把快照回退为只含基准的版本
  };

  /** 操作员主动删除已保存会话：清除快照并回到初始上传态 */
  const clearSavedSession = () => {
    requestSeq.current += 1;
    recheckSeq.current += 1;
    persistEpochRef.current += 1;
    clearResult();
    setFileName('');
    setHasSavedSession(false);
    void clearSessionSnapshot();
  };

  const missing = analysis?.zones.filter((z) => !z.present) ?? [];
  const selected = analysis?.zones.find((z) => z.zone.id === selectedId) ?? null;
  const selectedDiff = comparison?.zones.find((d) => d.zone.id === selectedId) ?? null;

  // 粘性选中：再次点选同一检测区保持选中，当前方位证据继续可见
  const selectZone = (id: ZoneId) => setSelectedId(id);

  // 键盘打开证据：更新选区并请求在渲染完成后把焦点移入审阅区
  const openZoneFromKeyboard = (id: ZoneId) => {
    selectZone(id);
    setReviewFocusTick((n) => n + 1);
  };

  const recheckMissing =
    comparison?.recheck.zones.filter((z) => !z.present).map((z) => z.zone.label) ?? [];

  // 读取并重建快照期间只显示“正在恢复”，不露出上传入口或半成品结果
  if (recovery.status === 'loading') {
    return (
      <div className="page">
        <h1>套准角标核验</h1>
        <div
          className="banner recovery"
          role="status"
          aria-live="polite"
          data-testid="recovery-loading"
        >
          正在恢复已保存的核验会话…
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>套准角标核验</h1>
      <p className="hint">
        上传一张恰为 1024×1024 的 PNG。系统检测四个角部 32×32 检测区（闭区间 x/y 各 16–47 与
        976–1007），每区 1024 个像素中至少 820 个命中（R≥240、G≤15、B≥240、A=255）视为角标存在，
        四区全部存在判定合格。采样基于原始像素，预览缩放不影响结果。首张有效图完成检测后固定为基准，
        可再上传一张同尺寸 PNG 作为复检图，按相同原始坐标逐像素对比调整前后的命中增减；
        点选任一检测卡片或预览框，可查看该区 32×32 原始像素裁片或复检差异图。
        误刷新页面时会自动恢复已保存的基准 / 复检原图与选中方位，判定均由原图重新分析得出。
      </p>

      {recovery.status === 'failed' && (
        <div className="banner error" role="alert" data-testid="recovery-error">
          <strong>无法恢复已保存的会话</strong>
          <span>{recovery.reason}</span>
        </div>
      )}

      <div className="upload">
        <label htmlFor="png-upload">上传 PNG 图像</label>
        <input
          id="png-upload"
          data-testid="file-input"
          type="file"
          accept="image/png"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // 允许重复选择同一文件再次触发检测
            e.target.value = '';
            if (file) void handleFile(file);
          }}
        />
        {fileName && <span className="file-name">{fileName}</span>}
      </div>

      {hasSavedSession && (
        <div className="session-bar" data-testid="session-bar">
          <button
            type="button"
            className="session-clear"
            data-testid="session-clear"
            onClick={clearSavedSession}
          >
            清除已保存会话
          </button>
          <span className="session-hint">删除浏览器中保存的原图与方位，回到初始上传态</span>
        </div>
      )}

      {error && (
        <div className="banner error" role="alert" data-testid="upload-error">
          <strong>{error.title}</strong>
          <span>{error.detail}</span>
        </div>
      )}

      {analysis && (
        <section className="result">
          <div className="verdict-row">
            <div className={`banner ${analysis.passed ? 'pass' : 'fail'}`} data-testid="verdict">
              {comparePhase === 'compared' && comparison ? (
                <span className="verdict-tag" data-testid="verdict-baseline">
                  调整前基准 ·
                </span>
              ) : null}
              {analysis.passed ? '合格' : '不合格'}
              {!analysis.passed && missing.length > 0 && (
                <span className="missing" data-testid="missing-zones">
                  缺失角标：{missing.map((z) => z.zone.label).join('、')}
                </span>
              )}
            </div>

            {comparePhase === 'compared' && comparison && (
              <div
                className={`banner ${comparison.recheck.passed ? 'pass' : 'fail'}`}
                data-testid="verdict-recheck"
              >
                <span className="verdict-tag">复检结果 ·</span>
                {comparison.recheck.passed ? '合格' : '不合格'}
                {recheckMissing.length > 0 && (
                  <span className="missing" data-testid="missing-zones-recheck">
                    缺失角标：{recheckMissing.join('、')}
                  </span>
                )}
              </div>
            )}
          </div>

          {comparePhase !== 'idle' && (
            <div className="recheck-bar" data-testid="recheck-bar">
              {comparePhase === 'awaiting' && (
                <>
                  <label htmlFor="recheck-upload" className="recheck-label">
                    基准已固定，上传同工位复检图（1024×1024 PNG）
                  </label>
                  <input
                    id="recheck-upload"
                    data-testid="recheck-input"
                    type="file"
                    accept="image/png"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void handleRecheckFile(file);
                    }}
                  />
                  {recheckFileName && (
                    <span className="file-name" data-testid="recheck-filename">
                      {recheckFileName}
                    </span>
                  )}
                  <span className="recheck-status" data-testid="recheck-status">
                    待复检
                  </span>
                </>
              )}
              {comparePhase === 'compared' && (
                <>
                  <label htmlFor="recheck-upload" className="recheck-label">
                    重新选择复检图
                  </label>
                  <input
                    id="recheck-upload"
                    data-testid="recheck-input"
                    type="file"
                    accept="image/png"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void handleRecheckFile(file);
                    }}
                  />
                  {recheckFileName && (
                    <span className="file-name" data-testid="recheck-filename">
                      {recheckFileName}
                    </span>
                  )}
                  <span className="recheck-status done" data-testid="recheck-status">
                    已完成对比
                  </span>
                  <button
                    type="button"
                    className="recheck-cancel"
                    data-testid="recheck-cancel"
                    onClick={cancelComparison}
                  >
                    取消对比
                  </button>
                </>
              )}
            </div>
          )}

          {recheckError && (
            <div className="banner error" role="alert" data-testid="recheck-error">
              <strong>{recheckError.title}</strong>
              <span>{recheckError.detail}</span>
            </div>
          )}

          <div className="panels">
            {previewUrl && (
              <div className="preview" data-testid="preview">
                <div className="preview-baseline" data-testid="preview-baseline">
                  <span className="preview-tag" data-testid="preview-tag-baseline">
                    调整前（基准）
                  </span>
                  <img src={previewUrl} alt="调整前基准图像预览" />
                  {analysis.zones.map((z) => (
                    <div
                      key={z.zone.id}
                      role="button"
                      tabIndex={0}
                      aria-label={
                        comparison
                          ? `查看${z.zone.label}检测区复检前后 32×32 差异图`
                          : `查看${z.zone.label}检测区原始像素`
                      }
                      aria-pressed={selectedId === z.zone.id}
                      className={`zone-box ${z.present ? 'present' : 'absent'} ${
                        selectedId === z.zone.id ? 'selected' : ''
                      }`}
                      style={zoneBoxStyle(z.zone)}
                      data-testid={`zone-box-${z.zone.id}`}
                      title={
                        comparison
                          ? `点选查看${z.zone.label}复检差异图`
                          : `点选查看${z.zone.label}原始像素`
                      }
                      onClick={() => selectZone(z.zone.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openZoneFromKeyboard(z.zone.id);
                        }
                      }}
                    />
                  ))}
                </div>
                {recheckPreviewUrl && comparison && (
                  <div className="preview-recheck" data-testid="preview-recheck">
                    <span className="preview-tag" data-testid="preview-tag-recheck">
                      复检结果
                    </span>
                    <img src={recheckPreviewUrl} alt="复检图像预览" />
                    {comparison.recheck.zones.map((z) => (
                      <div
                        key={z.zone.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`查看${z.zone.label}检测区复检前后 32×32 差异图`}
                        aria-pressed={selectedId === z.zone.id}
                        className={`zone-box ${z.present ? 'present' : 'absent'} ${
                          selectedId === z.zone.id ? 'selected' : ''
                        }`}
                        style={zoneBoxStyle(z.zone)}
                        data-testid={`recheck-zone-box-${z.zone.id}`}
                        title={`点选查看${z.zone.label}复检差异图`}
                        onClick={() => selectZone(z.zone.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            openZoneFromKeyboard(z.zone.id);
                          }
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            <ul className="zone-list">
              {analysis.zones.map((z) => {
                const diff = comparison?.zones.find((d) => d.zone.id === z.zone.id) ?? null;
                return (
                  <li
                    key={z.zone.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedId === z.zone.id}
                    className={`zone-card ${z.present ? 'present' : 'absent'} ${
                      selectedId === z.zone.id ? 'selected' : ''
                    }`}
                    data-testid={`zone-${z.zone.id}`}
                    onClick={() => selectZone(z.zone.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openZoneFromKeyboard(z.zone.id);
                      }
                    }}
                  >
                    <header>
                      <span className="zone-label">{z.zone.label}</span>
                      <span className="zone-status" data-testid={`zone-${z.zone.id}-status`}>
                        {diff ? `基准${z.present ? '存在' : '缺失'}` : z.present ? '存在' : '缺失'}
                      </span>
                    </header>
                    <div className="zone-hits" data-testid={`zone-${z.zone.id}-hits`}>
                      {diff ? '基准命中 ' : '命中 '}
                      {z.hits} / {z.total}
                    </div>
                    {!z.present && (
                      <div className="zone-reason" data-testid={`zone-${z.zone.id}-reason`}>
                        未达标：命中 {z.hits} 低于阈值 {HIT_THRESHOLD}
                      </div>
                    )}
                    {diff ? (
                      <div className="zone-diff" data-testid={`zone-${z.zone.id}-diff`}>
                        <div className="zone-recheck-row">
                          <span
                            className={`zone-status ${diff.recheck.present ? 'is-present' : 'is-absent'}`}
                            data-testid={`zone-${z.zone.id}-recheck-status`}
                          >
                            复检{diff.recheck.present ? '存在' : '缺失'}
                          </span>
                          <span
                            className={`diff-delta ${diff.hitDelta > 0 ? 'up' : diff.hitDelta < 0 ? 'down' : ''}`}
                            data-testid={`zone-${z.zone.id}-delta`}
                          >
                            命中{diff.hitDelta >= 0 ? '+' : ''}
                            {diff.hitDelta}（{diff.recheck.hits} / {z.total}）
                          </span>
                        </div>
                        <ul className="diff-counts">
                          <li data-testid={`zone-${z.zone.id}-recovered`}>
                            恢复命中 {diff.recovered}
                          </li>
                          <li data-testid={`zone-${z.zone.id}-newgaps`}>
                            新增缺失 {diff.newGaps}
                          </li>
                        </ul>
                      </div>
                    ) : (
                      <div className="zone-hint">点选查看原始像素裁片</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {selected && pixelsRef.current && (
            <section
              className="review"
              data-testid="review"
              ref={reviewRef}
              tabIndex={-1}
              aria-live="polite"
            >
              <h2>
                {selected.zone.label}检测区 ·{' '}
                {selectedDiff ? '复检前后差异证据' : '像素级证据'}
              </h2>
              <div className="review-body">
                {selectedDiff ? (
                  <>
                    <figure className="review-crop-wrap">
                      <DiffCrop diff={selectedDiff} />
                      <figcaption>
                        32×32 差异图（坐标 x {selected.zone.x0}–{selected.zone.x1}，y{' '}
                        {selected.zone.y0}–{selected.zone.y1}），按相同原始坐标逐像素分类，
                        最近邻放大显示
                      </figcaption>
                      <ul className="diff-legend">
                        {DIFF_LEGEND.map((item) => (
                          <li key={item.cls} data-testid={item.testid}>
                            <span className={`diff-swatch ${item.cls}`} aria-hidden="true" />
                            {item.label}
                          </li>
                        ))}
                      </ul>
                    </figure>
                    <div className="review-detail">
                      <div className="review-bounds" data-testid="review-diff-summary">
                        基准命中 {selectedDiff.baseline.hits} → 复检命中{' '}
                        {selectedDiff.recheck.hits}（
                        {selectedDiff.hitDelta > 0
                          ? `增加 ${selectedDiff.hitDelta}`
                          : selectedDiff.hitDelta < 0
                            ? `减少 ${-selectedDiff.hitDelta}`
                            : '无增减'}
                        ）
                      </div>
                      <ul className="edge-counts">
                        <li data-testid="review-diff-recovered">
                          恢复命中：{selectedDiff.recovered} 像素
                        </li>
                        <li data-testid="review-diff-newgaps">
                          新增缺失：{selectedDiff.newGaps} 像素
                        </li>
                        <li data-testid="review-diff-unchanged-hit">
                          两次均命中：{selectedDiff.unchangedHits} 像素
                        </li>
                        <li data-testid="review-diff-unchanged-miss">
                          两次均缺失：{selectedDiff.unchangedMisses} 像素
                        </li>
                      </ul>
                    </div>
                  </>
                ) : (
                  <>
                    <figure className="review-crop-wrap">
                      <ZoneCrop pixels={pixelsRef.current} zone={selected.zone} />
                      <figcaption>
                        32×32 原始像素裁片（坐标 x {selected.zone.x0}–{selected.zone.x1}，y{' '}
                        {selected.zone.y0}–{selected.zone.y1}），最近邻放大显示
                      </figcaption>
                    </figure>
                    <GapReview result={selected} />
                  </>
                )}
              </div>
            </section>
          )}
        </section>
      )}
    </div>
  );
}
