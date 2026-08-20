// 场景：详情「配置」路径 UI — 可读短标签；内联 flex 横排芯片；Python 真输入框与保存同行。
import { createElement, useCallback, useEffect, useState, type ReactElement } from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
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
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dark = theme.colorScheme !== "light";

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

  const pathTextStyle: TextStyle = {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    color: value ? theme.colors.foreground : theme.colors.foregroundMuted,
  };

  const errorStyle: TextStyle = {
    fontSize: 12,
    color: theme.colors.statusWarning || theme.colors.statusDanger,
  };

  if (!directory) {
    const inputStyle: TextStyle = {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 0,
      fontSize: 12,
      lineHeight: 16,
      borderWidth: 1.5,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 7,
      minHeight: 32,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      color: theme.colors.foreground,
      borderColor: focused
        ? theme.colors.accent
        : dark
          ? "rgba(255,255,255,0.4)"
          : "rgba(0,0,0,0.28)",
      backgroundColor: dark ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.92)",
    };
    const pythonRowStyle: ViewStyle = {
      display: "flex",
      flexDirection: "row",
      flexWrap: "nowrap",
      alignItems: "center",
      alignSelf: "stretch",
      width: "100%",
      gap: 6,
      minWidth: 0,
    };
    const saveStyle = (pressed: boolean): ViewStyle => ({
      alignSelf: "center",
      flexGrow: 0,
      flexShrink: 0,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
      minHeight: 32,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: theme.colors.accent,
      opacity: busy ? 0.5 : pressed ? 0.88 : 1,
    });
    const saveTextStyle: TextStyle = {
      fontSize: 12,
      fontWeight: "600",
      color: theme.colors.accentForeground || theme.colors.background,
    };

    return (
      <View
        style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 6, width: "100%" }}
        testID={`boujoy-path-field-${field}`}
      >
        <View style={pythonRowStyle}>
          <TextInput
            style={inputStyle}
            value={value}
            placeholder={emptyHint}
            placeholderTextColor={theme.colors.foregroundMuted}
            editable={!busy}
            onChangeText={setValue}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              void onCommitTyped();
            }}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void onCommitTyped()}
            style={({ pressed }) => saveStyle(pressed)}
          >
            <Text style={saveTextStyle}>{busy ? "…" : "保存"}</Text>
          </Pressable>
        </View>
        {error ? <Text style={errorStyle}>{error}</Text> : null}
      </View>
    );
  }

  const chipRowStyle: ViewStyle = {
    display: "flex",
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "center",
    alignSelf: "flex-end",
    gap: 6,
  };

  const Chip = getBoundHost()?.ui?.Chip;

  return (
    <View
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        alignSelf: "flex-end",
        maxWidth: "100%",
        gap: 6,
      }}
      testID={`boujoy-path-field-${field}`}
    >
      <Text style={[pathTextStyle, { textAlign: "right" }]} selectable>
        {value || emptyHint}
      </Text>
      <View style={chipRowStyle}>
        {Chip ? (
          <>
            {createElement(Chip, {
              label: busy ? "…" : "选择目录",
              busy,
              disabled: busy,
              onPress: () => void onPickDirectory(),
              testID: `boujoy-path-pick-${field}`,
              accessibilityLabel: "选择目录",
            })}
            {createElement(Chip, {
              label: "恢复",
              busy,
              disabled: busy,
              onPress: () => void onClear(),
              testID: `boujoy-path-restore-${field}`,
              accessibilityLabel: "恢复",
            })}
          </>
        ) : (
          <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
            （需重启 Electron 以加载 host.ui.Chip）
          </Text>
        )}
      </View>
      {error ? <Text style={errorStyle}>{error}</Text> : null}
    </View>
  );
}

function SelectPreviewField(): ReactElement {
  const host = getBoundHost();
  const Select = host?.ui?.Select;
  const [value, setValue] = useState("field-default");

  if (!Select) {
    return createElement(Text, { style: { fontSize: 12 } }, "（需重启 Electron 以加载 host.ui.Select）");
  }

  return createElement(Select, {
    value,
    onSelect: setValue,
    placeholder: "选择预览档",
    options: [
      { id: "field-default", label: "field · 默认密度" },
      { id: "field-compact", label: "field · 紧凑文案" },
      { id: "field-wide", label: "field · 宽列表项演示" },
    ],
    testID: "boujoy-select-preview",
    accessibilityLabel: "下拉样式预览",
  });
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
          groupTitle: "路径",
          valueContent: createElement(PathDetailField, {
            field: "vault",
            emptyHint: "（默认：App 内 demo-vault）",
            pickTitle: "选择 Boujoy Vault 目录",
            directory: true,
          }),
        },
        {
          label: "DSH 根目录",
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
          label: "Python 路径",
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
        {
          label: "下拉预览",
          value: "host.ui.Select · field",
          helpText: "公共 Select 控件样式预览；不影响 Boujoy 运行。满意后再统一其它 App。",
          groupId: "boujoy-ui-preview",
          groupTitle: "控件预览",
          valueContent: createElement(SelectPreviewField),
        },
      ];
    },
  });
}
