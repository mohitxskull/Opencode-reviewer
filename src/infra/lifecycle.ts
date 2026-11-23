// Why: Node/Bun signal listeners (`process.on("SIGINT", ...)`) execute in FIFO
// registration order. If outer `InPlaceCheckoutSession` registers before inner
// `SuggestionCompilerVerifier` and calls `process.exit()` directly, a signal
// arriving mid-`cargo check` would switch git branches (`git checkout -f`) BEFORE
// the verifier's `finally` block can write `originalBytes` back, corrupting the
// developer's working tree. `registerSignalCleanup` maintains a LIFO cleanup stack
// so inner critical sections always roll back before outer checkout restoration.

type SignalCleanupFn = () => void;

const cleanupStack: SignalCleanupFn[] = [];
let signalListenersAttached = false;
let handlingSignal = false;

function handleSignal(signal: NodeJS.Signals): void {
  if (handlingSignal) {
    return;
  }
  handlingSignal = true;
  triggerSignalCleanup();
  const exitCode = signal === "SIGINT" ? 130 : 143;
  process.exit(exitCode);
}

function onSigInt(): void {
  handleSignal("SIGINT");
}

function onSigTerm(): void {
  handleSignal("SIGTERM");
}

function updateSignalListeners(): void {
  if (cleanupStack.length > 0 && !signalListenersAttached) {
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    signalListenersAttached = true;
  } else if (cleanupStack.length === 0 && signalListenersAttached) {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    signalListenersAttached = false;
  }
}

export function registerSignalCleanup(fn: SignalCleanupFn): () => void {
  cleanupStack.push(fn);
  updateSignalListeners();

  let unregistered = false;
  return () => {
    if (unregistered) {
      return;
    }
    unregistered = true;
    const idx = cleanupStack.lastIndexOf(fn);
    if (idx !== -1) {
      cleanupStack.splice(idx, 1);
    }
    updateSignalListeners();
  };
}

export function triggerSignalCleanup(): void {
  while (cleanupStack.length > 0) {
    const fn = cleanupStack.pop();
    if (!fn) {
      continue;
    }
    try {
      fn();
    } catch {
      // Ensure remaining LIFO cleanups run even if one throws
    }
  }
  updateSignalListeners();
}
