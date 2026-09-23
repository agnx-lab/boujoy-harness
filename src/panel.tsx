// 场景：Boujoy 薄壳 — host.guest.mount（auth:none → direct-iframe）；首帧品牌扫光；详情配置变更重挂。
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  WorkspaceAppBrandLogoLoaderPanelProps,
  WorkspaceAppHostApi,
} from "@getagnx/app-sdk";
import {
  BOUJOY_APP_ID,
  BOUJOY_ENSURE_GATEWAY_TOOL_REL,
  BOUJOY_PATHS_CONFIG_KEY,
} from "./constants";
import {
  boujoyPathsToEnsureArgs,
  loadBoujoyPathsFromHost,
} from "./boujoy-config";
import {
  bindBoujoyHost as bindHostSingleton,
  requireBoundHost,
} from "./host-bind";

const WEB_ROOT_STYLE: CSSProperties = {
  flex: "1 1 0%",
  alignSelf: "stretch",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  backgroundColor: "transparent",
};

const GUEST_HOST_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
};

const BOOT_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  background: "rgb(9, 9, 11)",
};

const ERROR_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 3,
  display: "flex",
  flexDirection: "column",
  background: "rgba(9,9,11,0.88)",
};

const ERROR_FALLBACK_STYLE: CSSProperties = {
  ...ERROR_LAYER_STYLE,
  alignItems: "center",
  justifyContent: "center",
  color: "#a1a1aa",
  padding: 24,
  textAlign: "center",
};

const RETAIN_REASON = "boujoy-harness-open";

const styles = StyleSheet.create(
  (theme) => ({
    fallbackRoot: {
      flex: 1,
      minHeight: 0,
      minWidth: 0,
      backgroundColor: "transparent",
    },
    title: {
      fontSize: theme.fontSize.xl,
      fontWeight: "600",
      padding: theme.spacing[6],
      color: theme.colors.foreground,
    },
    meta: {
      fontSize: theme.fontSize.sm,
      paddingHorizontal: theme.spacing[6],
      paddingTop: theme.spacing[3],
      color: theme.colors.foregroundMuted,
    },
  }),
  "boujoy-harness-panel",
);

export function bindBoujoyHost(host: WorkspaceAppHostApi): void {
  bindHostSingleton(host);
}

function getHost(): WorkspaceAppHostApi {
  return requireBoundHost();
}

function canUseGuestSurface(): boolean {
  return typeof document !== "undefined" && getHost().platform.isWeb;
}

export function BoujoyHarnessPanel(_props: {
  appId: string;
  panelId: string;
  entityId: string;
}): ReactElement {
  const guestHostRef = useRef<HTMLDivElement | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mountNonce, setMountNonce] = useState(0);

  useEffect(() => {
    const host = getHost();
    host.background?.requestRetain?.({
      appId: BOUJOY_APP_ID,
      active: true,
      reason: RETAIN_REASON,
    });
    return () => {
      host.background?.requestRetain?.({
        appId: BOUJOY_APP_ID,
        active: false,
        reason: RETAIN_REASON,
      });
    };
  }, []);

  useEffect(() => {
    const host = getHost();
    if (!host.config?.subscribe) {
      return;
    }
    return host.config.subscribe({
      scope: "app",
      appId: BOUJOY_APP_ID,
      key: BOUJOY_PATHS_CONFIG_KEY,
      emitCurrent: false,
      listener: () => {
        setMountNonce((n) => n + 1);
      },
    });
  }, []);

  useEffect(() => {
    if (!canUseGuestSurface()) {
      setBooting(false);
      setError("当前平台暂不支持嵌入 Boujoy，请使用 Agnx 桌面端。");
      return;
    }

    let cancelled = false;
    let unmountGuest: (() => void) | null = null;

    const mountGuest = async () => {
      const host = getHost();
      const container = guestHostRef.current;
      if (!container) {
        return;
      }
      if (!host.guest?.mount) {
        if (!cancelled) {
          setBooting(false);
          setError("宿主未提供 host.guest.mount（需升级 Agnx 并重新扫描子应用）");
        }
        return;
      }

      unmountGuest?.();
      unmountGuest = null;
      setBooting(true);
      setError(null);

      try {
        const paths = await loadBoujoyPathsFromHost(host.config);
        if (cancelled || !guestHostRef.current) {
          return;
        }
        unmountGuest = host.guest.mount({
          container: guestHostRef.current,
          ensureTool: BOUJOY_ENSURE_GATEWAY_TOOL_REL,
          ensureArgs: boujoyPathsToEnsureArgs(paths),
          timeoutMs: 90_000,
          bootOverlay: false,
          bootTitle: "正在启动 Boujoy 工作台…",
          onReady: () => {
            if (!cancelled) {
              setError(null);
              window.setTimeout(() => {
                if (!cancelled) {
                  setBooting(false);
                }
              }, 320);
            }
          },
          onError: (detail) => {
            if (!cancelled) {
              setBooting(false);
              setError(`${detail.code}: ${detail.message}`);
            }
          },
        });
      } catch (err) {
        if (!cancelled) {
          setBooting(false);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void mountGuest();

    return () => {
      cancelled = true;
      unmountGuest?.();
    };
  }, [mountNonce]);

  if (!canUseGuestSurface()) {
    return (
      <View style={styles.fallbackRoot} testID="workspace-mini-app-boujoy-harness-unsupported">
        <Text style={styles.title}>Boujoy 工作台</Text>
        <Text style={styles.meta}>{error ?? "请使用 Agnx 桌面端打开。"}</Text>
      </View>
    );
  }

  const BrandPanel = getHost().ui
    ?.BrandLogoLoaderPanel as ComponentType<WorkspaceAppBrandLogoLoaderPanelProps> | undefined;

  return (
    <div style={WEB_ROOT_STYLE} data-testid="workspace-mini-app-boujoy-harness-panel">
      <div
        ref={guestHostRef}
        data-agnx-guest-surface-host="true"
        data-testid="workspace-mini-app-boujoy-harness-root"
        style={GUEST_HOST_STYLE}
      />
      {booting && !error && BrandPanel ? (
        <div data-agnx-guest-boot-overlay="true" style={BOOT_LAYER_STYLE} role="status">
          <BrandPanel
            title="正在启动 Boujoy 工作台…"
            description="正在连接受管网关"
            testID="boujoy-harness-boot-overlay"
          />
        </div>
      ) : null}
      {booting && !error && !BrandPanel ? (
        <div data-agnx-guest-boot-overlay="true" style={ERROR_FALLBACK_STYLE} role="status">
          正在启动 Boujoy 工作台…
        </div>
      ) : null}
      {error && BrandPanel ? (
        <div style={ERROR_LAYER_STYLE} role="alert">
          <BrandPanel
            title={error}
            description="打开命令面板 → Boujoy → 诊断，复制 Guest Surface。检查详情「配置」中的 vault / dshRoot。"
            testID="boujoy-harness-mount-error"
          />
        </div>
      ) : null}
      {error && !BrandPanel ? (
        <div style={ERROR_FALLBACK_STYLE} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
