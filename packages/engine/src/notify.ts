// Engine → user notifications, by injection (V2-ARCHITECTURE.md §1.2).
//
// The engine has a few things to tell the person — "loaded", "textures kept
// for this session only", "this is a legacy config" — but it must not know
// what a snackbar or a modal is. The UI installs a Notifier at startup; with
// none installed (the standalone player) every call is a no-op.

export type Notifier = {
  info?: (message: string, timeout?: number) => void;
  success?: (message: string, timeout?: number) => void;
  error?: (message: string, timeout?: number) => void;
  /** A config in the pre-2.x format was loaded and converted. */
  legacyConfig?: () => void;
};

let notifier: Notifier = {};

export const setNotifier = (next: Notifier): void => {
  notifier = next ?? {};
};

export const notify = {
  info: (message: string, timeout?: number): void => notifier.info?.(message, timeout),
  success: (message: string, timeout?: number): void => notifier.success?.(message, timeout),
  error: (message: string, timeout?: number): void => notifier.error?.(message, timeout),
  legacyConfig: (): void => notifier.legacyConfig?.(),
};
