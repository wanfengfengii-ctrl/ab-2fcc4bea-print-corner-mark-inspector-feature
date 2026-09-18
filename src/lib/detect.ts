/**
 * 套准角标检测核心逻辑。
 *
 * 本模块为纯函数实现，不依赖浏览器 API，便于在 Vitest 中直接测试。
 * 所有检测区坐标均为闭区间，且始终基于原始 1024×1024 像素坐标系，
 * 与页面预览的缩放无关。
 */

/** 图像必须恰为该尺寸 */
export const IMAGE_SIZE = 1024;

/** 检测区边界（闭区间，单位：像素） */
export const ZONE_NEAR_MIN = 16;
export const ZONE_NEAR_MAX = 47;
export const ZONE_FAR_MIN = 976;
export const ZONE_FAR_MAX = 1007;

/** 单个检测区边长（闭区间 16–47 / 976–1007 均为 32 像素） */
export const ZONE_SIZE = ZONE_NEAR_MAX - ZONE_NEAR_MIN + 1;
/** 单个检测区像素总数：32 × 32 = 1024 */
export const ZONE_PIXELS = ZONE_SIZE * ZONE_SIZE;

/** 判定角标存在所需的最低命中像素数 */
export const HIT_THRESHOLD = 820;

export type ZoneId = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface Zone {
  id: ZoneId;
  /** 方位名称，用于界面展示与不合格定位 */
  label: string;
  /** 闭区间起点 x */
  x0: number;
  /** 闭区间起点 y */
  y0: number;
  /** 闭区间终点 x（含） */
  x1: number;
  /** 闭区间终点 y（含） */
  y1: number;
}

/** 四个固定检测区（闭区间），不随预览缩放改变 */
export const ZONES: readonly Zone[] = [
  { id: 'top-left', label: '左上', x0: ZONE_NEAR_MIN, y0: ZONE_NEAR_MIN, x1: ZONE_NEAR_MAX, y1: ZONE_NEAR_MAX },
  { id: 'top-right', label: '右上', x0: ZONE_FAR_MIN, y0: ZONE_NEAR_MIN, x1: ZONE_FAR_MAX, y1: ZONE_NEAR_MAX },
  { id: 'bottom-left', label: '左下', x0: ZONE_NEAR_MIN, y0: ZONE_FAR_MIN, x1: ZONE_NEAR_MAX, y1: ZONE_FAR_MAX },
  { id: 'bottom-right', label: '右下', x0: ZONE_FAR_MIN, y0: ZONE_FAR_MIN, x1: ZONE_FAR_MAX, y1: ZONE_FAR_MAX },
];

/** 命中条件：R≥240、G≤15、B≥240 且 A=255 */
export function isHitPixel(r: number, g: number, b: number, a: number): boolean {
  return r >= 240 && g <= 15 && b >= 240 && a === 255;
}

/** 未命中像素在检测区四边上的缺口计数（位于闭区间边界上的像素数） */
export interface EdgeGaps {
  /** 上边缘（y = zone.y0）上的未命中像素数 */
  top: number;
  /** 下边缘（y = zone.y1）上的未命中像素数 */
  bottom: number;
  /** 左边缘（x = zone.x0）上的未命中像素数 */
  left: number;
  /** 右边缘（x = zone.x1）上的未命中像素数 */
  right: number;
}

/** 未命中像素的最小包围范围；不存在未命中像素时为 null */
export interface GapBounds {
  /** 包围范围起点 x（含） */
  minX: number;
  /** 包围范围起点 y（含） */
  minY: number;
  /** 包围范围终点 x（含） */
  maxX: number;
  /** 包围范围终点 y（含） */
  maxY: number;
}

export interface ZoneResult {
  zone: Zone;
  /** 闭区间内实际命中数 */
  hits: number;
  /** 闭区间内像素总数（恒为 1024） */
  total: number;
  /** hits ≥ HIT_THRESHOLD 时角标存在 */
  present: boolean;
  /** 未命中像素数（total - hits） */
  misses: number;
  /**
   * 全部未命中像素的最小轴对齐包围范围（原始 1024×1024 坐标，闭区间）。
   * 缺口即使由多段离散像素组成，仍按全部未命中像素计算唯一包围范围。
   * 满命中（不存在未命中像素）时为 null，不伪造坐标。
   */
  gapBounds: GapBounds | null;
  /** 未命中像素在检测区上、下、左、右四条边上的计数 */
  edgeGaps: EdgeGaps;
}

export interface Analysis {
  zones: ZoneResult[];
  /** 四区全部存在才为合格 */
  passed: boolean;
}

/**
 * 统计单个检测区闭区间内的命中像素数。
 * 只读取 [x0, x1] × [y0, y1] 内的像素，区域外的品红像素不计入。
 */
export function countZoneHits(pixels: Uint8ClampedArray, width: number, zone: Zone): number {
  let hits = 0;
  for (let y = zone.y0; y <= zone.y1; y += 1) {
    const row = y * width;
    for (let x = zone.x0; x <= zone.x1; x += 1) {
      const i = (row + x) * 4;
      if (isHitPixel(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3])) {
        hits += 1;
      }
    }
  }
  return hits;
}

/**
 * 定位单个检测区内未命中像素的分布：
 * 返回全部未命中像素的最小包围范围与四边缺口计数。
 *
 * - 包围范围取所有未命中像素的 min/max，离散缺口也只产生唯一包围范围；
 * - 边缘计数统计落在检测区闭区间边界（上/下/左/右）上的未命中像素；
 * - 不存在未命中像素（满命中）时包围范围为 null、四边计数为 0，不伪造坐标。
 */
export function locateGaps(
  pixels: Uint8ClampedArray,
  width: number,
  zone: Zone,
): { misses: number; gapBounds: GapBounds | null; edgeGaps: EdgeGaps } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let misses = 0;
  const edgeGaps: EdgeGaps = { top: 0, bottom: 0, left: 0, right: 0 };

  for (let y = zone.y0; y <= zone.y1; y += 1) {
    const row = y * width;
    for (let x = zone.x0; x <= zone.x1; x += 1) {
      const i = (row + x) * 4;
      if (isHitPixel(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3])) {
        continue;
      }
      misses += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (y === zone.y0) edgeGaps.top += 1;
      if (y === zone.y1) edgeGaps.bottom += 1;
      if (x === zone.x0) edgeGaps.left += 1;
      if (x === zone.x1) edgeGaps.right += 1;
    }
  }

  return {
    misses,
    gapBounds: misses === 0 ? null : { minX, minY, maxX, maxY },
    edgeGaps,
  };
}

/**
 * 分析一幅 1024×1024 图像的 RGBA 像素数据。
 * 调用方必须保证尺寸恰为 IMAGE_SIZE×IMAGE_SIZE，否则抛错。
 */
export function analyzePixels(pixels: Uint8ClampedArray, width: number, height: number): Analysis {
  if (width !== IMAGE_SIZE || height !== IMAGE_SIZE) {
    throw new Error(`analyzePixels 要求 ${IMAGE_SIZE}×${IMAGE_SIZE}，收到 ${width}×${height}`);
  }
  const zones = ZONES.map((zone) => {
    const { misses, gapBounds, edgeGaps } = locateGaps(pixels, width, zone);
    const hits = ZONE_PIXELS - misses;
    return {
      zone,
      hits,
      total: ZONE_PIXELS,
      present: hits >= HIT_THRESHOLD,
      misses,
      gapBounds,
      edgeGaps,
    };
  });
  return { zones, passed: zones.every((z) => z.present) };
}

/** PNG 文件签名（8 字节） */
export const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 校验文件头是否为 PNG 签名 */
export function hasPngSignature(head: Uint8Array): boolean {
  return head.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => head[i] === b);
}

/* ===== 同工位复检：调整前基准图与复检图的前后对比 ===== */

/**
 * 图像载入流水线阶段标识（普通单图上传与复检图共用）：
 * signature 格式校验 → decode 原生解码 → size 尺寸校验 → sample 像素取样。
 */
export type UploadStage = 'signature' | 'decode' | 'size' | 'sample';

/**
 * 逐像素变化类别。两张图按相同原始坐标、同一 isHitPixel 命中规则分别判定后：
 *
 * - same-hit：两次均命中；
 * - same-miss：两次均未命中；
 * - recovered：基准未命中、复检命中（恢复命中，缺口修复）；
 * - new-gap：基准命中、复检未命中（新增缺失，缺口转移/恶化）。
 */
export type DiffClass = 'same-hit' | 'same-miss' | 'recovered' | 'new-gap';

/** DiffClass 的数字编码，按 Uint8Array 存储 32×32 分类图 */
export const DIFF_SAME_HIT = 0;
export const DIFF_SAME_MISS = 1;
export const DIFF_RECOVERED = 2;
export const DIFF_NEW_GAP = 3;

/** 编码 → 类别 的固定次序（下标即 DIFF_* 常量） */
export const DIFF_CLASSES: readonly DiffClass[] = [
  'same-hit',
  'same-miss',
  'recovered',
  'new-gap',
];

/** 按基准/复检两次命中结果分类单个像素 */
export function classifyDiff(baselineHit: boolean, recheckHit: boolean): DiffClass {
  if (baselineHit === recheckHit) return baselineHit ? 'same-hit' : 'same-miss';
  return recheckHit ? 'recovered' : 'new-gap';
}

/** 单个检测区的复检前后对比统计 */
export interface ZoneDiff {
  zone: Zone;
  /** 基准判定（复用 ZoneResult，与 Comparison.baseline.zones 中同区为同一对象） */
  baseline: ZoneResult;
  /** 复检判定（复用 ZoneResult，与 Comparison.recheck.zones 中同区为同一对象） */
  recheck: ZoneResult;
  /** 复检命中数相对基准的增减：recheck.hits - baseline.hits（恰为 recovered - newGaps） */
  hitDelta: number;
  /** 恢复命中像素数：基准未命中 → 复检命中 */
  recovered: number;
  /** 新增缺失像素数：基准命中 → 复检未命中 */
  newGaps: number;
  /** 两次均命中像素数 */
  unchangedHits: number;
  /** 两次均未命中像素数 */
  unchangedMisses: number;
  /**
   * 32×32 逐像素分类图（先行后列，局部坐标 (x - zone.x0, y - zone.y0)），
   * 取值为 DIFF_* 常量；分类基于两张图相同的原始坐标。
   */
  classes: Uint8Array;
}

/** 两张同尺寸图像的复检对比结果；基准与复检本身仍是标准 Analysis */
export interface Comparison {
  baseline: Analysis;
  recheck: Analysis;
  zones: ZoneDiff[];
}

function pixelHits(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): boolean {
  const i = (y * width + x) * 4;
  return isHitPixel(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
}

/**
 * 对比调整前基准图与复检图的原始 RGBA 像素。
 *
 * 两张图都必须恰为 IMAGE_SIZE×IMAGE_SIZE（与 analyzePixels 相同约束），
 * 基准与复检分别走 analyzePixels 得到 Analysis（复用 ZoneResult 与 820 阈值），
 * 再在每个检测区内按相同原始坐标逐像素套用 isHitPixel 分类，
 * 因此区外像素的任何变化都不会计入对比统计。
 */
export function comparePixels(
  baselinePixels: Uint8ClampedArray,
  recheckPixels: Uint8ClampedArray,
  width: number,
  height: number,
): Comparison {
  if (width !== IMAGE_SIZE || height !== IMAGE_SIZE) {
    throw new Error(`comparePixels 要求 ${IMAGE_SIZE}×${IMAGE_SIZE}，收到 ${width}×${height}`);
  }
  const baseline = analyzePixels(baselinePixels, width, height);
  const recheck = analyzePixels(recheckPixels, width, height);

  const zones = ZONES.map((zone, zi) => {
    const baselineZone = baseline.zones[zi];
    const recheckZone = recheck.zones[zi];
    const classes = new Uint8Array(ZONE_PIXELS);
    let recovered = 0;
    let newGaps = 0;
    let unchangedHits = 0;
    let unchangedMisses = 0;
    let k = 0;
    for (let y = zone.y0; y <= zone.y1; y += 1) {
      for (let x = zone.x0; x <= zone.x1; x += 1) {
        const cls = classifyDiff(
          pixelHits(baselinePixels, width, x, y),
          pixelHits(recheckPixels, width, x, y),
        );
        switch (cls) {
          case 'same-hit':
            unchangedHits += 1;
            classes[k] = DIFF_SAME_HIT;
            break;
          case 'same-miss':
            unchangedMisses += 1;
            classes[k] = DIFF_SAME_MISS;
            break;
          case 'recovered':
            recovered += 1;
            classes[k] = DIFF_RECOVERED;
            break;
          case 'new-gap':
            newGaps += 1;
            classes[k] = DIFF_NEW_GAP;
            break;
        }
        k += 1;
      }
    }
    const diff: ZoneDiff = {
      zone,
      baseline: baselineZone,
      recheck: recheckZone,
      hitDelta: recheckZone.hits - baselineZone.hits,
      recovered,
      newGaps,
      unchangedHits,
      unchangedMisses,
      classes,
    };
    return diff;
  });

  return { baseline, recheck, zones };
}

/** 差异图配色（RGBA）：品红=均命中，白=均未命中，绿=恢复，红=新增缺失 */
export const DIFF_COLORS: Readonly<Record<DiffClass, readonly [number, number, number, number]>> = {
  'same-hit': [255, 0, 255, 255],
  'same-miss': [255, 255, 255, 255],
  recovered: [16, 185, 129, 255],
  'new-gap': [224, 36, 36, 255],
};

/**
 * 把单区 32×32 分类图展开为 32×32 RGBA 像素缓冲（先行后列），
 * 供 Canvas 以最近邻放大绘制差异图。
 */
export function buildZoneDiffRgba(diff: ZoneDiff): Uint8ClampedArray {
  const out = new Uint8ClampedArray(ZONE_PIXELS * 4);
  for (let k = 0; k < ZONE_PIXELS; k += 1) {
    const [r, g, b, a] = DIFF_COLORS[DIFF_CLASSES[diff.classes[k]]];
    const j = k * 4;
    out[j] = r;
    out[j + 1] = g;
    out[j + 2] = b;
    out[j + 3] = a;
  }
  return out;
}
