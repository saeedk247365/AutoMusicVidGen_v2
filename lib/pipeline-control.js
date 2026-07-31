/**
 * Pipeline control errors for pause / stop.
 */
import { spawnSync } from "child_process";

export class PauseError extends Error {
  constructor(message = "Pipeline paused") {
    super(message);
    this.name = "PauseError";
  }
}

export class StopError extends Error {
  constructor(message = "Pipeline stopped") {
    super(message);
    this.name = "StopError";
  }
}

/** Kill a child and its descendants (needed on Windows for nested node/npm). */
export function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {
    /* ignore */
  }
}
