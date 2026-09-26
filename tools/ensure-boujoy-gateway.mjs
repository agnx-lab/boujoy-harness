#!/usr/bin/env node
/**
 * 场景：短跑 sidecar — 确保 Boujoy 网关 + 专用 DSH 引擎（3180/3181）已起。
 * 用法：node tools/ensure-boujoy-gateway.mjs [--work-dir <dataRoot>] [--vault <path>]
 *       [--dsh-root <path>] [--python <bin>] [--knowledge-home <path>] [--clean-home <path>] [--port <n>]
 *       [--supervised] [--force-restart]
 * stdout：单行 JSON { ok, port, origin, reused, pid, vault, dshRoot, warnings? }；
 *         --supervised 时含 plan 供 daemon spawn（ensure 本身不长驻；DSH 仍由 ensure 拉起）
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
/** 避开 deepseek-harness 默认 3080；Boujoy 自管引擎用专用口。 */
const DEFAULT_KNOWLEDGE_PORT = 3180;
const DEFAULT_CLEAN_PORT = 3181;
/** Boujoy 心跳 product 字段；禁止把同端口其它 HTTP 服务当健康。 */
const BOUJOY_PRODUCT_MARKER = "Boujoy Harness";
const AUTH_URL_RE = /https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s"'\\]+/g;

function parseArgs(argv) {
  let workDir = process.env.AGNX_APP_DATA_ROOT || "";
  let vault = "";
  let dshRoot = "";
  let python = "";
  let knowledgeHome = "";
  let cleanHome = "";
  let port = defaultPort;
  let supervised = false;
  let forceRestart = false;
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
    } else if (arg === "--supervised") {
      supervised = true;
    } else if (arg === "--force-restart" || arg === "--forceRestart") {
      forceRestart = true;
    }
  }
  const resolvedWork = workDir || path.join(appRoot, ".agnx-boujoy-runtime");
  const resolvedDsh = dshRoot ? path.resolve(dshRoot) : "";
  return {
    workDir: resolvedWork,
    vault: path.resolve(vault || process.env.BOUJOY_VAULT_DIR || defaultVault),
    dshRoot: resolvedDsh,
    python: python || process.env.BOUJOY_PYTHON_BIN || defaultPython,
    knowledgeHome: knowledgeHome
      ? path.resolve(knowledgeHome)
      : path.join(resolvedWork, "dsh-knowledge-home"),
    cleanHome: cleanHome ? path.resolve(cleanHome) : path.join(resolvedWork, "dsh-clean-home"),
    knowledgePort: DEFAULT_KNOWLEDGE_PORT,
    cleanPort: DEFAULT_CLEAN_PORT,
    port,
    supervised,
    forceRestart,
  };
}

function fingerprint(cfg) {
  return JSON.stringify({
    vault: cfg.vault,
    dshRoot: cfg.dshRoot || "",
    python: cfg.python,
    knowledgeHome: cfg.knowledgeHome || "",
    cleanHome: cfg.cleanHome || "",
    knowledgePort: cfg.knowledgePort,
    cleanPort: cfg.cleanPort,
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
  if (existing?.engines) {
    stopPid(existing.engines.knowledge?.pid);
    stopPid(existing.engines.clean?.pid);
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

function spawnDetached(command, args, { cwd, env, captureOutput = false }) {
  // dsh web 把带 token 的 URL 打在 stdout（`dsh web: http://127.0.0.1:PORT/?token=…`），
  // 必须 pipe stdout；stderr 一并收，便于超时诊断。
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "ignore",
  });
  let outBuf = "";
  const append = (chunk) => {
    outBuf += chunk.toString();
    if (outBuf.length > 16_000) {
      outBuf = outBuf.slice(-16_000);
    }
  };
  if (captureOutput) {
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
  }
  child.unref();
  return { child, getOutput: () => outBuf, getStderr: () => outBuf };
}

/** pnpm 根仓未必链接 `.bin/dsh`；build 后 CLI 在 apps/cli/lib/bin.js */
async function resolveDshLaunch(dshRoot) {
  const binLink = path.join(dshRoot, "node_modules", ".bin", "dsh");
  if (await pathExists(binLink)) {
    return { command: binLink, argsPrefix: [], via: "node_modules/.bin/dsh" };
  }
  const cliBin = path.join(dshRoot, "apps", "cli", "lib", "bin.js");
  if (await pathExists(cliBin)) {
    return { command: process.execPath, argsPrefix: [cliBin], via: "apps/cli/lib/bin.js" };
  }
  return null;
}

async function resolveDefaultDshRoot(explicit) {
  if (explicit) {
    return path.resolve(explicit);
  }
  const sibling = path.resolve(appRoot, "..", "deepseek-harness");
  if (await resolveDshLaunch(sibling)) {
    return sibling;
  }
  return "";
}

function extractAuthUrl(text, port) {
  const matches = String(text || "").match(AUTH_URL_RE) || [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;]+$/u, "");
    if (url.includes(`:${port}/`)) {
      return url;
    }
  }
  return null;
}

async function waitForAuthUrl({ port, getOutput, timeoutMs = 90_000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = null;
  while (Date.now() < deadline) {
    const fromOut = extractAuthUrl(getOutput(), port);
    if (fromOut) {
      lastUrl = fromOut;
      // Token 页应 2xx；部分时机 bind 尚未完成，短暂重试。
      if (await httpGetOk(fromOut)) {
        return fromOut;
      }
      if (await httpResponds(`http://127.0.0.1:${port}/`)) {
        // 口已听且 stdout 已有 token → 视为成功（后续 gateway 会再换 cookie）
        return fromOut;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (lastUrl) {
    return lastUrl;
  }
  return null;
}

/** 停掉占用 Boujoy 引擎口的旧 dsh（避免半拉进程挡 ensure）。 */
function stopForeignListenerOnPort(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    for (const line of out.split(/\s+/).filter(Boolean)) {
      const pid = Number(line);
      if (!Number.isFinite(pid) || pid <= 0) {
        continue;
      }
      try {
        const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf8",
          timeout: 2000,
        }).trim();
        if (cmd.includes("bin.js") && cmd.includes("web") && cmd.includes(String(port))) {
          stopPid(pid);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // no listener
  }
}

/**
 * 拉起 Boujoy 专用 dsh web；返回 { pid, port, authUrl } 或 null。
 * 若 state 已有可用 authUrl 且端口仍听 → 复用。
 */
async function ensureDshEngine({
  dshRoot,
  dshLaunch,
  home,
  port,
  cwd,
  label,
  prior,
  warnings,
  forceRestart,
}) {
  if (!dshRoot || !dshLaunch) {
    return null;
  }
  const priorAuth =
    typeof prior?.authUrl === "string" && prior.authUrl.includes("token=") ? prior.authUrl : "";
  if (
    !forceRestart &&
    priorAuth &&
    Number(prior?.pid) > 0 &&
    isPidAlive(prior.pid) &&
    (await httpGetOk(priorAuth))
  ) {
    return { pid: prior.pid, port, authUrl: priorAuth, reused: true };
  }
  if (!forceRestart && priorAuth && (await httpGetOk(priorAuth))) {
    return { pid: prior?.pid ?? null, port, authUrl: priorAuth, reused: true };
  }

  if (await httpResponds(`http://127.0.0.1:${port}/`)) {
    stopForeignListenerOnPort(port);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (await httpResponds(`http://127.0.0.1:${port}/`)) {
    // 口上已有服务但不是我们带 token 的引擎 → 换不了口时告警并放弃
    warnings.push(
      `${label} 端口 ${port} 已被占用且无法复用带 token 的 dsh；请结束占用或改 Boujoy 引擎端口`,
    );
    return null;
  }

  await mkdir(home, { recursive: true });
  const runtimeBin = path.join(dshRoot, "runtime", "bin");
  const webArgs = ["web", "--host", "127.0.0.1", "--port", String(port), "--no-open"];
  const args = [...dshLaunch.argsPrefix, ...webArgs];
  const { child, getOutput } = spawnDetached(dshLaunch.command, args, {
    cwd,
    env: {
      ...process.env,
      BOUJOY_DSH_ROOT: dshRoot,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: "1",
      PATH: `${runtimeBin}:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ""}`,
    },
    captureOutput: true,
  });
  const authUrl = await waitForAuthUrl({ port, getOutput, timeoutMs: 90_000 });
  if (!authUrl) {
    const preview = getOutput().trim().slice(-400);
    stopPid(child.pid);
    warnings.push(
      `${label} dsh web 启动超时（端口 ${port}，未拿到 ?token= URL）${preview ? `；output=${preview}` : ""}`,
    );
    return null;
  }
  return { pid: child.pid ?? null, port, authUrl, reused: false };
}

async function ensureHarnessEngines(cfg, priorEngines, warnings) {
  if (!cfg.dshRoot) {
    warnings.push("未配置 dshRoot：仅网关 UI，Agent/纯净模式会提示本地服务未就绪");
    return { knowledge: null, clean: null, childPids: [] };
  }
  const dshLaunch = await resolveDshLaunch(cfg.dshRoot);
  if (!dshLaunch) {
    warnings.push(
      `未找到 dsh（${cfg.dshRoot}）。请在详情配置填写 DeepSeek Harness 根目录，并在该仓执行 pnpm install && pnpm run build`,
    );
    return { knowledge: null, clean: null, childPids: [] };
  }
  const knowledge = await ensureDshEngine({
    dshRoot: cfg.dshRoot,
    dshLaunch,
    home: cfg.knowledgeHome,
    port: cfg.knowledgePort,
    cwd: cfg.vault,
    label: "knowledge",
    prior: priorEngines?.knowledge,
    warnings,
    forceRestart: cfg.forceRestart,
  });
  const clean = await ensureDshEngine({
    dshRoot: cfg.dshRoot,
    dshLaunch,
    home: cfg.cleanHome,
    port: cfg.cleanPort,
    cwd: process.env.HOME || appRoot,
    label: "clean",
    prior: priorEngines?.clean,
    warnings,
    forceRestart: cfg.forceRestart,
  });
  const childPids = [];
  if (knowledge?.pid) {
    childPids.push(knowledge.pid);
  }
  if (clean?.pid) {
    childPids.push(clean.pid);
  }
  return { knowledge, clean, childPids };
}

function buildGatewayArgs(cfg, engines) {
  const gatewayArgs = [
    gatewayScript,
    "--port",
    String(cfg.port),
    "--vault",
    cfg.vault,
    "--static",
    path.join(appRoot, "web"),
    "--knowledge-port",
    String(cfg.knowledgePort),
    "--clean-port",
    String(cfg.cleanPort),
  ];
  if (cfg.knowledgeHome) {
    gatewayArgs.push("--knowledge-home", cfg.knowledgeHome);
  }
  if (cfg.cleanHome) {
    gatewayArgs.push("--clean-home", cfg.cleanHome);
  }
  if (engines?.knowledge?.authUrl) {
    gatewayArgs.push("--knowledge-auth-url", engines.knowledge.authUrl);
  }
  if (engines?.clean?.authUrl) {
    gatewayArgs.push("--clean-auth-url", engines.clean.authUrl);
  }
  return gatewayArgs;
}

function buildSupervisedPlan(cfg, wantedFp, engines) {
  return {
    ok: true,
    plan: {
      command: cfg.python,
      args: buildGatewayArgs(cfg, engines),
      cwd: path.join(appRoot, "web"),
      env: {
        PYTHONDONTWRITEBYTECODE: "1",
        BOUJOY_DISABLE_PARENT_WATCH: "1",
        BOUJOY_ALLOW_IFRAME: "1",
      },
      fingerprint: wantedFp,
      healthUrl: `http://127.0.0.1:${cfg.port}/api/health`,
      port: cfg.port,
      launchMode: "gateway",
    },
  };
}

async function main() {
  const raw = parseArgs(process.argv.slice(2));
  const warnings = [];
  await access(gatewayScript);
  if (!(await pathExists(raw.python))) {
    console.log(
      JSON.stringify({
        ok: false,
        error: `Python 不存在：${raw.python}（请在详情 → 配置填写可执行路径）`,
      }),
    );
    process.exitCode = 1;
    return;
  }

  const detectedDsh = await resolveDefaultDshRoot(raw.dshRoot);
  const cfg = { ...raw, dshRoot: detectedDsh };
  if (!raw.dshRoot && detectedDsh) {
    warnings.push(`已自动探测 dshRoot=${detectedDsh}`);
  }

  await mkdir(cfg.vault, { recursive: true });
  await mkdir(cfg.workDir, { recursive: true });
  const statePath = path.join(cfg.workDir, "boujoy-gateway.json");
  const wantedFp = fingerprint(cfg);
  const existing = await readState(statePath);

  if (cfg.supervised) {
    const engines = await ensureHarnessEngines(cfg, existing?.engines, warnings);
    const enginesFresh = Boolean(engines.knowledge && !engines.knowledge.reused) || Boolean(engines.clean && !engines.clean.reused);
    if (!cfg.forceRestart && !enginesFresh) {
      if (existing && sameFingerprint(existing.fingerprint, wantedFp) && (await isGatewayHealthy(existing.port))) {
        const health = await httpGetJson(`http://127.0.0.1:${existing.port}/api/health`);
        const nextState = {
          ...existing,
          engines: {
            knowledge: engines.knowledge,
            clean: engines.clean,
          },
          childPids: engines.childPids,
          warnings,
          updatedAt: Date.now(),
        };
        try {
          await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
        } catch {
          // ignore
        }
        console.log(
          JSON.stringify({
            ok: true,
            reused: true,
            port: existing.port,
            pid: health?.pid ?? existing.pid ?? null,
            origin: `http://127.0.0.1:${existing.port}`,
            vault: cfg.vault,
            dshRoot: cfg.dshRoot || "",
            healthUrl: `http://127.0.0.1:${existing.port}/api/health`,
            instanceId: health?.instanceId ?? existing.instanceId ?? undefined,
            warnings,
          }),
        );
        return;
      }
    }
    if (enginesFresh && existing && (await isGatewayHealthy(existing.port))) {
      // 引擎换了 token，旧网关 CLI 仍持旧 auth → 停掉让 daemon 按新 plan 拉起
      stopExisting(existing);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const planned = buildSupervisedPlan(cfg, wantedFp, engines);
    // 预写 engines，daemon spawn 网关后详情可读
    try {
      await writeFile(
        statePath,
        `${JSON.stringify(
          {
            port: cfg.port,
            fingerprint: wantedFp,
            vault: cfg.vault,
            dshRoot: cfg.dshRoot || "",
            engines: { knowledge: engines.knowledge, clean: engines.clean },
            childPids: engines.childPids,
            warnings,
            updatedAt: Date.now(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } catch {
      // ignore
    }
    console.log(
      JSON.stringify({
        ok: true,
        reused: false,
        port: cfg.port,
        origin: `http://127.0.0.1:${cfg.port}`,
        vault: cfg.vault,
        dshRoot: cfg.dshRoot || "",
        warnings,
        plan: planned.plan,
      }),
    );
    return;
  }

  if (existing && (await isGatewayHealthy(existing.port))) {
    if (sameFingerprint(existing.fingerprint, wantedFp) && !cfg.forceRestart) {
      const engines = await ensureHarnessEngines(cfg, existing?.engines, warnings);
      const health = await httpGetJson(`http://127.0.0.1:${existing.port}/api/health`);
      const livePid =
        health && Number.isFinite(health.pid) && health.pid > 0
          ? health.pid
          : canReuseExistingProcess(existing)
            ? existing.pid
            : (existing.pid ?? null);
      try {
        await writeFile(
          statePath,
          `${JSON.stringify(
            {
              ...existing,
              pid: livePid,
              engines: { knowledge: engines.knowledge, clean: engines.clean },
              childPids: engines.childPids,
              warnings,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } catch {
        // ignore
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
          warnings,
        }),
      );
      return;
    }
    stopExisting(existing);
    await new Promise((resolve) => setTimeout(resolve, 500));
  } else if (existing && !(await isGatewayHealthy(existing.port))) {
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

  const engines = await ensureHarnessEngines(cfg, null, warnings);
  const gatewayArgs = buildGatewayArgs(cfg, engines);
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
    for (const pid of engines.childPids) {
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
    childPids: engines.childPids,
    engines: { knowledge: engines.knowledge, clean: engines.clean },
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
