import { logger } from '../utils/logger';

export async function dispatchClick(client: any, x: number, y: number): Promise<void> {
  try {
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  } catch (err) {
    logger.warn(`[chrome:input] click failed: ${err}`);
  }
}

export async function dispatchDoubleClick(client: any, x: number, y: number): Promise<void> {
  try {
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 2 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 2 });
  } catch (err) {
    logger.warn(`[chrome:input] dblclick failed: ${err}`);
  }
}

export async function dispatchRightClick(client: any, x: number, y: number): Promise<void> {
  try {
    await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
    await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
  } catch (err) {
    logger.warn(`[chrome:input] right-click failed: ${err}`);
  }
}

export async function dispatchScroll(client: any, x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
  try {
    await client.Input.dispatchMouseEvent({ type: 'mouseWheel', x, y, deltaX, deltaY });
  } catch (err) {
    logger.warn(`[chrome:input] scroll failed: ${err}`);
  }
}

export async function dispatchKey(client: any, key: string, code: string, text?: string, modifiers?: number): Promise<void> {
  try {
    await client.Input.dispatchKeyEvent({
      type: 'keyDown', key, code, text: text || '',
      windowsVirtualKeyCode: getVirtualKeyCode(key), modifiers: modifiers || 0,
    });
    await client.Input.dispatchKeyEvent({
      type: 'keyUp', key, code,
      windowsVirtualKeyCode: getVirtualKeyCode(key), modifiers: modifiers || 0,
    });
  } catch (err) {
    logger.warn(`[chrome:input] key failed: ${err}`);
  }
}

export function scaleCoordinates(
  mobileX: number, mobileY: number,
  mobileWidth: number, mobileHeight: number,
  chromeWidth: number, chromeHeight: number,
): { x: number; y: number } {
  return {
    x: Math.round((mobileX / mobileWidth) * chromeWidth),
    y: Math.round((mobileY / mobileHeight) * chromeHeight),
  };
}

function getVirtualKeyCode(key: string): number {
  const map: Record<string, number> = {
    'Enter': 13, 'Tab': 9, 'Backspace': 8, 'Escape': 27, 'Delete': 46,
    'ArrowUp': 38, 'ArrowDown': 40, 'ArrowLeft': 37, 'ArrowRight': 39,
    'Home': 36, 'End': 35, 'PageUp': 33, 'PageDown': 34, ' ': 32,
  };
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return map[key] || 0;
}
