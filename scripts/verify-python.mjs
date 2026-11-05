import { command } from "./verify-command.mjs";

export async function verifyPython(options = {}) {
  try {
    await command(
      "python3",
      ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"],
      { ...options, preflight: true },
    );
  } catch (error) {
    throw Error(
      `preflight: Python 3.11+ is required (exception notes): ${error.message}`,
      { cause: error },
    );
  }
}
