/**
 * The gyro panel: the parallax levers on the device that is actually tilting,
 * and the two resets. A sibling of the performance HUD — same shape, other
 * side of the screen — because tuning "how much should the picture move when
 * I tilt" can only be done with the phone in hand.
 *
 * What the page does with a changed lever is its own business: the editor
 * writes it to the camera object so it travels with the config, the player
 * keeps it for the session.
 */
import type { ParallaxSettings } from './parallax';
import { describeParallax } from './parallax';

export type GyroActions = {
  getSettings: () => ParallaxSettings;
  setSettings: (patch: Partial<ParallaxSettings>) => void;
  /** The pose of this moment becomes the centre; the eye eases back to the composed view. */
  resetCamera: () => void;
  /** Forgets every sample and asks the sensor again; the next sample is the new centre. */
  resetGyroscope: () => void;
};

export type GyroHud = {
  toggle: () => void;
  show: () => void;
  hide: () => void;
  isShown: () => boolean;
  /** The text the Copy button copies: the settings and the live readout. */
  report: () => string;
};

const STYLE_ID = 'gyro-hud-style';
const CSS = `
.gyro-hud {
  position: fixed; left: calc(12px + env(safe-area-inset-left)); top: calc(12px + env(safe-area-inset-top)); z-index: 1003;
  min-width: 250px; max-width: 92vw;
  padding: 10px 12px; border-radius: 8px;
  background: rgba(0, 0, 0, 0.72); color: #e8e8e8;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  pointer-events: auto; user-select: text; -webkit-user-select: text;
}
.gyro-hud[hidden] { display: none; }
.gyro-hud__title { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
.gyro-hud__readout { opacity: 0.85; white-space: pre-wrap; word-break: break-word; margin-bottom: 4px; }
.gyro-hud__row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
.gyro-hud__label { opacity: 0.7; min-width: 92px; }
.gyro-hud__value { min-width: 44px; text-align: right; }
.gyro-hud input[type=range] { flex: 1 1 90px; min-width: 90px; accent-color: #b34a2c; }
.gyro-hud button {
  padding: 8px 10px; border: 1px solid rgba(255,255,255,0.35); border-radius: 6px;
  background: rgba(255,255,255,0.08); color: #fff; font: 600 12px/1 inherit; cursor: pointer;
}
.gyro-hud button.is-on { background: #b34a2c; border-color: #b34a2c; }
.gyro-hud__copy { margin-top: 10px; width: 100%; }
`;

const ensureStyle = (): void => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
};

type NumericKey = 'amount' | 'maxOffset' | 'smoothing' | 'recenter';
type BooleanKey = 'enabled' | 'invertX' | 'invertY';

export const installGyroHud = (actions: GyroActions): GyroHud => {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'gyro-hud';
  root.hidden = true;

  const title = document.createElement('div');
  title.className = 'gyro-hud__title';
  title.textContent = 'Gyro parallax';
  const readout = document.createElement('div');
  readout.className = 'gyro-hud__readout';
  root.append(title, readout);

  const refreshers: Array<() => void> = [];

  const toggleRow = (label: string, key: BooleanKey): void => {
    const el = document.createElement('div');
    el.className = 'gyro-hud__row';
    const name = document.createElement('span');
    name.className = 'gyro-hud__label';
    name.textContent = label;
    el.appendChild(name);
    const buttons = [
      { text: 'off', value: false },
      { text: 'on', value: true },
    ].map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.text;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        actions.setSettings({ [key]: option.value });
        refreshAll();
      });
      el.appendChild(button);
      return { button, option };
    });
    refreshers.push(() => {
      const current = actions.getSettings()[key];
      buttons.forEach(({ button, option }) =>
        button.classList.toggle('is-on', option.value === current)
      );
    });
    root.appendChild(el);
  };

  const sliderRow = (
    label: string,
    key: NumericKey,
    min: number,
    max: number,
    step: number,
    digits: number
  ): void => {
    const el = document.createElement('div');
    el.className = 'gyro-hud__row';
    const name = document.createElement('span');
    name.className = 'gyro-hud__label';
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const value = document.createElement('span');
    value.className = 'gyro-hud__value';
    input.addEventListener('input', (event) => {
      event.stopPropagation();
      actions.setSettings({ [key]: Number(input.value) });
      value.textContent = Number(input.value).toFixed(digits);
    });
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    el.append(name, input, value);
    refreshers.push(() => {
      const current = actions.getSettings()[key];
      input.value = String(current);
      value.textContent = current.toFixed(digits);
    });
    root.appendChild(el);
  };

  toggleRow('gyro', 'enabled');
  sliderRow('amount', 'amount', 0, 1, 0.01, 2);
  sliderRow('max travel', 'maxOffset', 0, 10, 0.1, 1);
  sliderRow('smoothing', 'smoothing', 0.01, 1, 0.01, 2);
  sliderRow('auto recenter', 'recenter', 0, 30, 0.5, 1);
  toggleRow('invert x', 'invertX');
  toggleRow('invert y', 'invertY');

  // The two resets. "Reset camera" is the one to reach for when the picture
  // sits pushed to one side: the pose of this moment becomes the centre.
  // "Reset gyroscope" is for a sensor that went quiet or was refused: it
  // forgets every sample and asks again.
  const resets = document.createElement('div');
  resets.className = 'gyro-hud__row';
  const resetCamera = document.createElement('button');
  resetCamera.type = 'button';
  resetCamera.textContent = 'Reset camera';
  resetCamera.addEventListener('click', (event) => {
    event.stopPropagation();
    actions.resetCamera();
    refreshAll();
  });
  const resetGyro = document.createElement('button');
  resetGyro.type = 'button';
  resetGyro.textContent = 'Reset gyroscope';
  resetGyro.addEventListener('click', (event) => {
    event.stopPropagation();
    actions.resetGyroscope();
    refreshAll();
  });
  resets.append(resetCamera, resetGyro);
  root.appendChild(resets);

  const report = (): string => {
    const s = actions.getSettings();
    return [
      `gyro: ${describeParallax()}`,
      `settings: ${JSON.stringify(s)}`,
      `ua: ${navigator.userAgent}`,
    ].join('\n');
  };

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'gyro-hud__copy';
  copy.textContent = 'Copy report';
  copy.addEventListener('click', (event) => {
    event.stopPropagation();
    const text = report();
    const done = (ok: boolean) => {
      copy.textContent = ok
        ? 'Copied — paste it to the chat'
        : 'Could not copy; long-press the text';
      setTimeout(() => (copy.textContent = 'Copy report'), 2500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => done(true),
        () => done(false)
      );
    } else {
      done(false);
    }
  });
  root.appendChild(copy);

  const refreshAll = (): void => {
    readout.textContent = describeParallax();
    refreshers.forEach((refresh) => refresh());
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  const show = (): void => {
    if (!root.isConnected) document.body.appendChild(root);
    root.hidden = false;
    if (!timer) timer = setInterval(refreshAll, 250);
    refreshAll();
  };
  const hide = (): void => {
    root.hidden = true;
    if (timer) clearInterval(timer);
    timer = null;
  };
  const isShown = (): boolean => !root.hidden;
  const toggle = (): void => (isShown() ? hide() : show());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'g' || event.key === 'G') toggle();
  });

  return { toggle, show, hide, isShown, report };
};
