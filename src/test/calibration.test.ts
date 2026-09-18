import { describe, expect, it } from 'vitest';
import {
  buildCalibrationReport,
  CALIBRATION_CELL_COUNT,
  CALIBRATION_CELL_SIZE,
  CALIBRATION_GRID_SIZE,
  CALIBRATION_IMAGE_SIZE,
  CHANNEL_MEAN_MAX,
  CHANNEL_MEAN_MIN,
  luminance,
  MAX_LUMINANCE_RANGE,
} from '../lib/calibration';

type Rgb = readonly [number, number, number];

/** 按像素回调生成 1024×1024 RGBA 像素缓冲（不透明） */
function makePixels(paint: (x: number, y: number) => Rgb): Uint8ClampedArray {
  const px = new Uint8ClampedArray(CALIBRATION_IMAGE_SIZE * CALIBRATION_IMAGE_SIZE * 4);
  for (let y = 0; y < CALIBRATION_IMAGE_SIZE; y += 1) {
    for (let x = 0; x < CALIBRATION_IMAGE_SIZE; x += 1) {
      const [r, g, b] = paint(x, y);
      const i = (y * CALIBRATION_IMAGE_SIZE + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return px;
}

function solid(r: number, g: number, b: number): Uint8ClampedArray {
  return makePixels(() => [r, g, b]);
}

/** 判断像素 (x, y) 是否落在固定格序 index 的 128×128 方格内 */
function inCell(x: number, y: number, index: number): boolean {
  const row = Math.floor(index / CALIBRATION_GRID_SIZE);
  const col = index % CALIBRATION_GRID_SIZE;
  return (
    x >= col * CALIBRATION_CELL_SIZE &&
    x < (col + 1) * CALIBRATION_CELL_SIZE &&
    y >= row * CALIBRATION_CELL_SIZE &&
    y < (row + 1) * CALIBRATION_CELL_SIZE
  );
}

/** 仅指定方格使用自定义灰度，其余方格为基础灰度 */
function grayWithCell(cellIndex: number, cellGray: number, baseGray: number): Uint8ClampedArray {
  return makePixels((x, y) => {
    const v = inCell(x, y, cellIndex) ? cellGray : baseGray;
    return [v, v, v];
  });
}

describe('亮度公式 0.2126R + 0.7152G + 0.0722B', () => {
  it('黑为 0、白为 255（系数之和为 1）', () => {
    expect(luminance(0, 0, 0)).toBeCloseTo(0, 10);
    expect(luminance(255, 255, 255)).toBeCloseTo(255, 10);
  });

  it('按 Rec.601 系数加权', () => {
    expect(luminance(100, 0, 0)).toBeCloseTo(21.26, 10);
    expect(luminance(0, 100, 0)).toBeCloseTo(71.52, 10);
    expect(luminance(0, 0, 100)).toBeCloseTo(7.22, 10);
    expect(luminance(150, 120, 120)).toBeCloseTo(126.378, 10);
  });
});

describe('8×8 固定格序与几何', () => {
  it('64 个方格严格按先行后列返回，每格 128×128', () => {
    const report = buildCalibrationReport(solid(128, 128, 128), 1024, 1024, 'gray.png');
    expect(report.cells).toHaveLength(CALIBRATION_CELL_COUNT);
    report.cells.forEach((cell, index) => {
      expect(cell.index).toBe(index);
      expect(cell.row).toBe(Math.floor(index / CALIBRATION_GRID_SIZE));
      expect(cell.col).toBe(index % CALIBRATION_GRID_SIZE);
      expect(cell.size).toBe(CALIBRATION_CELL_SIZE);
      expect(cell.x0).toBe(cell.col * CALIBRATION_CELL_SIZE);
      expect(cell.y0).toBe(cell.row * CALIBRATION_CELL_SIZE);
    });
    expect(report.cells[0]).toMatchObject({ row: 0, col: 0, x0: 0, y0: 0 });
    expect(report.cells[7]).toMatchObject({ row: 0, col: 7, x0: 896, y0: 0 });
    expect(report.cells[56]).toMatchObject({ row: 7, col: 0, x0:0, y0: 896 });
    expect(report.cells[63]).toMatchObject({ row: 7, col: 7, x0: 896, y0: 896 });
  });

  it('尺寸不符时抛出异常', () => {
    expect(() => buildCalibrationReport(new Uint8ClampedArray(4), 1, 1, 'x.png')).toThrow(
      /1024×1024/,
    );
  });
});

describe('均匀灰图：通过', () => {
  it('128 中性灰：RGB 均值 128、极差 0，判定通过', () => {
    const report = buildCalibrationReport(solid(128, 128, 128), 1024, 1024, 'gray.png');

    expect(report.meanRed).toBeCloseTo(128, 10);
    expect(report.meanGreen).toBeCloseTo(128, 10);
    expect(report.meanBlue).toBeCloseTo(128, 10);
    expect(report.meanLuminance).toBeCloseTo(128, 10);
    expect(report.minLuminance).toBeCloseTo(128, 10);
    expect(report.maxLuminance).toBeCloseTo(128, 10);
    expect(report.luminanceRange).toBeCloseTo(0, 10);
    expect(report.channelMeansInRange).toBe(true);
    expect(report.luminanceRangeWithinLimit).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.conclusion).toContain('校准通过');
    for (const cell of report.cells) {
      expect(cell.meanLuminance).toBeCloseTo(128, 10);
    }
  });

  it('通道均值边界 112 与 144、极差恰为 12 时仍通过（闭区间）', () => {
    // 32 格 122、32 格 134：全图均值 128，极差恰为 12
    const px = makePixels((x, y) => {
      const index = Math.floor(y / CALIBRATION_CELL_SIZE) * CALIBRATION_GRID_SIZE
        + Math.floor(x / CALIBRATION_CELL_SIZE);
      const v = index % 2 === 0 ? 122 : 134;
      return [v, v, v];
    });
    const atEdge = buildCalibrationReport(px, 1024, 1024, 'edge.png');
    expect(atEdge.luminanceRange).toBeCloseTo(MAX_LUMINANCE_RANGE, 10);
    expect(atEdge.luminanceRangeWithinLimit).toBe(true);
    expect(atEdge.passed).toBe(true);

    const lo = buildCalibrationReport(solid(CHANNEL_MEAN_MIN, CHANNEL_MEAN_MIN, CHANNEL_MEAN_MIN), 1024, 1024, 'lo.png');
    const hi = buildCalibrationReport(solid(CHANNEL_MEAN_MAX, CHANNEL_MEAN_MAX, CHANNEL_MEAN_MAX), 1024, 1024, 'hi.png');
    expect(lo.passed).toBe(true);
    expect(hi.passed).toBe(true);
  });
});

describe('单格暗角：不通过', () => {
  it('左上角方格偏暗 18 个灰度：极差 18 > 12，通道均值仍在区间，仅因暗角不通过', () => {
    const px = grayWithCell(0, 110, 128);
    const report = buildCalibrationReport(px, 1024, 1024, 'vignette.png');

    // 最暗格为固定格序第 0 格（左上），最亮格取格序中首个 128 格（第 1 格）
    expect(report.cells[0].meanLuminance).toBeCloseTo(110, 10);
    expect(report.dimmestCellIndex).toBe(0);
    expect(report.brightestCellIndex).toBe(1);
    expect(report.minLuminance).toBeCloseTo(110, 10);
    expect(report.maxLuminance).toBeCloseTo(128, 10);
    expect(report.luminanceRange).toBeCloseTo(18, 10);
    expect(report.luminanceRangeWithinLimit).toBe(false);

    // 单格占 1/64 面积：128 − 18/64 = 127.71875，仍在 112–144 内
    expect(report.meanRed).toBeCloseTo(127.71875, 10);
    expect(report.channelMeansInRange).toBe(true);

    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.code)).toEqual(['luminance-range-exceeded']);
    expect(report.conclusion).toContain('校准不通过');
    expect(report.conclusion).toContain('暗角');
  });

  it('极差 13 即超过上限 12', () => {
    const report = buildCalibrationReport(grayWithCell(63, 115, 128), 1024, 1024, 'corner.png');
    expect(report.luminanceRange).toBeCloseTo(13, 10);
    expect(report.dimmestCellIndex).toBe(63);
    expect(report.passed).toBe(false);
  });
});

describe('整体偏色：不通过', () => {
  it('R 均值 150 超出 144 上限：画面均匀但整体偏色，不通过', () => {
    const report = buildCalibrationReport(solid(150, 120, 120), 1024, 1024, 'cast.png');

    expect(report.meanRed).toBeCloseTo(150, 10);
    expect(report.meanGreen).toBeCloseTo(120, 10);
    expect(report.meanBlue).toBeCloseTo(120, 10);
    expect(report.channelMeansInRange).toBe(false);
    // 画面完全均匀，极差为 0，暗角条件本身满足
    expect(report.luminanceRange).toBeCloseTo(0, 10);
    expect(report.luminanceRangeWithinLimit).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.code)).toEqual(['channel-means-out-of-range']);
    expect(report.failures[0].message).toContain('R 通道均值 150.00');
    expect(report.conclusion).toContain('偏色');
  });

  it('B 均值 100 低于 112 下限同样判定偏色', () => {
    const report = buildCalibrationReport(solid(128, 128, 100), 1024, 1024, 'blue-cast.png');
    expect(report.channelMeansInRange).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.failures[0].message).toContain('B 通道均值 100.00');
  });

  it('偏色与暗角同时存在时给出两条未通过项', () => {
    const px = makePixels((x, y) => {
      const v = inCell(x, y, 0) ? 110 : 150;
      return [v, v - 20, v - 20];
    });
    const report = buildCalibrationReport(px, 1024, 1024, 'both.png');
    expect(report.channelMeansInRange).toBe(false);
    expect(report.luminanceRangeWithinLimit).toBe(false);
    expect(report.failures.map((f) => f.code)).toEqual([
      'channel-means-out-of-range',
      'luminance-range-exceeded',
    ]);
    expect(report.passed).toBe(false);
  });
});
