import { expect, test } from '@playwright/test';
import { IMAGE_SIZE, ZONES } from '../src/lib/detect';
import { buildTestPng, type Rgba } from './helpers/png';

const MAGENTA: Rgba = [255, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const GREEN: Rgba = [16, 185, 129, 255];
const RED: Rgba = [224, 36, 36, 255];

const TR = ZONES[1];
const TL = ZONES[0];

function inAnyZone(x: number, y: number): boolean {
  return ZONES.some((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
}

/**
 * 固定的不合格基准：右上区恰好 819 命中（按局部序末 205 像素置白），
 * 其余三个检测区满命中，检测区外全白。
 */
const failingBaselinePng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) => {
  if (x >= TR.x0 && x <= TR.x1 && y >= TR.y0 && y <= TR.y1) {
    const n = (y - TR.y0) * (TR.x1 - TR.x0 + 1) + (x - TR.x0);
    return n < 819 ? MAGENTA : WHITE;
  }
  return inAnyZone(x, y) ? MAGENTA : WHITE;
});

/** 改善后的复检图：四个检测区全部满命中（右上 205 个缺口全部修复） */
const improvedPng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) =>
  inAnyZone(x, y) ? MAGENTA : WHITE,
);

/** 缺口转移复检图：左上区 10 个缺口从局部顶行 0–9 平移到 20–29（仍满阈值） */
const transferredPng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) => {
  if (x >= TL.x0 && x <= TL.x1 && y === TL.y0) {
    const lx = x - TL.x0;
    return lx >= 20 && lx <= 29 ? WHITE : MAGENTA;
  }
  return inAnyZone(x, y) ? MAGENTA : WHITE;
});

/** 与固定基准配套：基准左上区顶行 0–9 缺 10 像素 */
const transferredBaselinePng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) => {
  if (x >= TL.x0 && x <= TL.x1 && y === TL.y0) {
    return x - TL.x0 <= 9 ? WHITE : MAGENTA;
  }
  return inAnyZone(x, y) ? MAGENTA : WHITE;
});

const wrongSizePng = buildTestPng(512, 512, () => MAGENTA);
const corruptPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('truncated-png-content'),
]);
const notPng = Buffer.from('<!doctype html><p>not an image</p>');

async function uploadBaseline(
  page: import('@playwright/test').Page,
  buffer: Buffer,
  name = 'baseline.png',
) {
  await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'image/png', buffer });
}

async function uploadRecheck(
  page: import('@playwright/test').Page,
  buffer: Buffer,
  name = 'recheck.png',
) {
  await page.getByTestId('recheck-input').setInputFiles({ name, mimeType: 'image/png', buffer });
}

/** 读取差异图画布上某个局部像素（0–31 坐标）的 RGBA */
async function diffPixel(
  page: import('@playwright/test').Page,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  return page.$eval(
    '[data-testid="review-diff-crop"]',
    (el, point) => {
      const canvas = el as HTMLCanvasElement;
      const d = canvas.getContext('2d')!.getImageData(point.x, point.y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    { x, y },
  );
}

/** 统计差异图中各类颜色像素数 */
async function diffColorCounts(page: import('@playwright/test').Page) {
  return page.$eval('[data-testid="review-diff-crop"]', (el) => {
    const canvas = el as HTMLCanvasElement;
    const data = canvas.getContext('2d')!.getImageData(0, 0, 32, 32).data;
    const counts = { magenta: 0, white: 0, green: 0, red: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r === 255 && g === 0 && b === 255) counts.magenta += 1;
      else if (r === 255 && g === 255 && b === 255) counts.white += 1;
      else if (r === 16 && g === 185 && b === 129) counts.green += 1;
      else if (r === 224 && g === 36 && b === 36) counts.red += 1;
    }
    return counts;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('固定不合格基准 → 上传改善图 → 查看差异图 → 取消对比', () => {
  test('首张有效图固定为基准并进入待复检阶段，未启用对比时原判定与缺口审阅保持可用', async ({
    page,
  }) => {
    await uploadBaseline(page, failingBaselinePng);

    // 基准判定与原有四区展示不变
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('verdict')).toContainText('右上');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
    // 此时尚无复检判定
    await expect(page.getByTestId('verdict-recheck')).toHaveCount(0);

    // 基准固定后进入待复检阶段，复检入口可用
    const bar = page.getByTestId('recheck-bar');
    await expect(bar).toBeVisible();
    await expect(page.getByTestId('recheck-status')).toHaveText('待复检');
    await expect(page.getByTestId('recheck-input')).toBeAttached();

    // 未启用对比时，点选方位仍是原来的缺口审阅（原始裁片 + 包围范围 + 四边计数）
    await page.getByTestId('zone-top-right').click();
    const review = page.getByTestId('review');
    await expect(review).toBeVisible();
    await expect(page.getByTestId('review-crop')).toBeVisible();
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
    );
    await expect(page.getByTestId('review-diff-crop')).toHaveCount(0);
  });

  test('上传改善图后保留两次判定，并按方位展示命中增减、恢复命中与新增缺失', async ({
    page,
  }) => {
    await uploadBaseline(page, failingBaselinePng);
    await uploadRecheck(page, improvedPng);

    // 进入完成对比阶段
    await expect(page.getByTestId('recheck-status')).toHaveText('已完成对比');
    await expect(page.getByTestId('recheck-cancel')).toBeVisible();

    // 两次判定同时保留：基准仍不合格，复检合格
    const baselineVerdict = page.getByTestId('verdict');
    await expect(baselineVerdict).toContainText('调整前基准');
    await expect(baselineVerdict).toContainText('不合格');
    const recheckVerdict = page.getByTestId('verdict-recheck');
    await expect(recheckVerdict).toContainText('复检结果');
    await expect(recheckVerdict).toContainText('合格');

    // 右上区：命中 +205、恢复 205、无新增缺失；复检命中 1024
    await expect(page.getByTestId('zone-top-right-delta')).toHaveText('命中+205（1024 / 1024）');
    await expect(page.getByTestId('zone-top-right-recovered')).toHaveText('恢复命中 205');
    await expect(page.getByTestId('zone-top-right-newgaps')).toHaveText('新增缺失 0');

    // 方位卡片明确区分两次判定：右上基准缺失、复检存在（不合格基准 + 满命中复检）
    await expect(page.getByTestId('zone-top-right-status')).toHaveText('基准缺失');
    await expect(page.getByTestId('zone-top-right-recheck-status')).toHaveText('复检存在');
    // 基准命中数带「基准」前缀，不与复检满命中混排
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('基准命中 819 / 1024');
    // 其余三区两次判定均为存在
    for (const id of ['top-left', 'bottom-left', 'bottom-right'] as const) {
      await expect(page.getByTestId(`zone-${id}-status`)).toHaveText('基准存在');
      await expect(page.getByTestId(`zone-${id}-recheck-status`)).toHaveText('复检存在');
    }

    // 两张上下排列的预览图均有可见标识，可直接区分调整前基准与复检结果
    const baselineTag = page.getByTestId('preview-tag-baseline');
    const recheckTag = page.getByTestId('preview-tag-recheck');
    await expect(baselineTag).toBeVisible();
    await expect(baselineTag).toHaveText('调整前（基准）');
    await expect(recheckTag).toBeVisible();
    await expect(recheckTag).toHaveText('复检结果');
    const baselineImg = page.locator('[data-testid="preview-baseline"] img');
    const recheckImg = page.locator('[data-testid="preview-recheck"] img');
    const baselineBox = await baselineImg.boundingBox();
    const recheckBox = await recheckImg.boundingBox();
    expect(baselineBox).not.toBeNull();
    expect(recheckBox).not.toBeNull();
    // 复检图排在基准图下方；标签分别落在各自预览范围内
    expect(recheckBox!.y).toBeGreaterThan(baselineBox!.y + baselineBox!.height - 1);
    const tagBox = await recheckTag.boundingBox();
    expect(tagBox!.y).toBeGreaterThanOrEqual(recheckBox!.y - 1);
    expect(tagBox!.y).toBeLessThanOrEqual(recheckBox!.y + 40);

    // 其余三区无变化
    for (const id of ['top-left', 'bottom-left', 'bottom-right'] as const) {
      await expect(page.getByTestId(`zone-${id}-delta`)).toHaveText('命中+0（1024 / 1024）');
      await expect(page.getByTestId(`zone-${id}-recovered`)).toHaveText('恢复命中 0');
      await expect(page.getByTestId(`zone-${id}-newgaps`)).toHaveText('新增缺失 0');
    }

    // 复检预览同时出现
    await expect(page.getByTestId('preview-recheck')).toBeVisible();
  });

  test('点选方位查看右上 32×32 差异图：修复缺口为绿色恢复命中，逐像素统计与卡片一致', async ({
    page,
  }) => {
    await uploadBaseline(page, failingBaselinePng);
    await uploadRecheck(page, improvedPng);
    await page.getByTestId('zone-top-right').click();

    // 审阅区从原缺口审阅切换为差异证据
    const review = page.getByTestId('review');
    await expect(review).toContainText('复检前后差异证据');
    await expect(page.getByTestId('review-diff-crop')).toBeVisible();
    await expect(page.getByTestId('review-crop')).toHaveCount(0);
    await expect(page.getByTestId('review-diff-summary')).toHaveText(
      '基准命中 819 → 复检命中 1024（增加 205）',
    );
    await expect(page.getByTestId('review-diff-recovered')).toHaveText('恢复命中：205 像素');
    await expect(page.getByTestId('review-diff-newgaps')).toHaveText('新增缺失：0 像素');
    await expect(page.getByTestId('review-diff-unchanged-hit')).toHaveText('两次均命中：819 像素');
    await expect(page.getByTestId('review-diff-unchanged-miss')).toHaveText('两次均缺失：0 像素');

    // 图例齐全
    for (const testid of [
      'diff-legend-same-hit',
      'diff-legend-same-miss',
      'diff-legend-recovered',
      'diff-legend-new-gap',
    ]) {
      await expect(page.getByTestId(testid)).toBeVisible();
    }

    // 819 个命中位置：局部 (18,25) 为最后一批品红（两次均命中），(19,25) 起为绿色恢复
    expect(await diffPixel(page, 18, 25)).toEqual([...MAGENTA]);
    expect(await diffPixel(page, 19, 25)).toEqual([...GREEN]);
    expect(await diffPixel(page, 31, 31)).toEqual([...GREEN]);

    const counts = await diffColorCounts(page);
    expect(counts).toEqual({ magenta: 819, white: 0, green: 205, red: 0 });

    // 切换到无变化的左上区：差异图全部为两次均命中
    await page.getByTestId('zone-top-left').click();
    await expect(page.getByTestId('review-diff-summary')).toHaveText(
      '基准命中 1024 → 复检命中 1024（无增减）',
    );
    expect(await diffColorCounts(page)).toEqual({ magenta: 1024, white: 0, green: 0, red: 0 });
  });

  test('点选复检图上的右上检测框可切换方位并展示对应差异证据', async ({ page }) => {
    await uploadBaseline(page, failingBaselinePng);
    await uploadRecheck(page, improvedPng);

    // 完成对比前未选方位，审阅区不出现
    await expect(page.getByTestId('review')).toHaveCount(0);

    // 复检图（下方第二张预览）上的右上检测框可点选，而非仅作静态展示
    const recheckTrBox = page.getByTestId('recheck-zone-box-top-right');
    await expect(recheckTrBox).toBeVisible();
    await recheckTrBox.click();

    const review = page.getByTestId('review');
    await expect(review).toBeVisible();
    await expect(review).toContainText('右上检测区 · 复检前后差异证据');
    await expect(page.getByTestId('review-diff-crop')).toBeVisible();
    await expect(page.getByTestId('review-diff-summary')).toHaveText(
      '基准命中 819 → 复检命中 1024（增加 205）',
    );
    // 复检图与基准图上的右上框同步呈现选中态
    await expect(recheckTrBox).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('zone-box-top-right')).toHaveAttribute('aria-pressed', 'true');

    // 点选复检图上的左上框可切换方位
    await page.getByTestId('recheck-zone-box-top-left').click();
    await expect(review).toContainText('左上检测区 · 复检前后差异证据');
    await expect(page.getByTestId('review-diff-summary')).toHaveText(
      '基准命中 1024 → 复检命中 1024（无增减）',
    );
    await expect(page.getByTestId('recheck-zone-box-top-left')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('recheck-zone-box-top-right')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('键盘可操作复检图上的检测框，激活后焦点进入差异审阅区', async ({ page }) => {
    await uploadBaseline(page, failingBaselinePng);
    await uploadRecheck(page, improvedPng);

    await page.getByTestId('recheck-zone-box-top-right').focus();
    await page.keyboard.press('Enter');

    const review = page.getByTestId('review');
    await expect(review).toBeVisible();
    await expect(review).toBeFocused();
    await expect(review).toContainText('右上检测区 · 复检前后差异证据');
  });

  test('取消对比后回到当前单图结果：复检内容移除、基准判定与缺口审阅仍可用', async ({
    page,
  }) => {
    await uploadBaseline(page, failingBaselinePng);
    await uploadRecheck(page, improvedPng);
    await page.getByTestId('zone-top-right').click();
    await expect(page.getByTestId('review-diff-crop')).toBeVisible();

    await page.getByTestId('recheck-cancel').click();

    // 回到待复检阶段：复检判定、逐区增减、差异图、复检预览全部移除
    await expect(page.getByTestId('verdict-recheck')).toHaveCount(0);
    await expect(page.getByTestId('recheck-status')).toHaveText('待复检');
    await expect(page.getByTestId('zone-top-right-diff')).toHaveCount(0);
    await expect(page.getByTestId('preview-recheck')).toHaveCount(0);
    await expect(page.getByTestId('review-diff-crop')).toHaveCount(0);

    // 基准判定与命中数原样保留
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');

    // 选区回到原始缺口审阅
    await expect(page.getByTestId('review')).toBeVisible();
    await expect(page.getByTestId('review-crop')).toBeVisible();
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
    );

    // 可再次点选其他方位查看原始裁片
    await page.getByTestId('zone-top-left').click();
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：无缺口（1024 个像素全部命中）',
    );
  });
});

test.describe('复检恶化时方位卡片明确区分两次判定', () => {
  test('基准满命中、复检右上缺口：右上卡片同时显示基准存在与复检缺失', async ({ page }) => {
    await uploadBaseline(page, improvedPng);
    await expect(page.getByTestId('verdict')).toContainText('合格');
    await uploadRecheck(page, failingBaselinePng);

    // 两次判定方向相反：基准合格、复检不合格
    await expect(page.getByTestId('verdict-baseline')).toBeVisible();
    const recheckVerdict = page.getByTestId('verdict-recheck');
    await expect(recheckVerdict).toContainText('不合格');
    await expect(recheckVerdict).toContainText('右上');

    // 右上卡片：基准存在但复检缺失，命中数分别标注，不得只显示一个含糊的「缺失」
    await expect(page.getByTestId('zone-top-right-status')).toHaveText('基准存在');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('基准命中 1024 / 1024');
    await expect(page.getByTestId('zone-top-right-recheck-status')).toHaveText('复检缺失');
    await expect(page.getByTestId('zone-top-right-delta')).toContainText('命中-205');
    await expect(page.getByTestId('zone-top-right-newgaps')).toHaveText('新增缺失 205');
    // 基准存在时不展示基准未达标原因
    await expect(page.getByTestId('zone-top-right-reason')).toHaveCount(0);

    // 未受影响的方位两次判定都为存在
    await expect(page.getByTestId('zone-top-left-status')).toHaveText('基准存在');
    await expect(page.getByTestId('zone-top-left-recheck-status')).toHaveText('复检存在');
  });
});

test.describe('复检图失败时指出原失败阶段并保留基准', () => {
  test.beforeEach(async ({ page }) => {
    await uploadBaseline(page, failingBaselinePng);
    await expect(page.getByTestId('verdict')).toContainText('不合格');
  });

  test('非 PNG：指出格式校验阶段失败，基准保留且可重新选择', async ({ page }) => {
    await uploadRecheck(page, notPng, 'fake.png');

    const error = page.getByTestId('recheck-error');
    await expect(error).toContainText('格式不支持');
    await expect(error).toContainText('格式校验阶段失败');
    await expect(error).toContainText('基准图已保留');

    // 基准判定与待复检入口仍在
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('recheck-status')).toHaveText('待复检');
    await expect(page.getByTestId('verdict-recheck')).toHaveCount(0);
  });

  test('损坏 PNG：指出图像解码阶段失败', async ({ page }) => {
    await uploadRecheck(page, corruptPng, 'corrupt.png');
    const error = page.getByTestId('recheck-error');
    await expect(error).toContainText('解码失败');
    await expect(error).toContainText('图像解码阶段失败');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
  });

  test('尺寸不符：指出尺寸校验阶段失败并给出实际尺寸', async ({ page }) => {
    await uploadRecheck(page, wrongSizePng, 'small.png');
    const error = page.getByTestId('recheck-error');
    await expect(error).toContainText('尺寸不符');
    await expect(error).toContainText('尺寸校验阶段失败');
    await expect(error).toContainText('512×512');
    await expect(page.getByTestId('verdict')).toContainText('不合格');
  });

  test('取样失败：指出像素取样阶段失败；恢复后仍可完成复检（基准未被替换）', async ({
    page,
  }) => {
    // 基准已完成检测后再让后续 Canvas 上下文创建失败，仅影响复检取样
    await page.evaluate(() => {
      const proto = HTMLCanvasElement.prototype;
      const w = window as unknown as { __origGetContext?: typeof proto.getContext };
      w.__origGetContext = proto.getContext;
      proto.getContext = (function (this: HTMLCanvasElement) {
        return null;
      } as typeof proto.getContext);
    });

    await uploadRecheck(page, improvedPng);
    const error = page.getByTestId('recheck-error');
    await expect(error).toContainText('像素取样阶段失败');
    // 基准与原缺口审阅不受取样失败影响
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');

    // 恢复环境后重新选择复检图即可完成对比
    await page.evaluate(() => {
      const w = window as unknown as { __origGetContext?: typeof HTMLCanvasElement.prototype.getContext };
      if (w.__origGetContext) HTMLCanvasElement.prototype.getContext = w.__origGetContext;
    });
    await uploadRecheck(page, improvedPng, 'recheck-fixed.png');
    await expect(page.getByTestId('recheck-error')).toHaveCount(0);
    await expect(page.getByTestId('recheck-status')).toHaveText('已完成对比');
    await expect(page.getByTestId('verdict-recheck')).toContainText('合格');
    await expect(page.getByTestId('zone-top-right-recovered')).toHaveText('恢复命中 205');
  });
});

test.describe('缺口转移：恢复命中与新增缺失同时存在', () => {
  test('左上缺口平移：恢复 10、新增 10、命中总数不变，差异图红绿各 10', async ({ page }) => {
    await uploadBaseline(page, transferredBaselinePng);
    await uploadRecheck(page, transferredPng);

    // 两次判定都合格（缺口仅 10 个，均在阈值之上）
    await expect(page.getByTestId('verdict')).toContainText('合格');
    await expect(page.getByTestId('verdict-recheck')).toContainText('合格');

    await expect(page.getByTestId('zone-top-left-delta')).toHaveText('命中+0（1014 / 1024）');
    await expect(page.getByTestId('zone-top-left-recovered')).toHaveText('恢复命中 10');
    await expect(page.getByTestId('zone-top-left-newgaps')).toHaveText('新增缺失 10');
    // 右上区不参与转移
    await expect(page.getByTestId('zone-top-right-recovered')).toHaveText('恢复命中 0');
    await expect(page.getByTestId('zone-top-right-newgaps')).toHaveText('新增缺失 0');

    await page.getByTestId('zone-top-left').click();
    await expect(page.getByTestId('review-diff-summary')).toContainText('基准命中 1014 → 复检命中 1014');
    await expect(page.getByTestId('review-diff-summary')).toContainText('无增减');
    await expect(page.getByTestId('review-diff-recovered')).toHaveText('恢复命中：10 像素');
    await expect(page.getByTestId('review-diff-newgaps')).toHaveText('新增缺失：10 像素');

    // 顶行局部 0–9 为绿色恢复，10–19 品红，20–29 红色新增，30–31 品红
    expect(await diffPixel(page, 0, 0)).toEqual([...GREEN]);
    expect(await diffPixel(page, 9, 0)).toEqual([...GREEN]);
    expect(await diffPixel(page, 10, 0)).toEqual([...MAGENTA]);
    expect(await diffPixel(page, 19, 0)).toEqual([...MAGENTA]);
    expect(await diffPixel(page, 20, 0)).toEqual([...RED]);
    expect(await diffPixel(page, 29, 0)).toEqual([...RED]);
    expect(await diffPixel(page, 30, 0)).toEqual([...MAGENTA]);
    const counts = await diffColorCounts(page);
    expect(counts).toEqual({ magenta: 1004, white: 0, green: 10, red: 10 });
  });
});
