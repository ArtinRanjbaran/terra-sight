import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const apiUrl = "http://127.0.0.1:8000/api/health";
const appUrl = "http://127.0.0.1:5173";
const children = new Set();
let stopping = false;

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function isHttpReady(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function getApiHealth() {
  try {
    const response = await fetch(apiUrl, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const health = await response.json();
    return health.status === "ok" ? health : null;
  } catch {
    return null;
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function startChild(command, args, label, inheritEarthdataToken = false) {
  const childEnvironment = { ...process.env };
  if (!inheritEarthdataToken) delete childEnvironment.EARTHDATA_TOKEN;
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: childEnvironment,
    stdio: "inherit",
  });
  children.add(child);
  child.once("error", (error) => {
    child.startError = error;
    if (!stopping) {
      process.stderr.write(`${label} could not start: ${error.message}\n`);
      stopChildren(1);
    }
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      const status = signal ? `signal ${signal}` : `exit code ${code}`;
      process.stderr.write(`${label} stopped unexpectedly (${status}).\n`);
      stopChildren(code || 1);
    }
  });
  return child;
}

async function waitForService(url, child, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.startError) {
      throw new Error(`${label} could not start: ${child.startError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`${label} exited with code ${child.exitCode}.`);
    }
    if (await isHttpReady(url)) return;
    await delay(500);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1000} seconds.`);
}

async function ensureService({
  url,
  port,
  label,
  command,
  args,
  inheritEarthdataToken = false,
}) {
  if (await isHttpReady(url)) {
    log(`${label} is already responding at ${url}.`);
    return { reused: true };
  }
  if (await isPortOpen(port)) {
    throw new Error(`Port ${port} is occupied by a service that did not respond at ${url}. Stop it or change the configured port.`);
  }
  const child = startChild(command, args, label, inheritEarthdataToken);
  await waitForService(url, child, label);
  log(`${label} is ready.`);
  return { reused: false, child };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stopChildren(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) child.kill();
}

process.on("SIGINT", () => {
  log("Stopping TERRA SIGHT services…");
  stopChildren(130);
});
process.on("SIGTERM", () => stopChildren(143));

try {
  const venvPython = path.join(
    projectRoot,
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
  const python = await exists(venvPython)
    ? venvPython
    : process.platform === "win32"
      ? "python"
      : "python3";
  const vite = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
  if (!(await exists(vite))) {
    throw new Error("Vite is not installed. Run `npm install` in the project folder first.");
  }

  const backend = await ensureService({
    url: apiUrl,
    port: 8000,
    label: "NASA CMR API",
    command: python,
    args: ["-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", "8000"],
    inheritEarthdataToken: true,
  });
  if (process.env.EARTHDATA_TOKEN && backend.reused) {
    throw new Error(
      "An API is already running. Stop the old API process, then run this launcher again so it starts with the token entered in this session.",
    );
  }
  const frontend = await ensureService({
    url: appUrl,
    port: 5173,
    label: "TERRA SIGHT web app",
    command: process.execPath,
    args: [vite, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
  });
  const health = await getApiHealth();
  if (!health) throw new Error("The API health check did not return a valid response.");
  if (process.env.EARTHDATA_TOKEN && !health.earthdata_token_configured) {
    throw new Error(
      "An API is already running without Earthdata access. Stop the old API process, then run this launcher again so the token is available to the backend.",
    );
  }

  log("");
  log(`TERRA SIGHT is ready: ${appUrl}`);
  log("Catalog search works without Earthdata credentials.");
  log(health.earthdata_token_configured
    ? "Earthdata token detected by the backend process."
    : "Raster analysis is locked until EARTHDATA_TOKEN is set in this PowerShell session.");
  log("Keep this terminal open; press Ctrl+C to stop services started by this command.");

  if (backend.reused && frontend.reused) {
    log("Both services were already running; this command did not take ownership of them.");
  }
} catch (error) {
  process.stderr.write(`\nTERRA SIGHT startup failed: ${error.message}\n`);
  process.stderr.write("For Python setup, see the Run locally section in README.md.\n");
  stopChildren(1);
}
