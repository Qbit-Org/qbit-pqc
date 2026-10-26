const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
}

export function installTerminationHandlers({
  cleanup,
  processRef = process,
  exit = code => processRef.exit(code),
  onCleanupError = (_signal, error) => console.error(error),
  onSignal = () => {},
}) {
  if (typeof cleanup !== 'function') {
    throw new Error('termination cleanup must be a function')
  }

  let signal
  let cleanupPromise
  const listeners = new Map()

  const handleSignal = incomingSignal => {
    if (cleanupPromise) {
      return
    }

    signal = incomingSignal
    const exitCode = SIGNAL_EXIT_CODES[incomingSignal]
    processRef.exitCode = exitCode
    cleanupPromise = Promise.resolve()
      .then(cleanup)
      .catch(error => onCleanupError(incomingSignal, error))
      .finally(() => exit(exitCode))
    try {
      onSignal(incomingSignal)
    } catch (error) {
      onCleanupError(incomingSignal, error)
    }
  }

  for (const incomingSignal of Object.keys(SIGNAL_EXIT_CODES)) {
    const listener = () => handleSignal(incomingSignal)
    listeners.set(incomingSignal, listener)
    processRef.on(incomingSignal, listener)
  }

  return {
    remove() {
      for (const [incomingSignal, listener] of listeners) {
        processRef.removeListener(incomingSignal, listener)
      }
    },
    get signal() {
      return signal
    },
  }
}
