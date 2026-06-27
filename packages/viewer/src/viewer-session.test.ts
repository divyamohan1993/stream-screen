import { describe, it, expect } from 'vitest';
import { ViewerSession, defaultSignalingUrl } from './viewer-session.js';

describe('ViewerSession', () => {
  it('rejects an invalid session code and surfaces an error state', async () => {
    let lastState = '';
    const session = new ViewerSession({
      code: '12', // too short
      signalingUrl: 'ws://localhost:8787',
      handlers: { onState: (s) => (lastState = s) },
    });
    await expect(session.connect()).rejects.toThrow();
    expect(lastState).toBe('error');
    expect(session.currentState).toBe('error');
  });

  it('disconnect is idempotent and lands in disconnected state', () => {
    const session = new ViewerSession({ code: '123456', signalingUrl: 'ws://localhost:8787' });
    session.disconnect();
    session.disconnect();
    expect(session.currentState).toBe('disconnected');
  });
});

describe('defaultSignalingUrl', () => {
  it('derives a ws:// URL on port 8787 from the page host', () => {
    const url = defaultSignalingUrl();
    expect(url).toMatch(/^wss?:\/\/.+:8787$/);
  });
});
