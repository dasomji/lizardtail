import { spawn } from "node:child_process";

// Child-process boundary shared by host probes and journeys. Tests use disposable
// children and short deadlines; the host runner supplies the production budgets.
export async function command(
  cmd,
  args,
  {
    cwd,
    env = process.env,
    preflight = false,
    timeout = preflight ? 30000 : 900000,
    // Four containers can each consume a 10s stop deadline, plus user-unit teardown.
    grace = 120000,
  } = {},
) {
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnError;
  let terminate;
  let kill;
  child.stdout.on("data", (data) => {
    stdout += data;
    if (!preflight) process.stdout.write(data);
  });
  child.stderr.on("data", (data) => {
    stderr += data;
    if (!preflight) process.stderr.write(data);
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  const deadline = setTimeout(() => {
    timedOut = true;
    console.error(
      `${cmd} timed out; sending SIGINT; fixtures may be retained if cleanup did not complete`,
    );
    child.kill("SIGINT");
    terminate = setTimeout(() => {
      console.error(`${cmd}: cleanup grace expired; sending SIGTERM`);
      child.kill("SIGTERM");
      kill = setTimeout(() => {
        console.error(`${cmd}: termination grace expired; sending SIGKILL`);
        child.kill("SIGKILL");
      }, grace);
    }, grace);
  }, timeout);
  const [status, signal] = await new Promise((resolve) => {
    child.on("close", (code, signal) => resolve([code, signal]));
  });
  clearTimeout(deadline);
  clearTimeout(terminate);
  clearTimeout(kill);
  if (spawnError || timedOut || status !== 0) {
    // Probes are quiet on success, but keep both streams on failure as well.
    if (preflight) {
      process.stdout.write(stdout);
      process.stderr.write(stderr);
    }
    throw Error(
      `${preflight ? "preflight: " : ""}${cmd} failed: ${spawnError?.message || (timedOut && "timed out after SIGINT") || stderr.trim() || stdout.trim() || signal || `exit ${status}`}`,
    );
  }
  if (/Cleanup:/i.test(stdout + stderr))
    throw Error(`${cmd}: cleanup failure reported`);
  return stdout;
}
