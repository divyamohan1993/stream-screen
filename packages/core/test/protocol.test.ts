import { describe, it, expect } from 'vitest';
import { isSignalMessage, isInputEvent, isValidSessionCode } from '../src/protocol.js';

describe('protocol guards', () => {
  it('accepts valid signal messages', () => {
    expect(isSignalMessage({ type: 'join', role: 'host' })).toBe(true);
    expect(isSignalMessage({ type: 'ice', candidate: {} })).toBe(true);
    expect(isSignalMessage({ type: 'pong' })).toBe(true);
  });

  it('rejects invalid signal messages', () => {
    expect(isSignalMessage(null)).toBe(false);
    expect(isSignalMessage({})).toBe(false);
    expect(isSignalMessage({ type: 'nope' })).toBe(false);
    expect(isSignalMessage('join')).toBe(false);
  });

  it('accepts valid input events', () => {
    expect(isInputEvent({ t: 'm-move', x: 0, y: 0 })).toBe(true);
    expect(isInputEvent({ t: 'clipboard', text: 'x' })).toBe(true);
  });

  it('rejects invalid input events', () => {
    expect(isInputEvent({ t: 'jump' })).toBe(false);
    expect(isInputEvent(42)).toBe(false);
    expect(isInputEvent(undefined)).toBe(false);
  });

  it('validates 6-9 digit session codes', () => {
    expect(isValidSessionCode('123456')).toBe(true);
    expect(isValidSessionCode('123456789')).toBe(true);
    expect(isValidSessionCode('12345')).toBe(false);
    expect(isValidSessionCode('1234567890')).toBe(false);
    expect(isValidSessionCode('12a456')).toBe(false);
    expect(isValidSessionCode('')).toBe(false);
  });
});
