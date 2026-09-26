#!/usr/bin/env node
/**
 * 场景：短跑 sidecar — 确保 Boujoy 网关（+ 可选 DSH）已起；路径变更则停旧再起。
 * 用法：node tools/ensure-boujoy-gateway.mjs [--work-dir <dataRoot>] [--vault <path>]
 *       [--dsh-root <path>] [--python <bin>] [--knowledge-home <path>] [--clean-home <path>] [--port <n>]
 * stdout：单行 JSON { ok, port, origin, reused, pid, vault, dshRoot, warnings? }
 */
import { execFileSync, spawn } from "node:child_process";
import { access, constants as fsConstants, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const gatewayScript = path.join(appRoot, "web", "boujoy_server.py");
const defaultVault = path.join(appRoot, "demo-vault");
const defaultPython = "/usr/bin/python3";
const defaultPort = 8766;
/** Boujoy 心跳 product 字段；禁止把同端口其它 HTTP 服务当健康。 */
const BOUJOY_PRODUCT_MARKER = "Boujoy Harness";

function parseArgs(argv) {
  let workDir = process.env.AGNX_APP_DATA_ROOT || "";
  let vault = "";
  let dshRoot = "";
  let python = "";
  let knowledgeHome = "";
  let cleanHome = "";
  let port = defaultPort;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--work-dir" || arg === "--workDir") && next) {
      workDir = String(next).trim();
      i += 1;
    } else if (arg === "--vault" && next) {
      vault = String(next).trim();
      i += 1;
    } else if ((arg === "--dsh-root" || arg === "--dshRoot") && next) {
      dshRoot = String(next).trim();
      i += 1;
    } else if (arg === "--python" && next) {
      python = String(next).trim();
      i += 1;
    } else if ((arg === "--knowledge-home" || arg === "--knowledgeHome") && next) {
      knowledgeHome = String(next).trim();
      i += 1;
    } else if ((arg === "--clean-home" || arg === "--cleanHome") && next) {
      cleanHome = String(next).trim();
      i += 1;
    } else if (arg === "--port" && next) {
      const n = Number(next);
      if (Number.isFinite(n) && n > 0) {
        port = n;
      }
      i += 1;
    }
  }
  const resolvedDsh = dshRoot ? path.resolve(dshRoot) : "";
  return {
    workDir: workDir || path.join(appRoot, ".agnx-boujoy-runtime"),
    vault: path.resolve(vault || process.env.BOUJOY_VAULT_DIR || defaultVault),
    dshRoot: resolvedDsh,
    python: python || process.env.BOUJOY_PYTHON_BIN || defaultPython,
    knowledgeHome: knowledgeHome
      ? path.resolve(knowledgeHome)
      : resolvedDsh
        ? path.join(resolvedDsh, "home")
        : "",
    cleanHome: cleanHome
      ? path.resolve(cleanHome)
      : resolvedDsh
        ? path.join(resolvedDsh, "clean-home")
        : "",
    port,
  };
}

function fingerprint(cfg) {
  return JSON.stringify({
    vault: cfg.vault,
    dshRoot: cfg.dshRoot || "",
    python: cfg.python,
    knowledgeHome: cfg.knowledgeHome || "",
    cleanHome: cfg.cleanHome || "",
    port: cfg.port,
  });
}

function sameFingerprint(left, right) {
  return String(left || "") === String(right || "");
}

function httpGetOk(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      // 仅 2xx：404/3xx 不得当「网关已起」（曾误把同口 Jev 当 Boujoy）
      resolve(res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function httpGetJson(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode == null || res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) {
    return false;
  }
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function pidLooksLikeBoujoyGateway(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) {
    return false;
  }
  try {
    const out = execFileSync("ps", ["-p", String(n), "-o", "command="], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return out.includes("boujoy_server.py");
  } catch {
    return false;
  }
}

function isBoujoyHealthBody(body) {
  return (
    body != null &&
    typeof body === "object" &&
    body.ok === true &&
    body.ready === true &&
    body.services != null &&
    typeof body.services === "object" &&
    body.services.gateway === true
  );
}

function isBoujoyHeartbeatBody(body) {
  return (
    body != null &&
    typeof body === "object" &&
    body.ok === true &&
    String(body.product || "").includes(BOUJOY_PRODUCT_MARKER)
  );
}

async function isGatewayHealthy(port) {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }
  const health = await httpGetJson(`http://127.0.0.1:${port}/api/health`);
  if (isBoujoyHealthBody(health)) {
    return true;
  }
  const heartbeat = await httpGetJson(`http://127.0.0.1:${port}/api/heartbeat`);
  return isBoujoyHeartbeatBody(heartbeat);
}

/** 任意 HTTP 应答（含 404）= 端口上有服务；连接失败才算空闲。 */
function httpResponds(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

/** 端口上有任意 HTTP 应答，但不是 Boujoy 指纹 → 禁止 reuse / 禁止误报启动成功。 */
async function isForeignHttpOnPort(port) {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }
  if (await isGatewayHealthy(port)) {
    return false;
  }
  return httpResponds(`http://127.0.0.1:${port}/`);
}

function canReuseExistingProcess(existing) {
  if (!existing || !Number.isFinite(existing.port)) {
    return false;
  }
  const pid = existing.pid;
  if (!isPidAlive(pid)) {
    return false;
  }
  return pidLooksLikeBoujoyGateway(pid);
}

async function readState(statePath) {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Number.isFinite(parsed.port)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function stopPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) {
    return;
  }
  try {
    process.kill(n, "SIGTERM");
  } catch {
    // ignore
  }
}

function stopExisting(existing) {
  stopPid(existing?.pid);
  if (Array.isArray(existing?.childPids)) {
    for (const child of existing.childPids) {
      stopPid(child);
    }
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isGatewayHealthy(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function spawnDetached(command, args, { cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errBuf = "";
  child.stderr?.on("data", (chunk) => {
    errBuf += chunk.toString();
    if (errBuf.length > 8000) {
      errBuf = errBuf.slice(-8000);
    }
  });
  child.unref();
  return { child, getStderr: () => errBuf };
}

async function ensureDsh({ dshRoot, home, port, clean, vault, warnings }) {
  if (!dshRoot) {
    return null;
  }
  const dshBin = path.join(dshRoot, "node_modules", ".bin", "dsh");
  if (!(await pathExists(dshBin))) {
    warnings.push(`未找到 dsh：${dshBin}（请在详情配置填写正确的 DeepSeek Harness 根目录）`);
    return null;
  }
  if (await httpGetOk(`http://127.0.0.1:${port}/`)) {
    return null;
  }
  await mkdir(home, { recursive: true });
  const runtimeBin = path.join(dshRoot, "runtime", "bin");
  const cwd = clean ? process.env.HOME || appRoot : vault;
  const { child } = spawnDetached(dshBin, ["web", "--host", "127.0.0.1", "--port", String(port)], {
    cwd,
    env: {
      ...process.env,
      BOUJOY_DSH_ROOT: dshRoot,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: "1",
      PATH: `${runtimeBin}:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ""}`,
    },
  });
  return child.pid ?? null;
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const warnings = [];
  await access(gatewayScript);
  if (!(await pathExists(cfg.python))) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `Python 不存在：${cfg.python}（请在详情 → 配置填写可执行路径）`,
      }),
    );
    process.exitCode = 1;
    return;
  }
  await mkdir(cfg.vault, { recursive: true });
  await mkdir(cfg.workDir, { recursive: true });
  const statePath = path.join(cfg.workDir, "boujoy-gateway.json");
  const wantedFp = fingerprint(cfg);

  const existing = await readState(statePath);
  if (existing && (await isGatewayHealthy(existing.port))) {
    if (sameFingerprint(existing.fingerprint, wantedFp)) {
      // HTTP 指纹已证明是 Boujoy；state.pid 可能过期，尽量用 /api/health.pid 刷新
      const health = await httpGetJson(`http://127.0.0.1:${existing.port}/api/health`);
      const livePid =
        health && Number.isFinite(health.pid) && health.pid > 0
          ? health.pid
          : canReuseExistingProcess(existing)
            ? existing.pid
            : existing.pid ?? null;
      if (livePid != null && livePid !== existing.pid) {
        try {
          await writeFile(
            statePath,
            `${JSON.stringify({ ...existing, pid: livePid }, null, 2)}\n`,
            "utf8",
          );
        } catch {
          // ignore
        }
      }
      console.log(
        JSON.stringify({
          ok: true,
          reused: true,
          port: existing.port,
          pid: livePid,
          origin: `http://127.0.0.1:${existing.port}`,
          vault: cfg.vault,
          dshRoot: cfg.dshRoot || "",
          warnings: existing.warnings || [],
        }),
      );
      return;
    }
    // HTTP 已是真 Boujoy，但 fingerprint 对不上 → 停旧再起
    stopExisting(existing);
    await new Promise((resolve) => setTimeout(resolve, 500));
  } else if (existing && !(await isGatewayHealthy(existing.port))) {
    // stale state：端口被其它服务占用或进程已死 → 只杀我们记过的 pid，不杀外站
    stopExisting(existing);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (await isForeignHttpOnPort(cfg.port)) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `端口 ${cfg.port} 已被其它 HTTP 服务占用，且不是 Boujoy 网关（/api/health 无 Boujoy 指纹）。请结束占用进程或改 Boujoy 端口后再开。`,
      }),
    );
    process.exitCode = 1;
    return;
  }

  // 同口已有真 Boujoy（无 state / fingerprint 已变且旧进程未死透）→ 勿再 bind
  if (await isGatewayHealthy(cfg.port)) {
    const health = await httpGetJson(`http://127.0.0.1:${cfg.port}/api/health`);
    const livePid = health && Number.isFinite(health.pid) ? health.pid : null;
    stopPid(livePid);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isGatewayHealthy(cfg.port)) {
      console.log(
        JSON.stringify({
          ok: false,
          error: `端口 ${cfg.port} 上仍有 Boujoy 网关但无法安全接管，请手动结束后再开。`,
        }),
      );
      process.exitCode = 1;
      return;
    }
  }

  const childPids = [];
  if (cfg.dshRoot && cfg.knowledgeHome) {
    const knowledgePid = await ensureDsh({
      dshRoot: cfg.dshRoot,
      home: cfg.knowledgeHome,
      port: 3080,
      clean: false,
      vault: cfg.vault,
      warnings,
    });
    if (knowledgePid) {
      childPids.push(knowledgePid);
    }
  }
  if (cfg.dshRoot && cfg.cleanHome) {
    const cleanPid = await ensureDsh({
      dshRoot: cfg.dshRoot,
      home: cfg.cleanHome,
      port: 3081,
      clean: true,
      vault: cfg.vault,
      warnings,
    });
    if (cleanPid) {
      childPids.push(cleanPid);
    }
  }

  const gatewayArgs = [
    gatewayScript,
    "--port",
    String(cfg.port),
    "--vault",
    cfg.vault,
    "--static",
    path.join(appRoot, "web"),
  ];
  if (cfg.knowledgeHome) {
    gatewayArgs.push("--knowledge-home", cfg.knowledgeHome);
  }
  if (cfg.cleanHome) {
    gatewayArgs.push("--clean-home", cfg.cleanHome);
  }

  const { child, getStderr } = spawnDetached(cfg.python, gatewayArgs, {
    cwd: path.join(appRoot, "web"),
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      BOUJOY_DISABLE_PARENT_WATCH: "1",
      BOUJOY_ALLOW_IFRAME: "1",
    },
  });

  const ready = await waitForHealth(cfg.port, 45_000);
  if (!ready) {
    stopPid(child.pid);
    for (const pid of childPids) {
      stopPid(pid);
    }
    console.log(
      JSON.stringify({
        ok: false,
        error: `启动 Boujoy 网关超时（端口 ${cfg.port}）${getStderr() ? `；stderr=${getStderr().slice(-500)}` : ""}`,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const state = {
    ok: true,
    port: cfg.port,
    pid: child.pid,
    childPids,
    vault: cfg.vault,
    dshRoot: cfg.dshRoot || "",
    fingerprint: wantedFp,
    warnings,
    origin: `http://127.0.0.1:${cfg.port}`,
    startedAt: new Date().toISOString(),
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  console.log(
    JSON.stringify({
      ok: true,
      reused: false,
      port: state.port,
      pid: state.pid,
      origin: state.origin,
      vault: state.vault,
      dshRoot: state.dshRoot,
      warnings,
    }),
  );
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
});
