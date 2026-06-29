import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRecorder } from './use-recorder.js';

/** Minimal MediaRecorder mock capturing the start/stop/dataavailable flow. */
class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);

  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly mimeType: string;

  constructor(
    public stream: MediaStream,
    opts?: { mimeType?: string },
  ) {
    this.mimeType = opts?.mimeType ?? 'video/webm';
    MockMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    this.state = 'inactive';
    // Emit a chunk then fire onstop, like a real recorder.
    this.ondataavailable?.({ data: new Blob(['chunk'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

describe('useRecorder', () => {
  beforeEach(() => {
    MockMediaRecorder.instances = [];
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = MockMediaRecorder;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports unsupported when MediaRecorder is absent', () => {
    delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
    const { result } = renderHook(() => useRecorder({ stream: {} as MediaStream }));
    expect(result.current.state).toBe('unsupported');
    act(() => result.current.start());
    expect(result.current.recording).toBe(false);
  });

  it('starts and stops, then downloads an assembled blob', () => {
    const download = vi.fn();
    const stream = {} as MediaStream;
    const { result } = renderHook(() =>
      useRecorder({ stream, download, filename: () => 'rec.webm' }),
    );

    expect(result.current.state).toBe('idle');

    act(() => result.current.start());
    expect(result.current.recording).toBe(true);
    expect(MockMediaRecorder.instances.length).toBe(1);

    act(() => result.current.stop());
    expect(result.current.recording).toBe(false);
    expect(result.current.state).toBe('idle');
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, name] = download.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(name).toBe('rec.webm');
  });

  it('start is a no-op when already recording', () => {
    const stream = {} as MediaStream;
    const { result } = renderHook(() => useRecorder({ stream }));
    act(() => result.current.start());
    act(() => result.current.start());
    expect(MockMediaRecorder.instances.length).toBe(1);
  });

  it('does nothing on stop when not recording', () => {
    const download = vi.fn();
    const { result } = renderHook(() => useRecorder({ stream: {} as MediaStream, download }));
    act(() => result.current.stop());
    expect(download).not.toHaveBeenCalled();
  });

  it('does not start without a stream', () => {
    const { result } = renderHook(() => useRecorder({ stream: null }));
    act(() => result.current.start(null));
    expect(MockMediaRecorder.instances.length).toBe(0);
    expect(result.current.recording).toBe(false);
  });
});
