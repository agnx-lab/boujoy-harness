// 场景：W4 — 极薄 Agnx Agent 工具：boujoy_health / boujoy_open；不镜像 DSH 工具表。
import type { WorkspaceAppHostApi } from "@getagnx/app-sdk";
import {
  BOUJOY_APP_ID,
  BOUJOY_ENSURE_GATEWAY_TOOL_REL,
  BOUJOY_PANEL_ID,
} from "./constants";
import { boujoyPathsToEnsureArgs, loadBoujoyPathsFromHost } from "./boujoy-config";

const GROUP = {
  groupId: "boujoy",
  groupTitle: "Boujoy 工作台",
} as const;

function pickEnsurePayload(result: {
  resultJson?: unknown;
  stdout?: string;
}): Record<string, unknown> | null {
  const json = result.resultJson;
  if (json && typeof json === "object" && json !== null) {
    return json as Record<string, unknown>;
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  for (const line of stdout.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // continue
    }
  }
  return null;
}

export function registerBoujoyAgentTools(host: WorkspaceAppHostApi): () => void {
  return host.registerAgentTools({
    appId: BOUJOY_APP_ID,
    availability: "always",
    tools: [
      {
        name: "boujoy_health",
        ...GROUP,
        description:
          "检查 Boujoy 本机网关是否就绪（必要时短跑 ensure）。返回 origin/port/vault 与 warnings；不代替 Boujoy/DSH 内的 Agent 工具。",
        inputSchema: {
          type: "object",
          properties: {
            ensure: {
              type: "boolean",
              description: "为 true 时主动跑 ensure（默认 true）",
            },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const ensure = input?.ensure !== false;
          if (!ensure) {
            return {
              ok: true,
              message: "未执行 ensure；请打开 Boujoy Tab 或设 ensure:true。",
            };
          }
          if (!host.tools?.run) {
            return {
              ok: false,
              error: "host_tools_unavailable",
              message: "需 Agnx 桌面端 host.tools.run。",
            };
          }
          const paths = await loadBoujoyPathsFromHost(host.config);
          const result = await host.tools.run({
            appId: BOUJOY_APP_ID,
            tool: BOUJOY_ENSURE_GATEWAY_TOOL_REL,
            args: boujoyPathsToEnsureArgs(paths),
            timeoutMs: 90_000,
          });
          const payload = pickEnsurePayload(result);
          if (payload) {
            return payload;
          }
          return {
            ok: false,
            error: "empty_ensure_result",
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stderr: result.stderr?.slice(0, 400),
          };
        },
      },
      {
        name: "boujoy_open",
        ...GROUP,
        description:
          "在工作区打开 Boujoy 工作台 Tab（原 Boujoy UI + DeepSeek Harness 网关）。打开后由用户/Agent 在 Boujoy 内继续任务。",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: async () => {
          host.openMiniAppTab({
            appId: BOUJOY_APP_ID,
            panelId: BOUJOY_PANEL_ID,
          });
          return {
            ok: true,
            appId: BOUJOY_APP_ID,
            panelId: BOUJOY_PANEL_ID,
            message: "已请求打开 Boujoy 工作台 Tab。",
          };
        },
      },
    ],
  });
}
