/**
 * window-lifecycle — pure, Electron-free decision logic for the host control
 * window's close / quit behavior (the close-to-tray pattern).
 *
 * These helpers contain NO Electron imports so they are unit-testable without a
 * real BrowserWindow/app. main.ts imports {@link decideWindowClose} to drive the
 * BrowserWindow 'close' handler; the renderer imports {@link shouldStopOnLifecycle}
 * to decide whether a lifecycle event tears the HostSession down.
 *
 * Invariant this encodes: a mere window CLOSE (the user clicking the X) HIDES the
 * window to the tray and keeps the host session joined + advertised. Only a real
 * QUIT destroys the renderer (and only then is the WebRTC/signaling session torn
 * down). There is no session time limit or usage cap anywhere here.
 */

/**
 * Pure decision for the BrowserWindow 'close' event: should this close HIDE the
 * window to the tray (preventing destruction), or be allowed to actually destroy
 * the renderer?
 *
 * Hide on every close EXCEPT when the app is genuinely quitting (the tray's Quit
 * action sets the quitting flag via app 'before-quit'). Hiding keeps the host
 * session live and the code advertised; only a real quit lets the window be
 * destroyed, which finally fires the renderer's beforeunload teardown.
 */
export function decideWindowClose(quitting: boolean): { hide: boolean } {
  return { hide: !quitting };
}

/** A renderer/window lifecycle transition the host cares about. */
export type LifecycleReason = 'hide' | 'unload';

/**
 * Pure policy: should a given lifecycle event tear down the host session?
 *
 * Only a real 'unload' (the renderer actually being destroyed, e.g. on a true
 * app quit) stops the session. A 'hide' (close-to-tray) must KEEP the session
 * alive and advertised.
 */
export function shouldStopOnLifecycle(reason: LifecycleReason): boolean {
  return reason === 'unload';
}
