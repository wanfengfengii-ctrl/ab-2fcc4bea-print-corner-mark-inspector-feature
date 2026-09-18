import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_VERSION,
  validateSnapshot,
  type VerifySnapshot,
} from '../lib/sessionSnapshot';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBuffer(size = 32): ArrayBuffer {
  return new Uint8Array([...PNG_HEAD, ...new Array(Math.max(0, size - 8)).fill(0)]).buffer;
}

function validSnapshot(overrides: Partial<VerifySnapshot> = {}): VerifySnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    savedAt: 123,
    baselinePng: pngBuffer(),
    baselineName: 'baseline.png',
    phase: 'awaiting',
    selectedId: 'top-right',
    ...overrides,
  };
}

describe('validateSnapshot', () => {
  it('接受只含基准、待复检阶段的快照', () => {
    const snapshot = validateSnapshot(validSnapshot());
    expect(snapshot).not.toBeNull();
    expect(snapshot?.phase).toBe('awaiting');
    expect(snapshot?.selectedId).toBe('top-right');
  });

  it('接受未选中方位（null）与完成对比阶段（含复检 PNG）', () => {
    const snapshot = validateSnapshot(
      validSnapshot({
        phase: 'compared',
        selectedId: null,
        recheckPng: pngBuffer(),
        recheckName: 'recheck.png',
      }),
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot?.selectedId).toBeNull();
    expect(snapshot?.recheckPng).toBeInstanceOf(ArrayBuffer);
  });

  it('拒绝非对象、null 与原始类型', () => {
    expect(validateSnapshot(null)).toBeNull();
    expect(validateSnapshot(undefined)).toBeNull();
    expect(validateSnapshot('snapshot')).toBeNull();
    expect(validateSnapshot(42)).toBeNull();
  });

  it('拒绝不识别的结构标识与版本', () => {
    expect(validateSnapshot(validSnapshot({ format: 'other' as never }))).toBeNull();
    expect(validateSnapshot(validSnapshot({ version: 2 as never }))).toBeNull();
    expect(validateSnapshot(validSnapshot({ version: 0 as never }))).toBeNull();
  });

  it('拒绝不识别的阶段', () => {
    expect(validateSnapshot(validSnapshot({ phase: 'idle' as never }))).toBeNull();
  });

  it('拒绝不在四个固定方位内的选中方位', () => {
    expect(validateSnapshot(validSnapshot({ selectedId: 'middle' as never }))).toBeNull();
    expect(validateSnapshot(validSnapshot({ selectedId: 123 as unknown as null }))).toBeNull();
  });

  it('缺图：基准不是 ArrayBuffer 或为空时拒绝', () => {
    expect(
      validateSnapshot(validSnapshot({ baselinePng: undefined as unknown as ArrayBuffer })),
    ).toBeNull();
    expect(validateSnapshot(validSnapshot({ baselinePng: new ArrayBuffer(0) }))).toBeNull();
    expect(
      validateSnapshot(validSnapshot({ baselinePng: new Uint8Array([1, 2, 3]).buffer })),
    ).toBeNull();
  });

  it('PNG 损坏：基准文件头不是 PNG 签名时拒绝', () => {
    const bad = new Uint8Array(32).fill(1).buffer;
    expect(validateSnapshot(validSnapshot({ baselinePng: bad }))).toBeNull();
  });

  it('完成对比阶段缺复检图或复检 PNG 损坏时拒绝', () => {
    expect(
      validateSnapshot(validSnapshot({ phase: 'compared', recheckPng: undefined })),
    ).toBeNull();
    expect(
      validateSnapshot(
        validSnapshot({ phase: 'compared', recheckPng: new Uint8Array(32).fill(1).buffer }),
      ),
    ).toBeNull();
  });

  it('待复检阶段携带的复检图不影响校验', () => {
    const snapshot = validateSnapshot(
      validSnapshot({ recheckPng: pngBuffer(), recheckName: 'leftover.png' }),
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot?.recheckPng).toBeUndefined();
  });
});
