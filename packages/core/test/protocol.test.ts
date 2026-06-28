import { describe, it, expect } from 'vitest';
import {
  isSignalMessage,
  isInputEvent,
  isValidSessionCode,
  isIceServerList,
} from '../src/protocol.js';

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

  it('accepts a joined ack carrying an optional iceServers list (additive)', () => {
    expect(isSignalMessage({ type: 'joined', from: 'h' })).toBe(true);
    expect(isSignalMessage({ type: 'joined', iceServers: [] })).toBe(true);
    expect(
      isSignalMessage({
        type: 'joined',
        iceServers: [
          { urls: 'stun:stun.example.com:3478' },
          { urls: ['turn:t.example.com:3478'], username: 'u', credential: 'p' },
        ],
      }),
    ).toBe(true);
  });

  it('rejects a signal message with a malformed iceServers field', () => {
    expect(isSignalMessage({ type: 'joined', iceServers: 'nope' })).toBe(false);
    expect(isSignalMessage({ type: 'joined', iceServers: [{ urls: 42 }] })).toBe(false);
    expect(
      isSignalMessage({ type: 'joined', iceServers: [{ urls: 'stun:x', username: 5 }] }),
    ).toBe(false);
  });

  it('isIceServerList validates list shape', () => {
    expect(isIceServerList([])).toBe(true);
    expect(isIceServerList([{ urls: 'stun:x.example.com' }])).toBe(true);
    expect(isIceServerList([{ urls: ['turn:x'], username: 'u', credential: 'p' }])).toBe(true);
    expect(isIceServerList('nope')).toBe(false);
    expect(isIceServerList([{ urls: 42 }])).toBe(false);
    expect(isIceServerList([{ urls: ['a', 1] }])).toBe(false);
    expect(isIceServerList([{ urls: 'stun:x', credential: 9 }])).toBe(false);
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
