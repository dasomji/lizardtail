// Share one cleanup promise between normal finally and termination signals.
// Keep both handlers installed while cleanup runs so escalation cannot interrupt it.
export function smokeCleanup(cleanup) {
  let pending;
  let interrupted = false;
  const once = () => {
    if (!pending) {
      const started = performance.now();
      pending = Promise.resolve()
        .then(cleanup)
        .finally(() => {
          console.error(
            `Smoke cleanup finished in ${((performance.now() - started) / 1000).toFixed(2)}s`,
          );
        });
    }
    return pending;
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      if (interrupted) return;
      interrupted = true;
      console.error(`${signal}: cleaning smoke fixtures before exit`);
      once().then(
        () => process.exit(code),
        (error) => {
          console.error(error);
          process.exit(code);
        },
      );
    });
  }
  return once;
}
