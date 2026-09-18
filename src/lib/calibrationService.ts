/**
 * 扫描照明校准异步分析服务。
 *
 * 分析流程严格按阶段执行，任一阶段失败都抛出带阶段标识的 CalibrationError，
 * 由调用方移除旧报告并提示操作员；成功后返回 CalibrationReport 领域对象。
 *
 *   1. signature：读取文件前 8 字节并校验 PNG 签名；
 *   2. decode：createImageBitmap 浏览器原生解码；
 *   3. size：尺寸必须恰为 1024×1024（归入尺寸阶段）；
 *   4. sample：Canvas 2D 绘制并 getImageData 取样原始 RGBA 像素；
 *   5. analyze：在像素缓冲上构建 CalibrationReport。
 *
 * 分析被设计为可中止：切换/取消时调用 AbortController.abort()，
 * 已过期的分析结果不会回写到界面。
 */

import { hasPngSignature } from './detect';
import {
  buildCalibrationReport,
  CALIBRATION_IMAGE_SIZE,
  type CalibrationReport,
} from './calibration';

/** 失败阶段标识，用于界面精确指出问题发生在哪一步 */
export type CalibrationStage = 'signature' | 'decode' | 'size' | 'sample' | 'analyze';

export class CalibrationError extends Error {
  readonly stage: CalibrationStage;
  readonly title: string;

  constructor(stage: CalibrationStage, title: string, message: string) {
    super(message);
    this.name = 'CalibrationError';
    this.stage = stage;
    this.title = title;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('校准分析已取消', 'AbortError');
  }
}

/**
 * 异步分析一张中性灰校准图。
 * 返回的 Promise 解析为 CalibrationReport；失败时 reject CalibrationError，
 * 中止时 reject 名为 AbortError 的 DOMException。
 */
export async function analyzeCalibrationImage(
  file: File,
  signal?: AbortSignal,
): Promise<CalibrationReport> {
  // 1) 文件头签名校验：仅接受 PNG
  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  } catch {
    throw new CalibrationError('signature', '读取失败', '无法读取所选文件的文件头，请重新选择图片。');
  }
  throwIfAborted(signal);
  if (!hasPngSignature(head)) {
    throw new CalibrationError(
      'signature',
      '格式不支持',
      '仅接受 PNG 文件，所选文件的文件头不是 PNG。',
    );
  }

  // 2) 浏览器原生解码（不做色彩空间转换、不预乘 alpha，取样即原图像素）
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
  } catch {
    throw new CalibrationError('decode', '解码失败', '浏览器无法解码该 PNG，文件可能已损坏。');
  }
  throwIfAborted(signal);

  // 3) 尺寸必须恰为 1024×1024
  if (bitmap.width !== CALIBRATION_IMAGE_SIZE || bitmap.height !== CALIBRATION_IMAGE_SIZE) {
    const { width, height } = bitmap;
    bitmap.close();
    throw new CalibrationError(
      'size',
      '尺寸不符',
      `图像尺寸为 ${width}×${height}，校准图要求恰为 ${CALIBRATION_IMAGE_SIZE}×${CALIBRATION_IMAGE_SIZE}。`,
    );
  }

  // 4) 在原始分辨率上取样
  const canvas = document.createElement('canvas');
  canvas.width = CALIBRATION_IMAGE_SIZE;
  canvas.height = CALIBRATION_IMAGE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new CalibrationError('sample', '环境异常', '无法创建 Canvas 2D 上下文，无法读取原始像素。');
  }
  let pixels: Uint8ClampedArray;
  try {
    ctx.drawImage(bitmap, 0, 0);
  } catch {
    bitmap.close();
    throw new CalibrationError(
      'sample',
      '取样失败',
      'Canvas 像素取样失败，当前浏览器环境不允许绘制该图像。',
    );
  }
  bitmap.close();
  try {
    pixels = ctx.getImageData(0, 0, CALIBRATION_IMAGE_SIZE, CALIBRATION_IMAGE_SIZE).data;
  } catch {
    throw new CalibrationError(
      'sample',
      '取样失败',
      'Canvas 像素取样失败，当前浏览器环境不允许读取图像像素。',
    );
  }
  throwIfAborted(signal);

  // 5) 构建报告（纯计算，放入微任务以保持整个流程异步、界面可先进入分析中状态）
  await Promise.resolve();
  throwIfAborted(signal);
  try {
    return buildCalibrationReport(pixels, CALIBRATION_IMAGE_SIZE, CALIBRATION_IMAGE_SIZE, file.name);
  } catch (err) {
    throw new CalibrationError(
      'analyze',
      '分析失败',
      err instanceof Error ? err.message : '校准分析失败，请重新选择图片。',
    );
  }
}
