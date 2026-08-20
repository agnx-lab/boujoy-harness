// 场景：详情「配置」路径字段 — RN Pressable 实心底按钮（跟宿主主题）；避免 HTML button 被 RNW 重置成纯文字链。
import { createElement, useCallback, useEffect, useState, type ReactElement } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
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

  /** 详情分组卡是 surface2；按钮须抬层，禁止 input/surface2 同色糊底。 */
  const secondaryBg = theme.colors.popover || theme.colors.surface0;
  const secondaryBorder = theme.colors.border;
  const primaryBg = theme.colors.accent;
  const primaryFg = theme.colors.accentForeground || theme.colors.background;

  return (
    <View style={styles.wrap} testID={`boujoy-path-field-${field}`}>
      {directory ? (
        <Text
          style={[
            styles.pathText,
            { color: value ? theme.colors.foreground : theme.colors.foregroundMuted },
          ]}
          selectable
        >
          {value || emptyHint}
        </Text>
      ) : (
        <TextInput
          style={[
            styles.input,
            {
              color: theme.colors.foreground,
              borderColor: theme.colors.border,
              backgroundColor: secondaryBg,
            },
          ]}
          value={value}
          placeholder={emptyHint}
          placeholderTextColor={theme.colors.foregroundMuted}
          editable={!busy}
          onChangeText={setValue}
          onBlur={() => void onCommitTyped()}
          autoCapitalize="none"
          autoCorrect={false}
        />
      )}
      <View style={styles.btnRow}>
        {directory ? (
          <>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onPickDirectory()}
              style={({ pressed }) => [
                styles.btn,
                {
                  borderColor: secondaryBorder,
                  backgroundColor: pressed ? theme.colors.surface1 || secondaryBg : secondaryBg,
                  opacity: busy ? 0.5 : 1,
                },
              ]}
            >
              <Text style={[styles.btnText, { color: theme.colors.foreground }]}>
                {busy ? "处理中…" : "选择目录"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void onClear()}
              style={({ pressed }) => [
                styles.btn,
                {
                  borderColor: secondaryBorder,
                  backgroundColor: pressed ? theme.colors.surface1 || secondaryBg : secondaryBg,
                  opacity: busy ? 0.5 : 1,
                },
              ]}
            >
              <Text style={[styles.btnText, { color: theme.colors.foreground }]}>恢复默认</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void onCommitTyped()}
            style={({ pressed }) => [
              styles.btnPrimary,
              {
                backgroundColor: primaryBg,
                opacity: busy ? 0.5 : pressed ? 0.88 : 1,
              },
            ]}
          >
            <Text style={[styles.btnText, { color: primaryFg, fontWeight: "600" }]}>
              {busy ? "处理中…" : "保存路径"}
            </Text>
          </Pressable>
        )}
      </View>
      {error ? (
        <Text style={{ color: theme.colors.statusWarning || theme.colors.statusDanger, fontSize: 12 }}>
          {error}
        </Text>
      ) : null}
    </View>
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

const styles = StyleSheet.create(
  {
    wrap: {
      width: "100%",
      minWidth: 0,
      gap: 8,
    },
    pathText: {
      fontSize: 12,
      lineHeight: 16,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    input: {
      width: "100%",
      fontSize: 12,
      lineHeight: 16,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 7,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    btnRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    /** 次级按钮：popover/surface0 抬层 + 描边，与 surface2 分组卡拉开对比。 */
    btn: {
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
      minHeight: 32,
      justifyContent: "center",
      alignItems: "center",
    },
    /** 主操作：accent 实心。 */
    btnPrimary: {
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
      minHeight: 32,
      justifyContent: "center",
      alignItems: "center",
    },
    btnText: {
      fontSize: 12,
    },
  },
  "boujoy-detail-config",
);
