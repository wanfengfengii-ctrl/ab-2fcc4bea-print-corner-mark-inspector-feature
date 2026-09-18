import { expect, test } from '@playwright/test';
import { IMAGE_SIZE, ZONES } from '../src/lib/detect';
import { buildTestPng, type Rgba } from './helpers/png';

const MAGENTA: Rgba = [255, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];

function zoneIndexAt(x: number, y: number): number {
  return ZONES.findIndex((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
}

/** 合格图：四个检测区全部品红，其余白色 */
const validPng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) =>
  zoneIndexAt(x, y) >= 0 ? MAGENTA : WHITE,
);

/**
 * 右上区恰好 819 个命中；图像其余所有像素（含检测区外）均为品红。
 * 若实现错误地把区外像素计入，右上区命中数会超过 819。
 */
const TR = ZONES[1];
const almostPng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) => {
  if (x >= TR.x0 && x <= TR.x1 && y >= TR.y0 && y <= TR.y1) {
    const n = (y - TR.y0) * (TR.x1 - TR.x0 + 1) + (x - TR.x0);
    return n < 819 ? MAGENTA : WHITE;
  }
  return MAGENTA;
});

/** 尺寸不符的 PNG（512×512） */
const wrongSizePng = buildTestPng(512, 512, () => MAGENTA);

/** 文件头是 PNG 签名但内容损坏（无法解码） */
const corruptPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('truncated-png-content'),
]);

/** 完全不是 PNG 的文件 */
const notPng = Buffer.from('<!doctype html><p>not an image</p>');

async function upload(page: import('@playwright/test').Page, name: string, buffer: Buffer) {
  await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'image/png', buffer });
}

/** 读取审阅裁片画布上某个局部像素（0–31 坐标）的 RGBA */
async function cropPixel(
  page: import('@playwright/test').Page,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  return page.$eval(
    '[data-testid="review-crop"]',
    (el, point) => {
      const canvas = el as HTMLCanvasElement;
      const d = canvas.getContext('2d')!.getImageData(point.x, point.y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    { x, y },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('合格的 1024×1024 PNG 显示合格与四区命中数', async ({ page }) => {
  await upload(page, 'ok.png', validPng);

  await expect(page.getByTestId('verdict')).toHaveText('合格');
  await expect(page.getByTestId('upload-error')).toHaveCount(0);

  for (const zone of ZONES) {
    await expect(page.getByTestId(`zone-${zone.id}-hits`)).toHaveText('命中 1024 / 1024');
    await expect(page.getByTestId(`zone-box-${zone.id}`)).toBeVisible();
  }
});

test('任一区恰为 819 时显示不合格及对应方位，区外品红不补足计数', async ({ page }) => {
  await upload(page, 'almost.png', almostPng);

  const verdict = page.getByTestId('verdict');
  await expect(verdict).toContainText('不合格');
  await expect(verdict).toContainText('右上');

  await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
  await expect(page.getByTestId('zone-top-right-reason')).toContainText('819');
  await expect(page.getByTestId('zone-top-right-reason')).toContainText('820');

  // 其余三区虽然被整图品红包围，仍只统计各自闭区间内的 1024 个像素
  await expect(page.getByTestId('zone-top-left-hits')).toHaveText('命中 1024 / 1024');
  await expect(page.getByTestId('zone-bottom-left-hits')).toHaveText('命中 1024 / 1024');
  await expect(page.getByTestId('zone-bottom-right-hits')).toHaveText('命中 1024 / 1024');
});

test('非 PNG 文件给出明确反馈且无检测结果', async ({ page }) => {
  await upload(page, 'fake.png', notPng);

  await expect(page.getByTestId('upload-error')).toContainText('格式不支持');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
});

test('尺寸不符的 PNG 给出明确反馈', async ({ page }) => {
  await upload(page, 'small.png', wrongSizePng);

  const error = page.getByTestId('upload-error');
  await expect(error).toContainText('尺寸不符');
  await expect(error).toContainText('512×512');
  await expect(error).toContainText('1024×1024');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
});

test('无法解码的 PNG 给出明确反馈', async ({ page }) => {
  await upload(page, 'corrupt.png', corruptPng);

  await expect(page.getByTestId('upload-error')).toContainText('解码失败');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
});

test('上传错误后清除旧结果', async ({ page }) => {
  await upload(page, 'ok.png', validPng);
  await expect(page.getByTestId('verdict')).toHaveText('合格');

  await upload(page, 'small.png', wrongSizePng);
  await expect(page.getByTestId('upload-error')).toContainText('尺寸不符');
  await expect(page.getByTestId('verdict')).toHaveCount(0);
  await expect(page.getByTestId('zone-top-left')).toHaveCount(0);
});

test.describe('点选检测区查看像素级证据', () => {
  test.beforeEach(async ({ page }) => {
    // 统计浏览器原生解码次数：切换审阅选区只应复用已采样像素，不得重新解码
    await page.addInitScript(() => {
      const w = window as unknown as {
        __decodeCount?: number;
      };
      w.__decodeCount = 0;
      const orig = window.createImageBitmap.bind(window);
      window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
        w.__decodeCount = (w.__decodeCount ?? 0) + 1;
        return orig(...args);
      }) as typeof createImageBitmap;
    });
    // addInitScript 只对之后的导航生效，而外层 beforeEach 已先完成 goto，这里重载一次
    await page.reload();
  });

  test('819 像素的右上区：点选后显示 32×32 裁片与确定缺口范围，切换选区不重新解码', async ({
    page,
  }) => {
    await upload(page, 'almost.png', almostPng);
    await expect(page.getByTestId('verdict')).toContainText('不合格');

    // 未点选时不出现审阅区，原判定与四区展示保持兼容
    await expect(page.getByTestId('review')).toHaveCount(0);
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');

    // 点选右上检测卡片
    await page.getByTestId('zone-top-right').click();
    const review = page.getByTestId('review');
    await expect(review).toBeVisible();
    await expect(review).toContainText('右上');

    // 819 = 25 整行 + 第 26 行前 19 像素；其后 6 行整行缺失，
    // 唯一包围范围因此横跨检测区全宽 x 976–1007、y 41–47
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
    );
    await expect(page.getByTestId('review-edge-top')).toHaveText('上边缺口：0');
    await expect(page.getByTestId('review-edge-bottom')).toHaveText('下边缺口：32');
    await expect(page.getByTestId('review-edge-left')).toHaveText('左边缺口：6');
    await expect(page.getByTestId('review-edge-right')).toHaveText('右边缺口：7');

    // 32×32 裁片取的是原始像素：命中处品红、首个未命中处白色
    expect(await cropPixel(page, 0, 0)).toEqual([255, 0, 255, 255]);
    expect(await cropPixel(page, 18, 25)).toEqual([255, 0, 255, 255]);
    expect(await cropPixel(page, 19, 25)).toEqual([255, 255, 255, 255]);

    const decodeCountAfterOpen = await page.evaluate(
      () => (window as unknown as { __decodeCount: number }).__decodeCount,
    );
    expect(decodeCountAfterOpen).toBe(1);

    // 点预览框切换到满命中的左上区，审阅区只更新内容
    await page.getByTestId('zone-box-top-left').click();
    await expect(review).toContainText('左上');
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：无缺口（1024 个像素全部命中）',
    );
    expect(await cropPixel(page, 0, 0)).toEqual([255, 0, 255, 255]);

    // 再切回右上，数据仍来自同一次解码
    await page.getByTestId('zone-top-right').click();
    await expect(page.getByTestId('review-gap-bounds')).toContainText('x 976–1007');
    const decodeCountAfterSwitch = await page.evaluate(
      () => (window as unknown as { __decodeCount: number }).__decodeCount,
    );
    expect(decodeCountAfterSwitch).toBe(1);
  });

  test('新上传无效文件后审阅区与上一次选区一并消失', async ({ page }) => {
    await upload(page, 'almost.png', almostPng);
    await page.getByTestId('zone-top-right').click();
    await expect(page.getByTestId('review')).toBeVisible();
    await expect(page.getByTestId('review-crop')).toBeVisible();

    await upload(page, 'fake.png', notPng);
    await expect(page.getByTestId('upload-error')).toContainText('格式不支持');
    await expect(page.getByTestId('review')).toHaveCount(0);
    await expect(page.getByTestId('review-crop')).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('zone-top-right')).toHaveCount(0);
  });
});

test.describe('选区保持、键盘反馈与窄屏适配', () => {
  test('再次点选同一检测卡片，当前方位证据保持可见', async ({ page }) => {
    await upload(page, 'almost.png', almostPng);
    await page.getByTestId('zone-top-right').click();
    const review = page.getByTestId('review');
    await expect(review).toBeVisible();
    await expect(review).toContainText('右上');

    // 再次点选同一卡片：审阅区不消失，证据保持
    await page.getByTestId('zone-top-right').click();
    await expect(review).toBeVisible();
    await expect(review).toContainText('右上');
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
    );
    await expect(page.getByTestId('review-crop')).toBeVisible();

    // 预览框点选同样保持选中
    await page.getByTestId('zone-box-top-right').click();
    await expect(review).toBeVisible();
    await expect(review).toContainText('右上');
  });

  test('键盘回车打开证据后焦点进入审阅区，审阅区为实时播报区域', async ({ page }) => {
    await upload(page, 'almost.png', almostPng);

    await page.getByTestId('zone-top-right').focus();
    await page.keyboard.press('Enter');

    const review = page.getByTestId('review');
    await expect(review).toBeVisible();
    // 焦点移入审阅区，且审阅区作为 aria-live 区域向读屏播报新内容
    await expect(review).toBeFocused();
    await expect(review).toHaveAttribute('aria-live', 'polite');

    // 键盘切换到另一方位，焦点随更新后的审阅区移动
    await page.getByTestId('zone-top-left').focus();
    await page.keyboard.press('Enter');
    await expect(review).toBeFocused();
    await expect(review).toContainText('左上');
  });

  test('280px 窄屏下裁片完整适配审阅容器，页面无横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 280, height: 800 });
    await upload(page, 'almost.png', almostPng);
    await page.getByTestId('zone-top-right').click();

    const cropBox = await page.getByTestId('review-crop').boundingBox();
    const reviewBox = await page.getByTestId('review').boundingBox();
    expect(cropBox).not.toBeNull();
    expect(reviewBox).not.toBeNull();
    // 裁片完整落在审阅容器内，且保持正方形
    expect(cropBox!.x).toBeGreaterThanOrEqual(reviewBox!.x);
    expect(cropBox!.x + cropBox!.width).toBeLessThanOrEqual(reviewBox!.x + reviewBox!.width + 0.5);
    expect(Math.abs(cropBox!.width - cropBox!.height)).toBeLessThanOrEqual(1);

    // 页面整体无横向溢出
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(280);
  });

  test('宽屏下裁片保持 256px 最近邻放大展示', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await upload(page, 'almost.png', almostPng);
    await page.getByTestId('zone-top-right').click();
    const cropBox = await page.getByTestId('review-crop').boundingBox();
    expect(cropBox).not.toBeNull();
    expect(cropBox!.width).toBe(256);
    expect(cropBox!.height).toBe(256);
  });
});
