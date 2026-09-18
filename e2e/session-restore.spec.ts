import { expect, test } from '@playwright/test';
import { IMAGE_SIZE, ZONES } from '../src/lib/detect';
import { buildTestPng, type Rgba } from './helpers/png';

const MAGENTA: Rgba = [255, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];

function inAnyZone(x: number, y: number): boolean {
  return ZONES.some((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
}

/**
 * 固定的不合格基准：右上区恰好 819 命中（按局部序末 205 像素置白），
 * 其余三个检测区满命中，检测区外全白。
 */
const TR = ZONES[1];
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

async function uploadRecheck(
  page: import('@playwright/test').Page,
  buffer: Buffer,
  name = 'recheck.png',
) {
  await page.getByTestId('recheck-input').setInputFiles({ name, mimeType: 'image/png', buffer });
}

/** 直接读取 IndexedDB 中的核验会话快照（数据库或记录不存在时返回 null） */
function readSnapshotRecord(page: import('@playwright/test').Page): Promise<unknown> {
  return page.evaluate(
    () =>
      new Promise<unknown>((resolve) => {
        const req = indexedDB.open('register-mark-verifier');
        req.onerror = () => resolve(null);
        req.onupgradeneeded = () => {
          const tx = req.transaction;
          req.result.close();
          tx?.abort();
          resolve(null);
        };
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('sessions')) {
            db.close();
            resolve(null);
            return;
          }
          const tx = db.transaction('sessions', 'readonly');
          const getReq = tx.objectStore('sessions').get('verify-current');
          getReq.onsuccess = () => {
            db.close();
            resolve(getReq.result ?? null);
          };
          getReq.onerror = () => {
            db.close();
            resolve(null);
          };
        };
      }),
  );
}

/** 等待应用把快照写入 IndexedDB（写盘在判定渲染之后异步完成） */
async function waitForSnapshotSaved(page: import('@playwright/test').Page) {
  await expect
    .poll(async () => (await readSnapshotRecord(page)) !== null, {
      timeout: 5000,
      intervals: [50, 100, 200],
    })
    .toBe(true);
}

/** 向 IndexedDB 注入任意原始快照记录（字节以数字数组传入，浏览器内重建 ArrayBuffer） */
async function injectSnapshot(
  page: import('@playwright/test').Page,
  record: {
    version: number;
    baselineBytes: number[] | null;
    recheckBytes: number[] | null;
    phase: 'awaiting' | 'compared';
    selectedId: string | null;
  },
) {
  await page.evaluate(
    (rec) =>
      new Promise<void>((resolve, reject) => {
        const toBuffer = (bytes: number[] | null) =>
          bytes === null ? null : new Uint8Array(bytes).buffer;
        const req = indexedDB.open('register-mark-verifier', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions');
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('sessions', 'readwrite');
          tx.objectStore('sessions').put(
            {
              version: rec.version,
              baselinePng: toBuffer(rec.baselineBytes),
              recheckPng: toBuffer(rec.recheckBytes),
              phase: rec.phase,
              selectedId: rec.selectedId,
            },
            'verify-current',
          );
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    record,
  );
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

test.describe('误刷新后同浏览器自动恢复核验会话', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('819 命中的不合格基准：选中右上缺口审阅后刷新，自动回到该方位单图审阅', async ({
    page,
  }) => {
    await uploadBaseline(page, failingBaselinePng);
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('recheck-status')).toHaveText('待复检');

    // 选中右上方位，查看缺口证据
    await page.getByTestId('zone-top-right').click();
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
    );
    await expect(page.getByTestId('zone-box-top-right')).toHaveAttribute('aria-pressed', 'true');
    await waitForSnapshotSaved(page);

    // 误刷新：不重新选择图片，会话在同浏览器内自动恢复
    await page.reload();
    await expect(page.getByTestId('session-restoring')).toBeVisible();

    // 仍通过重算得到基准判定与命中数，阶段回到待复检
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('verdict')).toContainText('右上');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
    await expect(page.getByTestId('recheck-status')).toHaveText('待复检');
    await expect(page.getByTestId('verdict-recheck')).toHaveCount(0);

    // 选中方位随快照恢复：直接停在右上缺口审阅，不需重新点选
    await expect(page.getByTestId('review')).toBeVisible();
    await expect(page.getByTestId('review-crop')).toBeVisible();
    await expect(page.getByTestId('review-diff-crop')).toHaveCount(0);
    await expect(page.getByTestId('review-gap-bounds')).toHaveText(
      '缺口范围：x 976–1007，y 41–47（未命中 205 像素）',
    );
    await expect(page.getByTestId('zone-box-top-right')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('preview-baseline')).toBeVisible();

    // 恢复完成后“正在恢复”提示消失
    await expect(page.getByTestId('session-restoring')).toHaveCount(0);
    // 清除入口可用
    await expect(page.getByTestId('clear-session')).toBeVisible();
  });

  test('满命中复检完成对比后刷新：恢复两次判定与右上差异图四类像素计数', async ({ page }) => {
    await uploadBaseline(page, failingBaselinePng);
    await uploadRecheck(page, fullHitPng);
    await expect(page.getByTestId('recheck-status')).toHaveText('已完成对比');
    await page.getByTestId('zone-top-right').click();
    await expect(page.getByTestId('review-diff-crop')).toBeVisible();
    await waitForSnapshotSaved(page);

    await page.reload();
    await expect(page.getByTestId('session-restoring')).toBeVisible();

    // 回到已完成的前后对比：基准不合格 / 复检合格，两张预览都在
    await expect(page.getByTestId('recheck-status')).toHaveText('已完成对比');
    await expect(page.getByTestId('verdict')).toContainText('调整前基准');
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('verdict-recheck')).toContainText('复检结果');
    await expect(page.getByTestId('verdict-recheck')).toContainText('合格');
    await expect(page.getByTestId('preview-baseline')).toBeVisible();
    await expect(page.getByTestId('preview-recheck')).toBeVisible();

    // 选中方位恢复为右上，直接展示差异图
    await expect(page.getByTestId('review')).toBeVisible();
    await expect(page.getByTestId('review-diff-crop')).toBeVisible();
    await expect(page.getByTestId('review-diff-summary')).toHaveText(
      '基准命中 819 → 复检命中 1024（增加 205）',
    );
    await expect(page.getByTestId('review-diff-recovered')).toHaveText('恢复命中：205 像素');
    await expect(page.getByTestId('review-diff-newgaps')).toHaveText('新增缺失：0 像素');
    await expect(page.getByTestId('review-diff-unchanged-hit')).toHaveText(
      '两次均命中：819 像素',
    );
    await expect(page.getByTestId('review-diff-unchanged-miss')).toHaveText(
      '两次均缺失：0 像素',
    );

    // 差异图逐像素核对四类计数：品红 819、白 0、绿 205、红 0
    expect(await diffColorCounts(page)).toEqual({ magenta: 819, white: 0, green: 205, red: 0 });
    await expect(page.getByTestId('session-restoring')).toHaveCount(0);

    // 恢复后切换方位仍可用（差异图按重算的像素缓冲生成）
    await page.getByTestId('zone-top-left').click();
    expect(await diffColorCounts(page)).toEqual({ magenta: 1024, white: 0, green: 0, red: 0 });
  });

  test('首次访问（无快照）直接是初始上传态，不出现恢复提示', async ({ page }) => {
    await expect(page.getByTestId('file-input')).toBeVisible();
    await expect(page.getByTestId('session-restoring')).toHaveCount(0);
    await expect(page.getByTestId('session-restore-failed')).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toHaveCount(0);
  });
});

test.describe('损坏或不识别的快照降级到上传页并清理', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('注入 PNG 签名正确但内容损坏的快照：说明无法恢复、清理快照，随后可正常上传', async ({
    page,
  }) => {
    const corruptPng = [...PNG_SIGNATURE, ...Array.from(Buffer.from('truncated-png-content'))];
    await injectSnapshot(page, {
      version: 1,
      baselineBytes: corruptPng,
      recheckBytes: null,
      phase: 'awaiting',
      selectedId: 'top-right',
    });

    await page.reload();
    const failed = page.getByTestId('session-restore-failed');
    await expect(failed).toBeVisible();
    await expect(failed).toContainText('无法恢复');
    await expect(failed).toContainText('图像解码');

    // 不残留任何旧判定，上传入口可用
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('review')).toHaveCount(0);
    await expect(page.getByTestId('file-input')).toBeVisible();

    // 坏快照已被清理：再次刷新不再提示、也不出现旧结果
    await page.reload();
    await expect(page.getByTestId('session-restore-failed')).toHaveCount(0);
    await expect(page.getByTestId('session-restoring')).toHaveCount(0);
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    expect(await readSnapshotRecord(page)).toBeNull();

    // 随后允许正常上传，既有核验流程不受影响
    await uploadBaseline(page, failingBaselinePng);
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
  });

  test('注入无法识别版本或缺图的快照：提示无法识别并清理，降级到上传页', async ({ page }) => {
    const corruptPng = [...PNG_SIGNATURE, ...Array.from(Buffer.from('truncated-png-content'))];

    // 版本不识别
    await injectSnapshot(page, {
      version: 99,
      baselineBytes: corruptPng,
      recheckBytes: null,
      phase: 'awaiting',
      selectedId: null,
    });
    await page.reload();
    await expect(page.getByTestId('session-restore-failed')).toContainText('无法识别');
    expect(await readSnapshotRecord(page)).toBeNull();

    // 缺少基准图
    await injectSnapshot(page, {
      version: 1,
      baselineBytes: null,
      recheckBytes: null,
      phase: 'awaiting',
      selectedId: null,
    });
    await page.reload();
    await expect(page.getByTestId('session-restore-failed')).toContainText('无法识别');
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    expect(await readSnapshotRecord(page)).toBeNull();
  });
});

test.describe('主动清除已保存会话', () => {
  test('完成对比后清除会话回到初始上传态，再次刷新不出现旧结果', async ({ page }) => {
    await page.goto('/');
    await uploadBaseline(page, failingBaselinePng);
    await uploadRecheck(page, fullHitPng);
    await expect(page.getByTestId('verdict-recheck')).toContainText('合格');
    await waitForSnapshotSaved(page);

    await page.getByTestId('clear-session').click();

    // 回到初始上传态：判定、两张预览、复检栏、审阅区全部消失
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('verdict-recheck')).toHaveCount(0);
    await expect(page.getByTestId('preview')).toHaveCount(0);
    await expect(page.getByTestId('recheck-bar')).toHaveCount(0);
    await expect(page.getByTestId('review')).toHaveCount(0);
    await expect(page.getByTestId('file-input')).toBeVisible();
    expect(await readSnapshotRecord(page)).toBeNull();

    // 再次刷新也不恢复出任何旧结果
    await page.reload();
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('preview')).toHaveCount(0);
    await expect(page.getByTestId('session-restoring')).toHaveCount(0);
    await expect(page.getByTestId('session-restore-failed')).toHaveCount(0);
  });
});

test.describe('浏览器存储不可用时既有核验流程不受阻', () => {
  test('禁用 IndexedDB：可正常上传检测，刷新不恢复也不报错', async ({ page }) => {
    await page.addInitScript(() => {
      // 模拟隐私模式 / 存储被禁用：indexedDB 不可用
      Object.defineProperty(window, 'indexedDB', {
        value: undefined,
        configurable: true,
      });
    });
    await page.goto('/');

    await uploadBaseline(page, failingBaselinePng);
    await expect(page.getByTestId('verdict')).toContainText('不合格');
    await expect(page.getByTestId('zone-top-right-hits')).toHaveText('命中 819 / 1024');
    await expect(page.getByTestId('session-restore-failed')).toHaveCount(0);

    // 刷新后没有可恢复的会话，也不出现存储错误提示
    await page.reload();
    await expect(page.getByTestId('verdict')).toHaveCount(0);
    await expect(page.getByTestId('session-restore-failed')).toHaveCount(0);
    await expect(page.getByTestId('session-restoring')).toHaveCount(0);
    await expect(page.getByTestId('file-input')).toBeVisible();

    // 仍可正常开始一次新核验
    await uploadBaseline(page, fullHitPng);
    await expect(page.getByTestId('verdict')).toHaveText('合格');
  });
});
