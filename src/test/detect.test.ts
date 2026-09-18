import { describe, expect, it } from 'vitest';
import {
  analyzePixels,
  buildZoneDiffRgba,
  classifyDiff,
  comparePixels,
  countZoneHits,
  DIFF_COLORS,
  DIFF_NEW_GAP,
  DIFF_RECOVERED,
  DIFF_SAME_HIT,
  DIFF_SAME_MISS,
  hasPngSignature,
  HIT_THRESHOLD,
  IMAGE_SIZE,
  isHitPixel,
  locateGaps,
  PNG_SIGNATURE,
  ZONE_PIXELS,
  ZONES,
} from '../lib/detect';

type Rgba = [number, number, number, number];
const MAGENTA: Rgba = [255, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];

/** 按像素回调生成 1024×1024 RGBA 像素缓冲 */
function makePixels(paint: (x: number, y: number) => Rgba): Uint8ClampedArray {
  const px = new Uint8ClampedArray(IMAGE_SIZE * IMAGE_SIZE * 4);
  for (let y = 0; y < IMAGE_SIZE; y += 1) {
    for (let x = 0; x < IMAGE_SIZE; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * IMAGE_SIZE + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = a;
    }
  }
  return px;
}

function inZone(x: number, y: number, zoneIndex: number): boolean {
  const z = ZONES[zoneIndex];
  return x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
}

/** 生成指定检测区内恰好 hits 个品红像素、其余全白的图像 */
function pixelsWithZoneHits(zoneIndex: number, hits: number): Uint8ClampedArray {
  const z = ZONES[zoneIndex];
  return makePixels((x, y) => {
    if (inZone(x, y, zoneIndex)) {
      const n = (y - z.y0) * (z.x1 - z.x0 + 1) + (x - z.x0);
      return n < hits ? MAGENTA : WHITE;
    }
    return WHITE;
  });
}

describe('命中像素边界（R≥240、G≤15、B≥240、A=255）', () => {
  it('边界值 (240, 15, 240, 255) 命中', () => {
    expect(isHitPixel(240, 15, 240, 255)).toBe(true);
  });

  it('典型品红 (255, 0, 255, 255) 命中', () => {
    expect(isHitPixel(255, 0, 255, 255)).toBe(true);
  });

  it.each([
    [239, 15, 240, 255, 'R 低于下限'],
    [240, 16, 240, 255, 'G 高于上限'],
    [240, 15, 239, 255, 'B 低于下限'],
    [240, 15, 240, 254, 'A 非 255'],
    [255, 0, 255, 0, '完全透明'],
  ])('越界值 (%d, %d, %d, %d) 不命中：%s', (r, g, b, a) => {
    expect(isHitPixel(r, g, b, a)).toBe(false);
  });
});

describe('检测区几何', () => {
  it('四个检测区为规定的闭区间', () => {
    expect(ZONES.map(({ x0, y0, x1, y1 }) => [x0, y0, x1, y1])).toEqual([
      [16, 16, 47, 47],
      [976, 16, 1007, 47],
      [16, 976, 47, 1007],
      [976, 976, 1007, 1007],
    ]);
  });

  it('每区 32×32 共 1024 像素', () => {
    expect(ZONE_PIXELS).toBe(1024);
    for (const z of ZONES) {
      expect((z.x1 - z.x0 + 1) * (z.y1 - z.y0 + 1)).toBe(1024);
    }
  });

  it('四个检测区互不重叠', () => {
    for (let i = 0; i < ZONES.length; i += 1) {
      for (let j = i + 1; j < ZONES.length; j += 1) {
        const a = ZONES[i];
        const b = ZONES[j];
        const overlap = a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
        expect(overlap).toBe(false);
      }
    }
  });
});

describe('阈值判定（每区 1024 像素至少 820 命中）', () => {
  it('819 个命中 → 角标缺失', () => {
    const res = analyzePixels(pixelsWithZoneHits(0, HIT_THRESHOLD - 1), IMAGE_SIZE, IMAGE_SIZE);
    expect(res.zones[0].hits).toBe(819);
    expect(res.zones[0].present).toBe(false);
    expect(res.passed).toBe(false);
  });

  it('820 个命中 → 角标存在', () => {
    const res = analyzePixels(pixelsWithZoneHits(0, HIT_THRESHOLD), IMAGE_SIZE, IMAGE_SIZE);
    expect(res.zones[0].hits).toBe(820);
    expect(res.zones[0].present).toBe(true);
  });

  it('区域外的品红像素不计入区内命中', () => {
    // 整图品红，仅左上区全部置白：左上必须计 0，其余区计满 1024
    const px = makePixels((x, y) => (inZone(x, y, 0) ? WHITE : MAGENTA));
    const res = analyzePixels(px, IMAGE_SIZE, IMAGE_SIZE);
    expect(res.zones[0].hits).toBe(0);
    expect(res.zones[0].present).toBe(false);
    expect(res.zones[1].hits).toBe(1024);
    expect(res.zones[2].hits).toBe(1024);
    expect(res.zones[3].hits).toBe(1024);
    expect(res.passed).toBe(false);
  });

  it('countZoneHits 只统计闭区间内的像素', () => {
    // 紧贴上边界的区外像素（x=15、x=48、y=15、y=48）均为品红，区内全白
    const z = ZONES[0];
    const px = makePixels((x, y) => {
      const ring =
        (x === z.x0 - 1 || x === z.x1 + 1 || y === z.y0 - 1 || y === z.y1 + 1) &&
        x >= z.x0 - 1 &&
        x <= z.x1 + 1 &&
        y >= z.y0 - 1 &&
        y <= z.y1 + 1;
      return ring ? MAGENTA : WHITE;
    });
    expect(countZoneHits(px, IMAGE_SIZE, z)).toBe(0);
  });
});

describe('缺口定位（未命中像素包围范围与四边计数）', () => {
  /** 指定检测区内命中品红、谓词命中处置白（未命中）；区外置白避免干扰其他区 */
  function pixelsWithMisses(
    zoneIndex: number,
    isMiss: (x: number, y: number) => boolean,
  ): Uint8ClampedArray {
    return makePixels((x, y) => (inZone(x, y, zoneIndex) ? (isMiss(x, y) ? WHITE : MAGENTA) : WHITE));
  }

  it('单边缺口：仅上边缘内部 30 像素未命中，只计入上边', () => {
    const z = ZONES[0];
    const px = pixelsWithMisses(0, (x, y) => y === z.y0 && x >= z.x0 + 1 && x <= z.x1 - 1);

    const gap = locateGaps(px, IMAGE_SIZE, z);
    expect(gap.misses).toBe(30);
    expect(gap.edgeGaps).toEqual({ top: 30, bottom: 0, left: 0, right: 0 });
    expect(gap.gapBounds).toEqual({ minX: z.x0 + 1, minY: z.y0, maxX: z.x1 - 1, maxY: z.y0 });
    // 与既有命中计数保持一致
    expect(countZoneHits(px, IMAGE_SIZE, z)).toBe(ZONE_PIXELS - 30);
  });

  it('离散缺口：三个不连续像素仍得到唯一包围范围，角点同时计入相邻两边', () => {
    const z = ZONES[0];
    const missPixels = new Set(
      [`${z.x0},${z.y0}`, `${z.x0 + 5},${z.y0 + 7}`, `${z.x1},${z.y1}`],
    );
    const px = pixelsWithMisses(0, (x, y) => missPixels.has(`${x},${y}`));

    const gap = locateGaps(px, IMAGE_SIZE, z);
    expect(gap.misses).toBe(3);
    // 即使缺口互不相连，包围范围仍覆盖全部未命中像素的极值
    expect(gap.gapBounds).toEqual({ minX: z.x0, minY: z.y0, maxX: z.x1, maxY: z.y1 });
    // (x0,y0) 同时位于上边与左边；(x1,y1) 同时位于下边与右边；内部点不计入任何边
    expect(gap.edgeGaps).toEqual({ top: 1, bottom: 1, left: 1, right: 1 });
    expect(countZoneHits(px, IMAGE_SIZE, z)).toBe(ZONE_PIXELS - 3);
  });

  it('无缺口：满命中区域 gapBounds 为 null 且四边计数均为 0，不伪造坐标', () => {
    const z = ZONES[0];
    const px = pixelsWithMisses(0, () => false);

    expect(locateGaps(px, IMAGE_SIZE, z)).toEqual({
      misses: 0,
      gapBounds: null,
      edgeGaps: { top: 0, bottom: 0, left: 0, right: 0 },
    });
  });

  it('analyzePixels 在既有字段上兼容补充缺口数据，命中规则与 820 阈值不变', () => {
    // 右上区 819 命中（末 205 像素未命中），其余区满命中
    const tr = ZONES[1];
    const px = makePixels((x, y) => {
      if (x >= tr.x0 && x <= tr.x1 && y >= tr.y0 && y <= tr.y1) {
        const n = (y - tr.y0) * (tr.x1 - tr.x0 + 1) + (x - tr.x0);
        return n < HIT_THRESHOLD - 1 ? MAGENTA : WHITE;
      }
      return ZONES.some((_, i) => i !== 1 && inZone(x, y, i)) ? MAGENTA : WHITE;
    });

    const res = analyzePixels(px, IMAGE_SIZE, IMAGE_SIZE);
    expect(res.zones[1].hits).toBe(819);
    expect(res.zones[1].present).toBe(false);
    expect(res.zones[1].misses).toBe(205);
    // 819 = 25 整行 + 第 26 行前 19 像素：缺口从局部行 25（y=41）开始，
    // 其后 6 行整行缺失，故唯一包围范围横跨检测区全宽（x 976–1007）
    expect(res.zones[1].gapBounds).toEqual({ minX: 976, minY: 41, maxX: 1007, maxY: 47 });
    // 右边缘：第 26 行缺 1 个 + 后 6 整行；左边缘仅后 6 整行
    expect(res.zones[1].edgeGaps).toEqual({ top: 0, bottom: 32, left: 6, right: 7 });

    // 满命中区不产生伪造坐标
    for (const i of [0, 2, 3]) {
      expect(res.zones[i].gapBounds).toBeNull();
      expect(res.zones[i].misses).toBe(0);
      expect(res.zones[i].edgeGaps).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    }
  });
});

describe('整体判定', () => {
  it('四区全部命中 → 合格', () => {
    const px = makePixels((x, y) =>
      ZONES.some((_, i) => inZone(x, y, i)) ? MAGENTA : WHITE,
    );
    const res = analyzePixels(px, IMAGE_SIZE, IMAGE_SIZE);
    expect(res.zones.every((z) => z.hits === 1024 && z.present)).toBe(true);
    expect(res.passed).toBe(true);
  });

  it('任一区缺失 → 不合格并保留方位信息', () => {
    // 右上区 819 命中，其余区满命中
    const px = makePixels((x, y) => {
      if (inZone(x, y, 1)) {
        const z = ZONES[1];
        const n = (y - z.y0) * (z.x1 - z.x0 + 1) + (x - z.x0);
        return n < 819 ? MAGENTA : WHITE;
      }
      return ZONES.some((_, i) => i !== 1 && inZone(x, y, i)) ? MAGENTA : WHITE;
    });
    const res = analyzePixels(px, IMAGE_SIZE, IMAGE_SIZE);
    expect(res.passed).toBe(false);
    expect(res.zones.filter((z) => !z.present).map((z) => z.zone.label)).toEqual(['右上']);
  });

  it('尺寸不符时抛出异常', () => {
    expect(() => analyzePixels(new Uint8ClampedArray(4), 1, 1)).toThrow(/1024×1024/);
  });
});

describe('PNG 文件头校验', () => {
  it('合法 PNG 签名通过', () => {
    expect(hasPngSignature(new Uint8Array(PNG_SIGNATURE))).toBe(true);
  });

  it('文件头不符或长度不足均拒绝', () => {
    expect(hasPngSignature(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(false);
    expect(hasPngSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe(false);
    expect(hasPngSignature(new Uint8Array(0))).toBe(false);
  });
});

describe('复检前后对比（comparePixels 逐像素分类）', () => {
  /**
   * 生成检测区外全白、四个检测区按各区谓词决定命中的像素缓冲。
   * miss 谓词返回 true 的局部坐标处置白（未命中），其余命中。
   */
  function makeComparisonPixels(
    missByZone: ReadonlyArray<(lx: number, ly: number) => boolean>,
  ): Uint8ClampedArray {
    return makePixels((x, y) => {
      const zi = ZONES.findIndex((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
      if (zi < 0) return WHITE;
      const z = ZONES[zi];
      return missByZone[zi](x - z.x0, y - z.y0) ? WHITE : MAGENTA;
    });
  }

  const noMiss = () => false;

  it('classifyDiff 四种逐像素类别', () => {
    expect(classifyDiff(true, true)).toBe('same-hit');
    expect(classifyDiff(false, false)).toBe('same-miss');
    expect(classifyDiff(false, true)).toBe('recovered');
    expect(classifyDiff(true, false)).toBe('new-gap');
  });

  it('无变化：两张相同合格图，各区无增减、分类全部为两次均命中', () => {
    const px = makeComparisonPixels([noMiss, noMiss, noMiss, noMiss]);
    const cmp = comparePixels(px, px, IMAGE_SIZE, IMAGE_SIZE);

    expect(cmp.baseline.passed).toBe(true);
    expect(cmp.recheck.passed).toBe(true);
    for (const d of cmp.zones) {
      expect(d.hitDelta).toBe(0);
      expect(d.recovered).toBe(0);
      expect(d.newGaps).toBe(0);
      expect(d.unchangedHits).toBe(ZONE_PIXELS);
      expect(d.unchangedMisses).toBe(0);
      expect(Array.from(d.classes)).toEqual(Array(ZONE_PIXELS).fill(DIFF_SAME_HIT));
    }
  });

  it('缺口修复：基准右上 819 命中（末 205 像素缺失），复检满命中 → 恢复 205、无新增缺失', () => {
    const missTail = (lx: number, ly: number) => ly * 32 + lx >= 819;
    const baseline = makeComparisonPixels([noMiss, missTail, noMiss, noMiss]);
    const recheck = makeComparisonPixels([noMiss, noMiss, noMiss, noMiss]);

    const cmp = comparePixels(baseline, recheck, IMAGE_SIZE, IMAGE_SIZE);

    // 复用 Analysis / ZoneResult：基准不合格、复检合格，且区结果与单独分析一致
    expect(cmp.baseline.passed).toBe(false);
    expect(cmp.recheck.passed).toBe(true);
    expect(cmp.baseline.zones[1]).toBe(cmp.zones[1].baseline);
    expect(cmp.recheck.zones[1]).toBe(cmp.zones[1].recheck);
    expect(cmp.zones[1].baseline.present).toBe(false);
    expect(cmp.zones[1].recheck.present).toBe(true);

    const d = cmp.zones[1];
    expect(d.baseline.hits).toBe(819);
    expect(d.recheck.hits).toBe(1024);
    expect(d.hitDelta).toBe(205);
    expect(d.recovered).toBe(205);
    expect(d.newGaps).toBe(0);
    expect(d.unchangedHits).toBe(819);
    expect(d.unchangedMisses).toBe(0);
    // 逐区统计：其余三区均无变化
    for (const i of [0, 2, 3]) {
      expect(cmp.zones[i].recovered).toBe(0);
      expect(cmp.zones[i].newGaps).toBe(0);
      expect(cmp.zones[i].hitDelta).toBe(0);
    }
    // 分类图：首个缺口局部坐标 (19,25)（k=819）为恢复命中，其之前为两次均命中
    expect(d.classes[818]).toBe(DIFF_SAME_HIT);
    expect(d.classes[819]).toBe(DIFF_RECOVERED);
    expect(d.classes[1023]).toBe(DIFF_RECOVERED);
  });

  it('缺口转移：左上 10 个缺口从局部 0–9 平移到 20–29，恢复与新增各 10、命中总数不变', () => {
    const baselineMiss = (lx: number, ly: number) => ly === 0 && lx <= 9;
    const recheckMiss = (lx: number, ly: number) => ly === 0 && lx >= 20 && lx <= 29;
    const baseline = makeComparisonPixels([baselineMiss, noMiss, noMiss, noMiss]);
    const recheck = makeComparisonPixels([recheckMiss, noMiss, noMiss, noMiss]);

    const cmp = comparePixels(baseline, recheck, IMAGE_SIZE, IMAGE_SIZE);
    const d = cmp.zones[0];

    // 两次都恰好缺 10 个像素，判定均为角标存在，命中增减为 0
    expect(d.baseline.hits).toBe(1014);
    expect(d.recheck.hits).toBe(1014);
    expect(d.baseline.present).toBe(true);
    expect(d.recheck.present).toBe(true);
    expect(d.hitDelta).toBe(0);
    expect(d.recovered).toBe(10);
    expect(d.newGaps).toBe(10);
    expect(d.unchangedHits).toBe(1004);
    expect(d.unchangedMisses).toBe(0);

    // 按相同原始坐标逐像素分类（k = ly*32 + lx）
    for (let lx = 0; lx <= 9; lx += 1) expect(d.classes[lx]).toBe(DIFF_RECOVERED);
    for (let lx = 10; lx <= 19; lx += 1) expect(d.classes[lx]).toBe(DIFF_SAME_HIT);
    for (let lx = 20; lx <= 29; lx += 1) expect(d.classes[lx]).toBe(DIFF_NEW_GAP);
    for (let lx = 30; lx <= 31; lx += 1) expect(d.classes[lx]).toBe(DIFF_SAME_HIT);
    // 第二行起全部两次均命中
    expect(d.classes[32]).toBe(DIFF_SAME_HIT);

    // 其他区无变化
    for (const i of [1, 2, 3]) {
      expect(cmp.zones[i].recovered).toBe(0);
      expect(cmp.zones[i].newGaps).toBe(0);
    }
  });

  it('新增缺失：基准满命中、复检末 205 像素缺失 → 新增 205、无恢复，复检转不合格', () => {
    const baseline = makeComparisonPixels([noMiss, noMiss, noMiss, noMiss]);
    const missTail = (lx: number, ly: number) => ly * 32 + lx >= 819;
    const recheck = makeComparisonPixels([noMiss, missTail, noMiss, noMiss]);

    const cmp = comparePixels(baseline, recheck, IMAGE_SIZE, IMAGE_SIZE);
    expect(cmp.baseline.passed).toBe(true);
    expect(cmp.recheck.passed).toBe(false);

    const d = cmp.zones[1];
    expect(d.hitDelta).toBe(-205);
    expect(d.recovered).toBe(0);
    expect(d.newGaps).toBe(205);
    expect(d.unchangedHits).toBe(819);
    expect(d.unchangedMisses).toBe(0);
    expect(d.classes[819]).toBe(DIFF_NEW_GAP);
    expect(d.classes[1023]).toBe(DIFF_NEW_GAP);
  });

  it('同一位置持续未命中计为两次均缺失，不与恢复/新增混淆', () => {
    const sameMiss = (lx: number, ly: number) => ly === 0 && lx <= 4;
    const px = makeComparisonPixels([sameMiss, noMiss, noMiss, noMiss]);

    const d = comparePixels(px, px, IMAGE_SIZE, IMAGE_SIZE).zones[0];
    expect(d.recovered).toBe(0);
    expect(d.newGaps).toBe(0);
    expect(d.unchangedMisses).toBe(5);
    expect(d.unchangedHits).toBe(1019);
    for (let lx = 0; lx <= 4; lx += 1) expect(d.classes[lx]).toBe(DIFF_SAME_MISS);
    expect(d.classes[5]).toBe(DIFF_SAME_HIT);
  });

  it('检测区外的像素变化不计入任何区的对比统计', () => {
    // 基准：检测区全品红、区外全白；复检：整图（含区外）品红
    const baseline = makePixels((x, y) =>
      ZONES.some((_, i) => inZone(x, y, i)) ? MAGENTA : WHITE,
    );
    const recheck = makePixels(() => MAGENTA);

    const cmp = comparePixels(baseline, recheck, IMAGE_SIZE, IMAGE_SIZE);
    for (const d of cmp.zones) {
      expect(d.unchangedHits).toBe(ZONE_PIXELS);
      expect(d.recovered).toBe(0);
      expect(d.newGaps).toBe(0);
      expect(d.hitDelta).toBe(0);
    }
  });

  it('buildZoneDiffRgba 按分类图给出差异图配色', () => {
    const baselineMiss = (lx: number, ly: number) => ly === 0 && lx <= 9;
    const recheckMiss = (lx: number, ly: number) => ly === 0 && lx >= 20 && lx <= 29;
    const baseline = makeComparisonPixels([baselineMiss, noMiss, noMiss, noMiss]);
    const recheck = makeComparisonPixels([recheckMiss, noMiss, noMiss, noMiss]);
    const d = comparePixels(baseline, recheck, IMAGE_SIZE, IMAGE_SIZE).zones[0];

    const rgba = buildZoneDiffRgba(d);
    const at = (k: number) => Array.from(rgba.slice(k * 4, k * 4 + 4));
    expect(at(0)).toEqual([...DIFF_COLORS.recovered]);
    expect(at(10)).toEqual([...DIFF_COLORS['same-hit']]);
    expect(at(20)).toEqual([...DIFF_COLORS['new-gap']]);
  });

  it('尺寸不符时抛出异常', () => {
    const bad = new Uint8ClampedArray(4);
    expect(() => comparePixels(bad, bad, 1, 1)).toThrow(/1024×1024/);
  });
});
