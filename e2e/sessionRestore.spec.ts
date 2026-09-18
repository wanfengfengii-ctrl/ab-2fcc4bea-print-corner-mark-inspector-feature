import { expect, test } from '@playwright/test';
import { IMAGE_SIZE, ZONES } from '../src/lib/detect';
import { buildTestPng, type Rgba } from './helpers/png';

const MAGENTA: Rgba = [255, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];

const TR = ZONES[1];

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

/** 满命中复检图：四个检测区全部品红 */
const fullHitPng = buildTestPng(IMAGE_SIZE, IMAGE_SIZE, (x, y) =>
  inAnyZone(x, y) ? MAGENTA : WHITE,
);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function uploadBaseline(
  page: import('@playwright/test').Page,
  buffer: Buffer,
  name = 'baseline.png',
) {
  await page.getByTestId('file-input').setInputFiles({ name, mimeType: 'image/png', buffer });
}

async function uploadRecheck(page: import('@playwright/test').Page, buffer: Buffer) {
  await page.getByTestId('recheck-input').setInputFiles({
    name: 'recheck.png',
    mimeType: 'image/png',
    buffer,
  });
}

/** 统计差异图中四类颜色像素数 */
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

/**
 * 让重新加载后的原生解码延迟 400ms，以便稳定观察“正在恢复”界面；
 * 判定仍完全来自真实解码与采样。
 */
async function slowDownDecode(page: import('@playwright/test').Page) {
  await page.context().addInitScript(() => {
    const origCreateImageBitmap = window.createImageBitmap;
    const slowed = async (...args: unknown[]): Promise<ImageBitmap> => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return (origCreateImageBitmap as (...a: unknown[]) => Promise<ImageBitmap>)(...args);
    };
    window.createImageBitmap = slowed as typeof createImageBitmap;
  });
}

/**
 * 直接向 IndexedDB 写入一条快照记录（用于注入损坏快照）。
 * 若 record 中含 __baselineBytes / __recheckBytes 数字数组，先在页面上下文内
 * 构造 ArrayBuffer（跨协议序列化后仍能通过 instanceof ArrayBuffer 校验）。
 */
async function seedSnapshot(
  page: import('@playwright/test').Page,
  record: Record<string, unknown>,
): Promise<void> {
  await page.goto('/');
  // 等应用自身的 IndexedDB 初始连接稳定，避免升级事务与种子写入相互竞态
  await page.getByTestId('file-input').waitFor();
  await page.waitForTimeout(300);
  await page.evaluate(
    (value) =>
      new Promise<void>((resolve, reject) => {
        const toBuffer = (bytes: unknown) => {
          const view = new Uint8Array((bytes as number[]).length);
          (bytes as number[]).forEach((b, i) => {
            view[i] = b;
          });
          return view.buffer;
        };
        if (Array.isArray(value.__baselineBytes)) {
          value.baselinePng = toBuffer(value.__baselineBytes);
          delete value.__baselineBytes;
        }
        const req = indexedDB.open('register-mark-verifier', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('verify-sessions')) {
            req.result.createObjectStore('verify-sessions');
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('verify-sessions', 'readwrite');
          tx.objectStore('verify-sessions').put(value, 'current');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    record,
  );
}

test.describe('刷新后自动恢复已保存的核验会话', () => {
  test('819 命中的不合格基准刷新后恢复：判定、命中数与已选方位审阅均回到刷新前', async ({
    page,
  }) => {
    await page.goto('/');
    await uploadBaseline(page, failingBaselinePng, 'baseline-819.png');
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await page.getByTestId('zone-top-right').click();
    await expect(page.getByTestId('review-gap-bounds')).toBeVisible();
    await expect(page.getByTestId('session-bar')).toBeVisible();

    await slowDownDecode(page);
    await page.reload();

    // 恢复期间核验页显示“正在恢复”，不露出上传入口或半成品结果
    await expect(page.getByTestId('recovery-loading')).toBeVisible();
    await expect(page.getByTestId('file-input')).toHaveCount(0);

    // 恢复成功后回到单图缺口审阅：无需重新选择图片
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('verdict')).toContainText('右上');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
    await expect(page.getByTestId('recheck-status')).toHaveText('待复检');
    await expect(page.locator('.file-name')).toContainText('baseline-819.png');

    // 已选方位一并恢复：右上缺口审阅（原始裁片，非差异图）
    const review = page.getByTestId('review');
    await expect(review).toBeVisible();
    await expect(review).toContainText('右上检测区');
    await expect(page.getByTestId('review-crop')).toBeVisible();
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
    );
    await expect(page.getByTestId('review-diff-crop')).toHaveCount(0);
    await expect(page.getByTestId('zone-box-top-right')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // 切换方位仍直接复用恢复时采样的像素
    await page.getByTestId('zone-top-left').click();
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：无缺口（1024 个像素全部命中）',
    );
  });

  test('满命中复检对比刷新后恢复：两次判定、两张预览与四类像素计数一致', async ({ page }) => {
    await page.goto('/');
    await uploadBaseline(page, failingBaselinePng);
    await uploadRecheck(page, fullHitPng);
    await expect(page.getByTestId('recheck-status')).toHaveText('已完成对比');
    await page.getByTestId('zone-top-right').click();
    await expect(page.getByTestId('review-diff-crop')).toBeVisible();

    await slowDownDecode(page);
    await page.reload();
    await expect(page.getByTestId('recovery-loading')).toBeVisible();

    // 回到已完成的前后对比，而非待复检
    await expect(page.getByTestId('recheck-status')).toHaveText('已完成对比');
    const baselineVerdict = page.getByTestId('verdict');
    await expect(baselineVerdict).toContainText('调整前基准');
    await expect(baselineVerdict).toContainText('不合格');
    await expect(page.getByTestId('verdict-recheck')).toContainText('合格');
    await expect(page.getByTestId('preview-tag-baseline')).toBeVisible();
    await expect(page.getByTestId('preview-tag-recheck')).toBeVisible();

    // 选中的右上方位恢复为差异审阅，四类像素计数与刷新前完全一致
    await expect(page.getByTestId('review')).toContainText('右上检测区');
    await expect(page.getByTestId('review-diff-crop')).toBeVisible();
    await expect(page.getByTestId('review-crop')).toHaveCount(0);
    await expect(page.getByTestId('review-diff-summary')).toHaveText(
      '基准命中 819 → 复检命中 1024（增加 205）',
    );
    expect(await diffColorCounts(page)).toEqual({
      magenta: 819,
      white: 0,
      green: 205,
      red: 0,
    });

    // 切换到无变化的左上区：全部两次均命中
    await page.getByTestId('zone-top-left').click();
    expect(await diffColorCounts(page)).toEqual({ magenta: 1024, white: 0, green: 0, red: 0 });

    // 取消对比在恢复后的会话上仍可用，且刷新后不再复活复检
    await page.getByTestId('recheck-cancel').click();
    await expect(page.getByTestId('recheck-status')).toHaveText('待复检');
    await expect(page.getByTestId('preview-recheck')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('recheck-status')).toHaveText('待复检');
    await expect(page.getByTestId('verdict-recheck')).toHaveCount(0);
    await expect(page.getByTestId('preview-recheck')).toHaveCount(0);
  });
});

test.describe('损坏或不识别的快照降级到上传页并清理', () => {
  test('结构不识别（未知版本、缺图）：提示无法恢复、清理快照并允许正常上传', async ({
    page,
  }) => {
    await seedSnapshot(page, {
      format: 'register-mark-verify-session',
      version: 99,
      phase: 'awaiting',
      selectedId: null,
    });
    await page.reload();

    const error = page.getByTestId('recovery-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('无法恢复');
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('session-bar')).toHaveCount(0);
    // 上传入口仍可用
    await expect(page.getByTestId('file-input')).toBeAttached();

    // 快照已清理：再次刷新不再出现无法恢复提示，也没有旧结果
    await page.reload();
    await expect(page.getByTestId('recovery-error')).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toHaveCount(0);
  });

  test('带 PNG 签名但内容损坏：重新解码失败后清理并降级，随后上传与保存恢复正常', async ({
    page,
  }) => {
    // 结构合法、PNG 签名完整，但字节无法解码（validateSnapshot 通过、重建失败）
    const corruptBytes = [...PNG_SIGNATURE, ...Buffer.from('not-a-real-png-body')];
    await seedSnapshot(page, {
      format: 'register-mark-verify-session',
      version: 1,
      savedAt: Date.now(),
      __baselineBytes: corruptBytes,
      baselineName: 'broken.png',
      phase: 'awaiting',
      selectedId: 'top-right',
    });
    await page.reload();

    const error = page.getByTestId('recovery-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('PNG');
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('file-input')).toBeAttached();

    // 清理后允许正常上传，新会话照常保存并可再次刷新恢复
    await uploadBaseline(page, failingBaselinePng, 'fresh.png');
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await page.reload();
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
  });
});

test.describe('清除已保存会话', () => {
  test('主动清除后回到初始上传态，再次刷新也不出现旧结果', async ({ page }) => {
    await page.goto('/');
    await uploadBaseline(page, failingBaselinePng);
    await uploadRecheck(page, fullHitPng);
    await expect(page.getByTestId('verdict-recheck')).toContainText('合格');
    await expect(page.getByTestId('session-clear')).toBeVisible();

    await page.getByTestId('session-clear').click();

    // 立即回到初始上传态：判定、预览、复检栏全部移除
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('verdict-recheck')).toHaveCount(0);
    await expect(page.getByTestId('recheck-bar')).toHaveCount(0);
    await expect(page.getByTestId('preview')).toHaveCount(0);
    await expect(page.getByTestId('session-bar')).toHaveCount(0);
    await expect(page.getByTestId('file-input')).toBeAttached();

    // 再次刷新不出现任何旧结果
    await page.reload();
    await expect(page.getByTestId('recovery-loading')).toHaveCount(0);
    await expect(page.getByTestId('recovery-error')).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('session-bar')).toHaveCount(0);
  });
});

test.describe('浏览器存储不可用时既有核验流程不受阻', () => {
  test('禁用 IndexedDB：可正常上传与复检，但不保存会话，刷新后回到初始态', async ({
    page,
  }) => {
    await page.context().addInitScript(() => {
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    });
    await page.goto('/');

    await uploadBaseline(page, failingBaselinePng);
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
    await uploadRecheck(page, fullHitPng);
    await expect(page.getByTestId('verdict-recheck')).toContainText('合格');
    // 存储不可用：不显示清除入口
    await expect(page.getByTestId('session-bar')).toHaveCount(0);

    await page.reload();
    // 无快照可恢复：直接是初始上传态，无错误提示
    await expect(page.getByTestId('recovery-error')).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('recheck-bar')).toHaveCount(0);
    await expect(page.getByTestId('file-input')).toBeAttached();

    // 既有流程仍完全可用
    await uploadBaseline(page, fullHitPng, 'ok.png');
    await expect(page.getByTestId('verdict')).toHaveText('合格');
  });
});
