import { describe, expect, it } from 'vitest';
import {
  isStructurallyValidSnapshot,
  SNAPSHOT_VERSION,
} from '../lib/sessionSnapshot';

const pngBytes = (n: number) => new Uint8Array(n).fill(1).buffer;

describe('isStructurallyValidSnapshot 快照结构校验', () => {
  it('结构完整的 awaiting 快照有效', () => {
    expect(
      isStructurallyValidSnapshot({
        version: SNAPSHOT_VERSION,
        baselinePng: pngBytes(8),
        recheckPng: null,
        phase: 'awaiting',
        selectedId: null,
      }),
    ).toBe(true);
  });

  it('结构完整的 compared 快照（含复检图与选中方位）有效', () => {
    expect(
      isStructurallyValidSnapshot({
        version: SNAPSHOT_VERSION,
        baselinePng: pngBytes(8),
        recheckPng: pngBytes(8),
        phase: 'compared',
        selectedId: 'top-right',
      }),
    ).toBe(true);
  });

  it('结构版本不识别时拒绝（旧判定不会被信任）', () => {
    expect(
      isStructurallyValidSnapshot({
        version: SNAPSHOT_VERSION + 1,
        baselinePng: pngBytes(8),
        recheckPng: null,
        phase: 'awaiting',
        selectedId: null,
      }),
    ).toBe(false);
  });

  it('缺少基准图或基准图为空时拒绝', () => {
    expect(
      isStructurallyValidSnapshot({
        version: SNAPSHOT_VERSION,
        baselinePng: null,
        recheckPng: null,
        phase: 'awaiting',
        selectedId: null,
      }),
    ).toBe(false);
    expect(
      isStructurallyValidSnapshot({
        version: SNAPSHOT_VERSION,
        baselinePng: new ArrayBuffer(0),
        recheckPng: null,
        phase: 'awaiting',
        selectedId: null,
      }),
    ).toBe(false);
  });

  it('compared 阶段缺复检图、或 awaiting 阶段却带复检图时拒绝', () => {
    expect(
      isStructurallyValidSnapshot({
        version: SNAPSHOT_VERSION,
        baselinePng: pngBytes(8),
        recheckPng: null,
        phase: 'compared',
        selectedId: null,
      }),
    ).toBe(false);
    expect(
      isStructurallyValidSnapshot({
        version: SNAPSHOT_VERSION,
        baselinePng: pngBytes(8),
        recheckPng: new ArrayBuffer(0),
        phase: 'compared',
        selectedId: null,
      }),
    ).toBe(false);
    expect(
      isStructurallyValidSnapshot({
        version: SNAPSHOT_VERSION,
        baselinePng: pngBytes(8),
        recheckPng: pngBytes(8),
        phase: 'awaiting',
        selectedId: null,
      }),
    ).toBe(false);
  });

  it('非法方位、非法阶段或非对象输入一律拒绝', () => {
    const base = {
      version: SNAPSHOT_VERSION,
      baselinePng: pngBytes(8),
      recheckPng: null,
      phase: 'awaiting',
      selectedId: null,
    };
    expect(isStructurallyValidSnapshot({ ...base, selectedId: 'middle' })).toBe(false);
    expect(isStructurallyValidSnapshot({ ...base, phase: 'idle' })).toBe(false);
    expect(isStructurallyValidSnapshot(null)).toBe(false);
    expect(isStructurallyValidSnapshot(undefined)).toBe(false);
    expect(isStructurallyValidSnapshot('snapshot')).toBe(false);
    expect(isStructurallyValidSnapshot({})).toBe(false);
  });
});
