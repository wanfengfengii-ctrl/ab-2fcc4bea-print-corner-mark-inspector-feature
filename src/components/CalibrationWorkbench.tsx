import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  CALIBRATION_GRID_SIZE,
  CHANNEL_MEAN_MAX,
  CHANNEL_MEAN_MIN,
  MAX_LUMINANCE_RANGE,
  type CalibrationReport,
} from '../lib/calibration';
import {
  analyzeCalibrationImage,
  CalibrationError,
} from '../lib/calibrationService';

/** 工作台四态：未选择 / 分析中 / 已完成 / 失败 */
type CalibrationStatus = 'idle' | 'analyzing' | 'done' | 'failed';

interface CalibrationFailureView {
  stage: string;
  title: string;
  detail: string;
}

const STAGE_LABEL: Record<string, string> = {
  signature: '签名校验',
  decode: '原生解码',
  size: '尺寸校验',
  sample: 'Canvas 取样',
  analyze: '分析计算',
};

function f2(n: number): string {
  return n.toFixed(2);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 热力图配色：以全图格均值范围归一化，蓝（暗）→ 浅灰（中）→ 红（亮），
 * 均匀灰图各格颜色几乎一致，暗角图能直观看出边角偏暗。
 */
function heatStyle(report: CalibrationReport, luma: number): CSSProperties {
  const span = report.maxLuminance - report.minLuminance;
  const t = span === 0 ? 0.5 : (luma - report.minLuminance) / span;
  const stops: Array<[number, [number, number, number]]> = [
    [0, [33, 102, 172]],
    [0.5, [247, 247, 247]],
    [1, [178, 24, 43]],
  ];
  const [lo, hi] = t < 0.5 ? [stops[0], stops[1]] : [stops[1], stops[2]];
  const localT = (t - lo[0]) / (hi[0] - lo[0]);
  const r = Math.round(lerp(lo[1][0], hi[1][0], localT));
  const g = Math.round(lerp(lo[1][1], hi[1][1], localT));
  const b = Math.round(lerp(lo[1][2], hi[1][2], localT));
  // 中间浅色块用深色文字，两端深色块用白色文字，保证数值可读
  const color = t > 0.3 && t < 0.7 ? '#1f2933' : '#fff';
  return { backgroundColor: `rgb(${r}, ${g}, ${b})`, color };
}

/**
 * 扫描照明校准工作台。
 *
 * 只分析中性灰校准图：选择 1024×1024 PNG 后依次经过签名校验、浏览器原生解码、
 * Canvas 取样，把图像固定划分为 8×8 个 128 像素方格并生成 CalibrationReport。
 * 本工作台与套准角标核验相互独立，不读取也不改写角标核验的任何结果。
 */
export default function CalibrationWorkbench() {
  const [status, setStatus] = useState<CalibrationStatus>('idle');
  const [report, setReport] = useState<CalibrationReport | null>(null);
  const [failure, setFailure] = useState<CalibrationFailureView | null>(null);
  const [fileName, setFileName] = useState('');
  // 进行中的分析可被新一次选择中止；分析中输入框禁用，旧异步结果不会回写
  const abortRef = useRef<AbortController | null>(null);

  const handleFile = async (file: File) => {
    // 分析中禁止重复提交
    if (status === 'analyzing') return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // 进入分析中即移除旧报告与旧错误（格式、尺寸、解码或取样失败同样不残留旧报告）
    setFileName(file.name);
    setReport(null);
    setFailure(null);
    setStatus('analyzing');

    try {
      const next = await analyzeCalibrationImage(file, controller.signal);
      if (controller.signal.aborted) return;
      setReport(next);
      setStatus('done');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      if (err instanceof CalibrationError) {
        setFailure({
          stage: STAGE_LABEL[err.stage] ?? err.stage,
          title: err.title,
          detail: err.message,
        });
      } else {
        setFailure({
          stage: '未知阶段',
          title: '分析失败',
          detail: err instanceof Error ? err.message : '校准分析失败，请重新选择图片。',
        });
      }
      // 失败必须移除旧报告
      setReport(null);
      setStatus('failed');
    }
  };

  const analyzing = status === 'analyzing';

  return (
    <div className="page">
      <h1>扫描照明校准</h1>
      <p className="hint">
        工位开班前使用：仅分析中性灰校准图，不影响套准角标核验结果。选择一张恰为
        1024×1024 的 PNG，经签名校验、原生解码与 Canvas 取样后，图像固定划分为 8×8 个
        128 像素方格。亮度按 0.2126R + 0.7152G + 0.0722B 计算；全图 R/G/B 三通道均值均处于
        {' '}
        {CHANNEL_MEAN_MIN}–{CHANNEL_MEAN_MAX} 且 64 格亮度极差不超过 {MAX_LUMINANCE_RANGE}
        时判定照明合格（无偏色、无暗角）。
      </p>

      <div className="upload" data-testid="cal-upload">
        <label htmlFor="cal-png-upload">选择中性灰校准图（PNG）</label>
        <input
          id="cal-png-upload"
          data-testid="cal-file-input"
          type="file"
          accept="image/png"
          disabled={analyzing}
          aria-busy={analyzing}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // 允许重复选择同一文件再次触发分析
            e.target.value = '';
            if (file) void handleFile(file);
          }}
        />
        {fileName && <span className="file-name">{fileName}</span>}
        <span className="cal-status" data-testid="cal-status" aria-live="polite">
          {status === 'idle' && '未选择'}
          {analyzing && '分析中…'}
          {status === 'done' && '已完成'}
          {status === 'failed' && '失败'}
        </span>
      </div>

      {analyzing && (
        <div className="banner cal-progress" data-testid="cal-progress" role="status">
          正在对「{fileName}」进行签名校验、原生解码、Canvas 取样与 64 格分析，请勿重复提交…
        </div>
      )}

      {status === 'failed' && failure && (
        <div className="banner error" role="alert" data-testid="cal-error">
          <strong>
            {failure.title}（阶段：{failure.stage}）
          </strong>
          <span>{failure.detail}</span>
          <span>旧报告已移除，请重新选择有效的 1024×1024 PNG 校准图。</span>
        </div>
      )}

      {status === 'idle' && (
        <div className="cal-entry" data-testid="cal-entry">
          <p>尚未选择校准图。请使用上方上传区选择一张 1024×1024 的中性灰 PNG。</p>
        </div>
      )}

      {report && status === 'done' && (
        <>
          <div
            className={`banner ${report.passed ? 'pass' : 'fail'}`}
            data-testid="cal-verdict"
          >
            {report.passed ? '照明校准通过' : '照明校准不通过'}
          </div>

          <section className="cal-summary" data-testid="cal-summary">
            <h2>校准摘要</h2>
            <ul className="cal-metrics">
              <li data-testid="cal-mean-rgb">
                全图 RGB 均值：R {f2(report.meanRed)} / G {f2(report.meanGreen)} / B{' '}
                {f2(report.meanBlue)}
                {report.channelMeansInRange ? '（均在 112–144 区间）' : '（超出 112–144 区间）'}
              </li>
              <li data-testid="cal-mean-luma">全图平均亮度：{f2(report.meanLuminance)}</li>
              <li data-testid="cal-range">
                方格亮度极差：{f2(report.luminanceRange)}（最暗格 #{report.dimmestCellIndex}{' '}
                {f2(report.minLuminance)}，最亮格 #{report.brightestCellIndex}{' '}
                {f2(report.maxLuminance)}，上限 {MAX_LUMINANCE_RANGE}）
              </li>
            </ul>
            {report.failures.length > 0 && (
              <ul className="cal-failures" data-testid="cal-failures">
                {report.failures.map((failure) => (
                  <li key={failure.code}>{failure.message}</li>
                ))}
              </ul>
            )}
            <p className="cal-conclusion" data-testid="cal-conclusion">
              {report.conclusion}
            </p>
          </section>

          <section className="cal-heatmap-wrap" data-testid="cal-heatmap-wrap">
            <h2>64 格亮度热力图（固定格序，先行后列；第 0 格为左上）</h2>
            <div
              className="cal-heatmap"
              data-testid="cal-heatmap"
              role="img"
              aria-label="8×8 方格平均亮度热力图"
              style={{ gridTemplateColumns: `repeat(${CALIBRATION_GRID_SIZE}, minmax(0, 1fr))` }}
            >
              {report.cells.map((cell) => (
                <div
                  key={cell.index}
                  className="cal-cell"
                  data-testid={`cal-cell-${cell.index}`}
                  data-luma={cell.meanLuminance.toFixed(4)}
                  title={
                    `#${cell.index}（第 ${cell.row + 1} 行第 ${cell.col + 1} 列，` +
                    `x ${cell.x0}–${cell.x0 + cell.size - 1}，y ${cell.y0}–${
                      cell.y0 + cell.size - 1
                    }）平均亮度 ${f2(cell.meanLuminance)}`
                  }
                  style={heatStyle(report, cell.meanLuminance)}
                >
                  <span className="cal-cell-index">{cell.index}</span>
                  <span className="cal-cell-luma">{f2(cell.meanLuminance)}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
