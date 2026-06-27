import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectScreen } from './ConnectScreen.js';

describe('ConnectScreen', () => {
  it('disables Connect until a valid 6–9 digit code is entered', () => {
    const onConnect = vi.fn();
    render(<ConnectScreen onConnect={onConnect} />);
    const button = screen.getByRole('button', { name: /connect/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    const input = screen.getByLabelText(/session code/i);
    fireEvent.change(input, { target: { value: '123456' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onConnect).toHaveBeenCalledWith('123456');
  });

  it('strips non-digits from the code input', () => {
    render(<ConnectScreen onConnect={vi.fn()} />);
    const input = screen.getByLabelText(/session code/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12ab34!56' } });
    expect(input.value).toBe('123456');
  });

  it('shows an error message when provided', () => {
    render(<ConnectScreen onConnect={vi.fn()} error="Host left the session." />);
    expect(screen.getByText(/host left the session/i)).toBeTruthy();
  });
});
