// 场景：详情「配置」路径 UI — 短标签 + 内容宽横排芯片 + Python 输入/保存同行（禁止右栏 stretch 满宽灰砖）。
import { createElement, useCallback, useEffect, useState, type ReactElement } from "react";
import { Pressable, Text, TextInput, View, type ViewStyle } from "react-native";
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

/** 内容宽芯片：禁止 flex 拉满右栏。 */
function chipChrome(colorScheme: string, pressed: boolean): ViewStyle {
  const dark = colorScheme !== "light";
  return {
    alignSelf: "flex-start",
    flexGrow: 0,
    flexShrink: 0,
    borderWidth: 1.5,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 28,
    justifyContent: "center",
    alignItems: "center",
    borderColor: dark ? "rgba(255,255,255,0.48)" : "rgba(0,0,0,0.28)",
    backgroundColor: pressed
      ? dark
        ? "rgba(255,255,255,0.26)"
        : "rgba(0,0,0,0.12)"
      : dark
        ? "rgba(255,255,255,0.16)"
        : "rgba(0,0,0,0.06)",
  };
}

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

  const inputBg =
    theme.colorScheme === "light" ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.08)";
  const inputBorder =
    theme.colorScheme === "light" ? "rgba(0,0,0,0.22)" : "rgba(255,255,255,0.35)";
  const primaryBg = theme.colors.accent;
  const primaryFg = theme.colors.accentForeground || theme.colors.background;

  if (!directory) {
    return (
      <View style={styles.wrap} testID={`boujoy-path-field-${field}`}>
        <View style={styles.pythonRow}>
          <TextInput
            style={[
              styles.inputInline,
              {
                color: theme.colors.foreground,
                borderColor: inputBorder,
                backgroundColor: inputBg,
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
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void onCommitTyped()}
            style={({ pressed }) => [
              styles.saveChip,
              {
                backgroundColor: primaryBg,
                opacity: busy ? 0.5 : pressed ? 0.88 : 1,
              },
            ]}
          >
            <Text style={[styles.btnText, { color: primaryFg, fontWeight: "600" }]}>
              {busy ? "…" : "保存"}
            </Text>
          </Pressable>
        </View>
        {error ? (
          <Text
            style={{ color: theme.colors.statusWarning || theme.colors.statusDanger, fontSize: 12 }}
          >
            {error}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.wrap} testID={`boujoy-path-field-${field}`}>
      <Text
        style={[
          styles.pathText,
          { color: value ? theme.colors.foreground : theme.colors.foregroundMuted },
        ]}
        selectable
      >
        {value || emptyHint}
      </Text>
      <View style={styles.chipRow}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void onPickDirectory()}
          style={({ pressed }) => [chipChrome(theme.colorScheme, pressed), { opacity: busy ? 0.5 : 1 }]}
        >
          <Text style={[styles.btnText, { color: theme.colors.foreground, fontWeight: "500" }]}>
            {busy ? "…" : "选择目录"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void onClear()}
          style={({ pressed }) => [chipChrome(theme.colorScheme, pressed), { opacity: busy ? 0.5 : 1 }]}
        >
          <Text style={[styles.btnText, { color: theme.colors.foreground, fontWeight: "500" }]}>
            恢复
          </Text>
        </Pressable>
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
          label: "Vault",
          value: paths.vault || "默认 demo-vault",
          copyText: paths.vault || undefined,
          helpText:
            "Boujoy Markdown Vault 根目录（不是 Agnx 工程路径）。更换后会重启本机网关并刷新 Tab。",
          groupId: "boujoy-paths",
          groupTitle: "路径",
          valueContent: createElement(PathDetailField, {
            field: "vault",
            emptyHint: "（默认：App 内 demo-vault）",
            pickTitle: "选择 Boujoy Vault 目录",
            directory: true,
          }),
        },
        {
          label: "DSH",
          value: paths.dshRoot || "未配置",
          copyText: paths.dshRoot || undefined,
          helpText:
            "DeepSeek Harness 根目录（需含 node_modules/.bin/dsh）。未配置仍可开 UI，但 Agent 不可用。",
          groupId: "boujoy-paths",
          groupTitle: "路径",
          valueContent: createElement(PathDetailField, {
            field: "dshRoot",
            emptyHint: "（未配置则不拉起 dsh）",
            pickTitle: "选择 DeepSeek Harness 根目录",
            directory: true,
          }),
        },
        {
          label: "Python",
          value: paths.python || "/usr/bin/python3",
          copyText: paths.python || undefined,
          helpText: "运行 boujoy_server.py 的 Python 3。留空则用 /usr/bin/python3。",
          groupId: "boujoy-paths",
          groupTitle: "路径",
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
      alignItems: "flex-start",
      gap: 6,
    },
    pathText: {
      fontSize: 12,
      lineHeight: 16,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    chipRow: {
      flexDirection: "row",
      flexWrap: "nowrap",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
    },
    pythonRow: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "stretch",
      width: "100%",
      gap: 6,
      minWidth: 0,
    },
    inputInline: {
      flex: 1,
      minWidth: 0,
      fontSize: 12,
      lineHeight: 16,
      borderWidth: 1.5,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      minHeight: 28,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    saveChip: {
      alignSelf: "center",
      flexGrow: 0,
      flexShrink: 0,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
      minHeight: 28,
      justifyContent: "center",
      alignItems: "center",
    },
    btnText: {
      fontSize: 12,
    },
  },
  "boujoy-detail-config",
);
