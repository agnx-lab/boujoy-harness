// 场景：详情「配置」路径字段 — 恢复原先 DOM 按钮布局；颜色从 useUnistyles 主题取，禁止浅色硬编码。
import { createElement, useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useUnistyles } from "react-native-unistyles";
import type { WorkspaceAppHostApi } from "@getagnx/app-sdk";
import { BOUJOY_APP_ID } from "./constants";
import {
  loadBoujoyPathsFromHost,
  saveBoujoyPathsToHost,
  type BoujoyPathsConfigDocument,
} from "./boujoy-config";
import { getBoundHost } from "./host-bind";

let cachedPaths: BoujoyPathsConfigDocument = {
  version: 1,
  vault: "",
  dshRoot: "",
  python: "",
  knowledgeHome: "",
  cleanHome: "",
};

export function getCachedBoujoyPaths(): BoujoyPathsConfigDocument {
  return cachedPaths;
}

function setCachedBoujoyPaths(next: BoujoyPathsConfigDocument): void {
  cachedPaths = next;
}

const rowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 0,
  width: "100%",
};

const btnRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

type PathFieldKey = "vault" | "dshRoot" | "python";

function PathDetailField({
  field,
  emptyHint,
  pickTitle,
  directory,
}: {
  field: PathFieldKey;
  emptyHint: string;
  pickTitle: string;
  directory: boolean;
}): ReactElement {
  const { theme } = useUnistyles();
  const [value, setValue] = useState(cachedPaths[field] || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const host = getBoundHost();
        if (!host) {
          return;
        }
        const loaded = await loadBoujoyPathsFromHost(host.config);
        if (cancelled) {
          return;
        }
        setCachedBoujoyPaths(loaded);
        setValue(loaded[field] || "");
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [field]);

  const persist = useCallback(
    async (nextValue: string) => {
      const host = getBoundHost();
      if (!host) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const next = await saveBoujoyPathsToHost(host.config, { [field]: nextValue });
        setCachedBoujoyPaths(next);
        setValue(next[field] || "");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [field],
  );

  const onPickDirectory = useCallback(async () => {
    const host = getBoundHost();
    if (!host?.files?.pickDirectory) {
      setError("当前环境无法选择目录（需桌面端）");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const picked = await host.files.pickDirectory({ title: pickTitle });
      if (!picked) {
        return;
      }
      await persist(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [persist, pickTitle]);

  const onClear = useCallback(async () => {
    await persist("");
  }, [persist]);

  const onCommitTyped = useCallback(async () => {
    await persist(value.trim());
  }, [persist, value]);

  const pathStyle: CSSProperties = {
    fontSize: 12,
    lineHeight: "16px",
    color: value ? theme.colors.foreground : theme.colors.foregroundMuted,
    wordBreak: "break-all",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  };

  const btnStyle: CSSProperties = {
    border: `1px solid ${theme.colors.border}`,
    background: theme.colors.input || "rgba(255,255,255,0.06)",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    color: theme.colors.foreground,
    cursor: busy ? "default" : "pointer",
    opacity: busy ? 0.55 : 1,
  };

  const inputStyle: CSSProperties = {
    fontSize: 12,
    lineHeight: "16px",
    color: theme.colors.foreground,
    wordBreak: "break-all",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    border: `1px solid ${theme.colors.border}`,
    borderRadius: 6,
    padding: "6px 8px",
    background: theme.colors.input || "rgba(255,255,255,0.06)",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  };

  return (
    <div style={rowStyle} data-testid={`boujoy-path-field-${field}`}>
      {directory ? (
        <div style={pathStyle}>{value || emptyHint}</div>
      ) : (
        <input
          style={inputStyle}
          value={value}
          placeholder={emptyHint}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void onCommitTyped()}
        />
      )}
      <div style={btnRowStyle}>
        {directory ? (
          <>
            <button type="button" style={btnStyle} disabled={busy} onClick={() => void onPickDirectory()}>
              {busy ? "处理中…" : "选择目录"}
            </button>
            <button type="button" style={btnStyle} disabled={busy} onClick={() => void onClear()}>
              恢复默认
            </button>
          </>
        ) : (
          <button type="button" style={btnStyle} disabled={busy} onClick={() => void onCommitTyped()}>
            {busy ? "处理中…" : "保存路径"}
          </button>
        )}
      </div>
      {error ? (
        <div style={{ color: theme.colors.statusWarning || "#f59e0b", fontSize: 12 }}>{error}</div>
      ) : null}
    </div>
  );
}

export function registerBoujoyDetailConfig(host: WorkspaceAppHostApi): () => void {
  if (!host.ui?.registerDetailSheetExtras) {
    return () => {};
  }
  void loadBoujoyPathsFromHost(host.config).then((loaded) => {
    setCachedBoujoyPaths(loaded);
  });
  return host.ui.registerDetailSheetExtras({
    appId: BOUJOY_APP_ID,
    surface: "config",
    buildRows: () => {
      const paths = getCachedBoujoyPaths();
      return [
        {
          label: "Vault 目录",
          value: paths.vault || "默认 demo-vault",
          copyText: paths.vault || undefined,
          helpText:
            "Boujoy Markdown Vault 根目录（不是 Agnx 工程路径）。更换后会重启本机网关并刷新 Tab。",
          groupId: "boujoy-paths",
          groupTitle: "Boujoy 路径",
          valueContent: createElement(PathDetailField, {
            field: "vault",
            emptyHint: "（默认：App 内 demo-vault）",
            pickTitle: "选择 Boujoy Vault 目录",
            directory: true,
          }),
        },
        {
          label: "DeepSeek Harness 根目录",
          value: paths.dshRoot || "未配置",
          copyText: paths.dshRoot || undefined,
          helpText:
            "本机 DeepSeek Harness 根目录（需含 node_modules/.bin/dsh）。Boujoy 官方不附带 runtime；未配置仍可开 UI，但 Agent 不可用。",
          groupId: "boujoy-paths",
          groupTitle: "Boujoy 路径",
          valueContent: createElement(PathDetailField, {
            field: "dshRoot",
            emptyHint: "（未配置则不拉起 dsh）",
            pickTitle: "选择 DeepSeek Harness 根目录",
            directory: true,
          }),
        },
        {
          label: "Python 可执行文件",
          value: paths.python || "/usr/bin/python3",
          copyText: paths.python || undefined,
          helpText: "运行 boujoy_server.py 的 Python 3。留空则用 /usr/bin/python3。",
          groupId: "boujoy-paths",
          groupTitle: "Boujoy 路径",
          valueContent: createElement(PathDetailField, {
            field: "python",
            emptyHint: "/usr/bin/python3",
            pickTitle: "选择 python3 可执行文件",
            directory: false,
          }),
        },
      ];
    },
  });
}
