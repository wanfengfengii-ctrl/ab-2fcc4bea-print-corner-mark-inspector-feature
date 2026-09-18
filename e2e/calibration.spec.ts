import { expect, test } from '@playwright/test';
import {
  CALIBRATION_CELL_SIZE,
  CALIBRATION_GRID_SIZE,
  CALIBRATION_IMAGE_SIZE,
} from '../src/lib/calibration';
import { IMAGE_SIZE, ZONES } from '../src/lib/detect';
import { buildTestPng, type Rgba } from './helpers/png';

const WHITE: Rgba = [255, 255, 255, 255];
const MAGENTA: Rgba = [255, 0, 255, 255];

/** 像素坐标所属的固定格序索引（先行后列，0 为左上） */
function cellIndexAt(x: number, y: number): number {
  return (
    Math.floor(y / CALIBRATION_CELL_SIZE) * CALIBRATION_GRID_SIZE +
    Math.floor(x / CALIBRATION_CELL_SIZE)
  );
}

function inVerifyZone(x: number, y: number): boolean {
  return ZONES.some((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
}

/** 均匀 128 中性灰校准图 */
const uniformGrayPng = buildTestPng(
  CALIBRATION_IMAGE_SIZE,
  CALIBRATION_IMAGE_SIZE,
  () => [128, 128, 128, 255] as Rgba,
);

/** 左上角单格暗角：#0 格灰度 110，其余 128（极差 18 > 12，RGB 均值仍在 112–144） */
const vignettePng = buildTestPng(
  CALIBRATION_IMAGE_SIZE,
  CALIBRATION_IMAGE_SIZE,
  (x, y) => {
    const v = cellIndexAt(x, y) === 0 ? 110 : 128;
    return [v, v, v, 255];
  },
);

/** 整体偏色：均匀的偏暖灰（R 150 超上限） */
const colorCastPng = buildTestPng(
  CALIBRATION_IMAGE_SIZE,
  CALIBRATION_IMAGE_SIZE,
  () => [150, 120, 120, 255] as Rgba,
);

/** 核验页用：右上区恰好 819 命中，其余区满命中 */
const TR = ZONES[1];
const almostPng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) => {
  if (x >= TR.x0 && x <= TR.x1 && y >= TR.y0 && y <= TR.y1) {
    const n = (y - TR.y0) * (TR.x1 - TR.x0 + 1) + (x - TR.x0);
    return n < 819 ? MAGENTA : WHITE;
  }
  return inVerifyZone(x, y) ? MAGENTA : WHITE;
});

/** 核验页用：合格图 */
const verifyOkPng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) =>
  inVerifyZone(x, y) ? MAGENTA : WHITE,
);

const wrongSizePng = buildTestPng(512, 512, () => [128, 128, 128, 255] as Rgba);
const corruptPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('truncated-png-content'),
]);
const notPng = Buffer.from('<!doctype html><p>not an image</p>');

async function chooseCalFile(page: import('@playwright/test').Page, name: string, buffer: Buffer) {
  await page
    .getByTestId('cal-file-input')
    .setInputFiles({ name, mimeType: 'image/png', buffer });
}

async function uploadVerifyFile(page: import('@playwright/test').Page, name: string, buffer: Buffer) {
  await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'image/png', buffer });
}

/** 读取全部 64 格的 data-luma 数值（DOM 顺序即固定格序 0–63，先行后列） */
async function readCellLumas(page: import('@playwright/test').Page): Promise<number[]> {
  return page.$$eval('[data-testid^="cal-cell-"]', (els) =>
    (els as HTMLElement[]).map((el) => Number(el.dataset.luma)),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('扫描照明校准工作台', () => {
  test.beforeEach(async ({ page }) => {
    await page.getByTestId('nav-calibration').click();
  });

  test('入口初始为“未选择”，显示上传区与入口提示', async ({ page }) => {
    await expect(page.getByTestId('cal-status')).toHaveText('未选择');
    await expect(page.getByTestId('cal-entry')).toBeVisible();
    await expect(page.getByTestId('cal-verdict')).toHaveCount(0);
    await expect(page.getByTestId('cal-heatmap')).toHaveCount(0);
  });

  test('均匀灰图生成通过报告：RGB 均值 128、极差 0、64 格热力图齐全', async ({ page }) => {
    await chooseCalFile(page, 'gray.png', uniformGrayPng);

    await expect(page.getByTestId('cal-status')).toHaveText('已完成');
    await expect(page.getByTestId('cal-verdict')).toHaveText('照明校准通过');
    await expect(page.getByTestId('cal-mean-rgb')).toContainText('R 128.00 / G 128.00 / B 128.00');
    await expect(page.getByTestId('cal-range')).toContainText('极差：0.00');
    await expect(page.getByTestId('cal-conclusion')).toContainText('校准通过');
    await expect(page.getByTestId('cal-error')).toHaveCount(0);

    const cells = page.getByTestId(/^cal-cell-\d+$/);
    await expect(cells).toHaveCount(64);
    const lumas = await readCellLumas(page);
    expect(lumas).toHaveLength(64);
    for (const luma of lumas) {
      expect(luma).toBeCloseTo(128, 4);
    }
    // 固定格序：#0 为左上、#63 为右下
    await expect(page.getByTestId('cal-cell-0')).toBeVisible();
    await expect(page.getByTestId('cal-cell-63')).toBeVisible();
  });

  test('单格暗角：热力图左上角偏暗、极差 18，并给出暗角不通过结论', async ({ page }) => {
    await chooseCalFile(page, 'vignette.png', vignettePng);

    await expect(page.getByTestId('cal-status')).toHaveText('已完成');
    await expect(page.getByTestId('cal-verdict')).toHaveText('照明校准不通过');

    await expect(page.getByTestId('cal-range')).toContainText('极差：18.00');
    await expect(page.getByTestId('cal-range')).toContainText('最暗格 #0 110.00');
    await expect(page.getByTestId('cal-range')).toContainText('最亮格 #1 128.00');
    // RGB 均值约 127.72，仍在 112–144 区间，因此唯一问题是暗角
    await expect(page.getByTestId('cal-mean-rgb')).toContainText('127.72');
    await expect(page.getByTestId('cal-mean-rgb')).toContainText('均在 112–144 区间');
    await expect(page.getByTestId('cal-conclusion')).toContainText('暗角');
    await expect(page.getByTestId('cal-failures')).toContainText('超过上限 12');

    // 热力图可用于定位暗角：#0 格亮度显著低于其余各格
    const cell0Luma = Number((await page.getByTestId('cal-cell-0').getAttribute('data-luma')));
    expect(cell0Luma).toBeCloseTo(110, 4);
    const cell7Luma = Number((await page.getByTestId('cal-cell-7').getAttribute('data-luma')));
    expect(cell7Luma).toBeCloseTo(128, 4);

    // #0 格配色应明显比中部格暗（背景亮度更低）
    const bg0 = await page.getByTestId('cal-cell-0').evaluate((el) => getComputedStyle(el).backgroundColor);
    const bg31 = await page.getByTestId('cal-cell-31').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg0).not.toBe(bg31);
  });

  test('整体偏色图：极差为 0 仍不通过，结论指出偏色', async ({ page }) => {
    await chooseCalFile(page, 'cast.png', colorCastPng);
    await expect(page.getByTestId('cal-verdict')).toHaveText('照明校准不通过');
    await expect(page.getByTestId('cal-range')).toContainText('极差：0.00');
    await expect(page.getByTestId('cal-conclusion')).toContainText('偏色');
    await expect(page.getByTestId('cal-failures')).toContainText('R 通道均值 150.00');
  });

  test('非 PNG 指出“签名校验”阶段且不残留报告', async ({ page }) => {
    await chooseCalFile(page, 'fake.png', notPng);
    const error = page.getByTestId('cal-error');
    await expect(error).toContainText('格式不支持');
    await expect(error).toContainText('签名校验');
    await expect(page.getByTestId('cal-status')).toHaveText('失败');
    await expect(page.getByTestId('cal-verdict')).toHaveCount(0);
    await expect(page.getByTestId('cal-heatmap')).toHaveCount(0);
  });

  test('尺寸不符指出“尺寸校验”阶段并移除旧报告，再选有效图片即可恢复', async ({ page }) => {
    await chooseCalFile(page, 'gray.png', uniformGrayPng);
    await expect(page.getByTestId('cal-verdict')).toHaveText('照明校准通过');

    await chooseCalFile(page, 'small.png', wrongSizePng);
    const error = page.getByTestId('cal-error');
    await expect(error).toContainText('尺寸不符');
    await expect(error).toContainText('尺寸校验');
    await expect(error).toContainText('512×512');
    // 旧报告被移除
    await expect(page.getByTestId('cal-verdict')).toHaveCount(0);
    await expect(page.getByTestId('cal-heatmap')).toHaveCount(0);
    await expect(page.getByTestId('cal-status')).toHaveText('失败');

    // 再选有效图片即恢复
    await chooseCalFile(page, 'gray2.png', uniformGrayPng);
    await expect(page.getByTestId('cal-status')).toHaveText('已完成');
    await expect(page.getByTestId('cal-verdict')).toHaveText('照明校准通过');
    await expect(page.getByTestId('cal-error')).toHaveCount(0);
  });

  test('无法解码指出“原生解码”阶段，随后重试有效图片成功', async ({ page }) => {
    await chooseCalFile(page, 'corrupt.png', corruptPng);
    const error = page.getByTestId('cal-error');
    await expect(error).toContainText('解码失败');
    await expect(error).toContainText('原生解码');
    await expect(page.getByTestId('cal-verdict')).toHaveCount(0);

    await chooseCalFile(page, 'vignette.png', vignettePng);
    await expect(page.getByTestId('cal-verdict')).toHaveText('照明校准不通过');
    await expect(page.getByTestId('cal-error')).toHaveCount(0);
  });

  test('分析中状态为“分析中”且禁止重复提交，完成后恢复可选', async ({ page }) => {
    // 挂起原生解码，使页面稳定停留在分析中；通过 window.__releaseDecode 放行
    await page.addInitScript(() => {
      const w = window as unknown as {
        __gate?: Promise<void>;
        __releaseDecode?: () => void;
      };
      w.__gate = new Promise<void>((resolve) => {
        w.__releaseDecode = resolve;
      });
      const orig = window.createImageBitmap.bind(window);
      window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
        await w.__gate;
        return orig(...args);
      }) as typeof createImageBitmap;
    });
    await page.reload();
    await page.getByTestId('nav-calibration').click();

    await chooseCalFile(page, 'gray.png', uniformGrayPng);
    await expect(page.getByTestId('cal-status')).toHaveText('分析中…');
    await expect(page.getByTestId('cal-progress')).toBeVisible();
    await expect(page.getByTestId('cal-file-input')).toBeDisabled();

    await page.evaluate(() => (window as unknown as { __releaseDecode: () => void }).__releaseDecode());
    await expect(page.getByTestId('cal-status')).toHaveText('已完成');
    await expect(page.getByTestId('cal-file-input')).toBeEnabled();
  });

  test('校准工作台不影响核验页：返回核验页时原图片、判定与已选证据仍保持可用', async ({
    page,
  }) => {
    // beforeEach 已切到校准工作台，先返回核验页开始本用例
    await page.getByTestId('nav-verify').click();

    // 1) 在核验页上传 819 不合格图并打开右上证据
    await uploadVerifyFile(page, 'almost.png', almostPng);
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await page.getByTestId('zone-top-right').click();
    await expect(page.getByTestId('review')).toBeVisible();
    await expect(page.getByTestId('review-gap-bounds')).toContainText('x 976–1007');
    await expect(page.getByTestId('review-crop')).toBeVisible();

    // 2) 进入独立的照明校准工作台并完成一次暗角分析
    await page.getByTestId('nav-calibration').click();
    await expect(page.getByTestId('cal-entry')).toBeVisible();
    await chooseCalFile(page, 'vignette.png', vignettePng);
    await expect(page.getByTestId('cal-verdict')).toHaveText('照明校准不通过');

    // 3) 返回核验页：原上传图片、判定与已选证据原样保留
    await page.getByTestId('nav-verify').click();
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('verdict')).toContainText('右上');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
    await expect(page.getByTestId('preview')).toBeVisible();
    const review = page.getByTestId('review');
    await expect(review).toBeVisible();
    await expect(review).toContainText('右上');
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
    );
    await expect(page.getByTestId('review-crop')).toBeVisible();

    // 角标判定未被校准工作台改写
    await expect(page.getByTestId('zone-top-left-hits')).toHaveText('命中 1024 / 1024');
  });

  test('从核验页合格态进入校准再返回，核验合格态同样保持', async ({ page }) => {
    // beforeEach 已切到校准工作台，先返回核验页开始本用例
    await page.getByTestId('nav-verify').click();

    await uploadVerifyFile(page, 'ok.png', verifyOkPng);
    await expect(page.getByTestId('verdict')).toHaveText('合格');

    await page.getByTestId('nav-calibration').click();
    await expect(page.getByTestId('cal-status')).toHaveText('未选择');
    await page.getByTestId('nav-verify').click();

    await expect(page.getByTestId('verdict')).toHaveText('合格');
    for (const zone of ZONES) {
      await expect(page.getByTestId(`zone-${zone.id}-hits`)).toHaveText('命中 1024 / 1024');
    }
  });
});
