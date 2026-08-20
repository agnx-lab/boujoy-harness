// 场景：Boujoy 工作台 Sub App 入口 — 薄壳 + ensure + iframe + 详情配置。
import type { WorkspaceAppHostApi, WorkspaceAppModule } from "@getagnx/app-sdk";
import { Bot } from "lucide-react-native";
import {
  BOUJOY_APP_ID,
  BOUJOY_ENSURE_GATEWAY_TOOL_REL,
  BOUJOY_OPEN_COMMAND_ID,
  BOUJOY_PANEL_ID,
} from "./constants";
import { registerBoujoyAgentTools } from "./agent-tools";
import { registerBoujoyDetailConfig } from "./detail-config";
import { bindBoujoyHost, BoujoyHarnessPanel } from "./panel";

export const appId = BOUJOY_APP_ID;

function openBoujoyTab(
  host: WorkspaceAppHostApi,
  context?: {
    serverId?: string;
    workspaceId?: string;
    currentPathname?: string | null;
  },
): void {
  host.openMiniAppTab({
    appId: BOUJOY_APP_ID,
    panelId: BOUJOY_PANEL_ID,
    serverId: context?.serverId,
    workspaceId: context?.workspaceId,
    currentPathname: context?.currentPathname,
  });
}

export function activate(host: WorkspaceAppHostApi): void {
  bindBoujoyHost(host);
  registerBoujoyDetailConfig(host);
  registerBoujoyAgentTools(host);

  host.registerMiniApp({
    id: BOUJOY_PANEL_ID,
    appId: BOUJOY_APP_ID,
    title: "Boujoy 工作台",
    icon: Bot,
    component: BoujoyHarnessPanel,
    iframeShortcutCapture: true,
    isolation: {
      mode: "iframe",
      sidecarTools: [BOUJOY_ENSURE_GATEWAY_TOOL_REL],
      note: "Tab iframe 加载受管 Boujoy 网关；ensure-boujoy-gateway 短跑拉起/复用",
    },
  });

  host.registerCommand({
    id: BOUJOY_OPEN_COMMAND_ID,
    appId: BOUJOY_APP_ID,
    title: "Boujoy 工作台",
    keywords: [
      "boujoy",
      "harness",
      "deepseek",
      "dsh",
      "agent workbench",
      "工作台",
    ],
    icon: Bot,
    sidebarAction: {
      defaultVisible: true,
      label: "Boujoy",
      order: 59,
    },
    run: (context) => {
      openBoujoyTab(host, context);
    },
  });
}

const moduleExport: WorkspaceAppModule = {
  appId: BOUJOY_APP_ID,
  activate,
};

export default moduleExport;

export {
  BOUJOY_APP_ID,
  BOUJOY_OPEN_COMMAND_ID,
  BOUJOY_PANEL_ID,
} from "./constants";
export { BoujoyHarnessPanel } from "./panel";
