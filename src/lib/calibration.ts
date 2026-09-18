/**
 * 扫描照明校准领域对象与纯计算逻辑。
 *
 * 本模块只分析中性灰校准图，不依赖任何浏览器 API，便于在 Vitest 中直接测试，
 * 也不会改写套准角标核验页的任何判定结果。
 *
 * 校准图固定为 1024×1024，等分为 8×8 个 128×128 方格（格序固定：先行后列，
 * 第 0 格为左上角）。逐像素亮度按 Rec.601 系数
 * 0.2126R + 0.7152G + 0.0722B 计算；每格给出平均亮度，全图给出 RGB 三通道
 * 均值与方格亮度极差（最大格均值 − 最小格均值）。
 *
 * 通过条件（两者同时满足）：
 *   1. 全图 R/G/B 三通道均值都落在闭区间 [112, 144]；
 *   2. 64 格亮度极差不超过 12。
 */

/** 校准图必须恰为该尺寸 */
export const CALIBRATION_IMAGE_SIZE = 1024;

/** 固定划分为 8×8 方格 */
export const CALIBRATION_GRID_SIZE = 8;

/** 每个方格边长：1024 / 8 = 128 像素 */
export const CALIBRATION_CELL_SIZE = CALIBRATION_IMAGE_SIZE / CALIBRATION_GRID_SIZE;

/** 方格总数：64 */
export const CALIBRATION_CELL_COUNT = CALIBRATION_GRID_SIZE * CALIBRATION_GRID_SIZE;

/** 全图通道均值允许区间（闭区间） */
export const CHANNEL_MEAN_MIN = 112;
export const CHANNEL_MEAN_MAX = 144;

/** 方格亮度极差上限（含 12） */
export const MAX_LUMINANCE_RANGE = 12;

/** Rec.601 luma 系数 */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** 单像素亮度：0.2126R + 0.7152G + 0.0722B */
export function luminance(r: number, g: number, b: number): number {
  return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

/** 单个 128×128 方格的校准结果 */
export interface CalibrationCell {
  /** 固定格序索引 0–63：index = row * 8 + col（先行后列，第 0 格为左上） */
  index: number;
  /** 行号 0–7（自上而下） */
  row: number;
  /** 列号 0–7（自左而右） */
  col: number;
  /** 方格左上角 x（原始像素坐标） */
  x0: number;
  /** 方格左上角 y（原始像素坐标） */
  y0: number;
  /** 方格边长（恒为 128） */
  size: number;
  /** 方格内全部像素的平均亮度（0–255） */
  meanLuminance: number;
}

export type CalibrationFailureCode =
  | 'channel-means-out-of-range'
  | 'luminance-range-exceeded';

/** 未通过项；code 供程序判断，message 为面向操作员的说明 */
export interface CalibrationFailure {
  code: CalibrationFailureCode;
  message: string;
}

/** 扫描照明校准报告领域对象 */
export interface CalibrationReport {
  /** 被分析的文件名 */
  fileName: string;
  width: number;
  height: number;
  /** 64 个方格，严格按固定格序（先行后列）返回 */
  cells: CalibrationCell[];
  /** 全图 R 通道均值 */
  meanRed: number;
  /** 全图 G 通道均值 */
  meanGreen: number;
  /** 全图 B 通道均值 */
  meanBlue: number;
  /** 全图平均亮度 */
  meanLuminance: number;
  /** 最暗方格平均亮度 */
  minLuminance: number;
  /** 最亮方格平均亮度 */
  maxLuminance: number;
  /** 方格亮度极差 = maxLuminance - minLuminance */
  luminanceRange: number;
  /** 最暗方格在固定格序中的索引 */
  dimmestCellIndex: number;
  /** 最亮方格在固定格序中的索引 */
  brightestCellIndex: number;
  /** 三通道均值是否都在 [112, 144] */
  channelMeansInRange: boolean;
  /** 亮度极差是否不超过 12 */
  luminanceRangeWithinLimit: boolean;
  /** 两项条件同时满足才通过 */
  passed: boolean;
  /** 未通过项列表（通过时为空） */
  failures: CalibrationFailure[];
  /** 面向操作员的结论文本 */
  conclusion: string;
}

function f2(n: number): string {
  return n.toFixed(2);
}

function inChannelRange(mean: number): boolean {
  return mean >= CHANNEL_MEAN_MIN && mean <= CHANNEL_MEAN_MAX;
}

/**
 * 基于已采样的原始 RGBA 像素构建校准报告。
 * 调用方必须保证像素来自恰为 1024×1024 的图像，否则抛错。
 */
export function buildCalibrationReport(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  fileName: string,
): CalibrationReport {
  if (width !== CALIBRATION_IMAGE_SIZE || height !== CALIBRATION_IMAGE_SIZE) {
    throw new Error(
      `buildCalibrationReport 要求 ${CALIBRATION_IMAGE_SIZE}×${CALIBRATION_IMAGE_SIZE}，收到 ${width}×${height}`,
    );
  }

  // 全图三通道累加
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  // 每格亮度累加（固定格序）
  const cellLumaSums = new Float64Array(CALIBRATION_CELL_COUNT);

  for (let y = 0; y < height; y += 1) {
    const row = Math.floor(y / CALIBRATION_CELL_SIZE);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      redSum += r;
      greenSum += g;
      blueSum += b;
      const col = Math.floor(x / CALIBRATION_CELL_SIZE);
      cellLumaSums[row * CALIBRATION_GRID_SIZE + col] += luminance(r, g, b);
    }
  }

  const totalPixels = width * height;
  const meanRed = redSum / totalPixels;
  const meanGreen = greenSum / totalPixels;
  const meanBlue = blueSum / totalPixels;
  const meanLuma = luminance(meanRed, meanGreen, meanBlue);

  const cellPixels = CALIBRATION_CELL_SIZE * CALIBRATION_CELL_SIZE;
  const cells: CalibrationCell[] = [];
  for (let index = 0; index < CALIBRATION_CELL_COUNT; index += 1) {
    const row = Math.floor(index / CALIBRATION_GRID_SIZE);
    const col = index % CALIBRATION_GRID_SIZE;
    cells.push({
      index,
      row,
      col,
      x0: col * CALIBRATION_CELL_SIZE,
      y0: row * CALIBRATION_CELL_SIZE,
      size: CALIBRATION_CELL_SIZE,
      meanLuminance: cellLumaSums[index] / cellPixels,
    });
  }

  let dimmestCellIndex = 0;
  let brightestCellIndex = 0;
  let minLuminance = cells[0].meanLuminance;
  let maxLuminance = cells[0].meanLuminance;
  for (let i = 1; i < cells.length; i += 1) {
    const l = cells[i].meanLuminance;
    // 固定格序下首个取得极值的格保留索引，结论稳定可复现
    if (l < minLuminance) {
      minLuminance = l;
      dimmestCellIndex = i;
    }
    if (l > maxLuminance) {
      maxLuminance = l;
      brightestCellIndex = i;
    }
  }
  const luminanceRange = maxLuminance - minLuminance;

  const channelMeansInRange =
    inChannelRange(meanRed) && inChannelRange(meanGreen) && inChannelRange(meanBlue);
  const luminanceRangeWithinLimit = luminanceRange <= MAX_LUMINANCE_RANGE;
  const passed = channelMeansInRange && luminanceRangeWithinLimit;

  const failures: CalibrationFailure[] = [];
  if (!channelMeansInRange) {
    const out: string[] = [];
    if (!inChannelRange(meanRed)) out.push(`R 通道均值 ${f2(meanRed)} 不在 ${CHANNEL_MEAN_MIN}–${CHANNEL_MEAN_MAX} 区间`);
    if (!inChannelRange(meanGreen)) out.push(`G 通道均值 ${f2(meanGreen)} 不在 ${CHANNEL_MEAN_MIN}–${CHANNEL_MEAN_MAX} 区间`);
    if (!inChannelRange(meanBlue)) out.push(`B 通道均值 ${f2(meanBlue)} 不在 ${CHANNEL_MEAN_MIN}–${CHANNEL_MEAN_MAX} 区间`);
    failures.push({
      code: 'channel-means-out-of-range',
      message: `${out.join('；')}，照明整体偏色`,
    });
  }
  if (!luminanceRangeWithinLimit) {
    failures.push({
      code: 'luminance-range-exceeded',
      message:
        `64 格亮度极差 ${f2(luminanceRange)}（最暗格 ${f2(minLuminance)}、最亮格 ${f2(maxLuminance)}）` +
        `超过上限 ${MAX_LUMINANCE_RANGE}，照明存在暗角或分布不均`,
    });
  }

  const conclusion = passed
    ? `校准通过：全图 RGB 均值 ${f2(meanRed)} / ${f2(meanGreen)} / ${f2(meanBlue)} 均在 ` +
      `${CHANNEL_MEAN_MIN}–${CHANNEL_MEAN_MAX} 区间，64 格亮度极差 ${f2(luminanceRange)} 不超过 ` +
      `${MAX_LUMINANCE_RANGE}，照明中性且无暗角。`
    : `校准不通过：${failures.map((failure) => failure.message).join('；')}。`;

  return {
    fileName,
    width,
    height,
    cells,
    meanRed,
    meanGreen,
    meanBlue,
    meanLuminance: meanLuma,
    minLuminance,
    maxLuminance,
    luminanceRange,
    dimmestCellIndex,
    brightestCellIndex,
    channelMeansInRange,
    luminanceRangeWithinLimit,
    passed,
    failures,
    conclusion,
  };
}
