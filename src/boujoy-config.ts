// 场景：W2/W3 — Boujoy 路径经 host.config app 级落盘；面板/ensure 共用。
import type { WorkspaceAppConfigApi } from "@getagnx/app-sdk";
import { BOUJOY_APP_ID, BOUJOY_PATHS_CONFIG_KEY } from "./constants";

export interface BoujoyPathsConfigDocument {
  version: 1;
  /** Markdown Vault 绝对路径；空 = App 内 demo-vault。 */
  vault: string;
  /** DeepSeek Harness 根目录；空 = ensure 自动探测 sibling `../deepseek-harness`（仍建议详情里写死）。 */
  dshRoot: string;
  /** Python 可执行文件；空 = /usr/bin/python3。 */
  python: string;
  /** 可选；空则相对 dshRoot/home。 */
  knowledgeHome: string;
  /** 可选；空则相对 dshRoot/clean-home。 */
  cleanHome: string;
}

export function defaultBoujoyPathsConfigDocument(): BoujoyPathsConfigDocument {
  return {
    version: 1,
    vault: "",
    dshRoot: "",
    python: "",
    knowledgeHome: "",
    cleanHome: "",
  };
}

export function normalizeBoujoyPathsConfigDocument(raw: unknown): BoujoyPathsConfigDocument {
  const defaults = defaultBoujoyPathsConfigDocument();
  if (!raw || typeof raw !== "object") {
    return defaults;
  }
  const doc = raw as Partial<BoujoyPathsConfigDocument>;
  return {
    version: 1,
    vault: typeof doc.vault === "string" ? doc.vault.trim() : "",
    dshRoot: typeof doc.dshRoot === "string" ? doc.dshRoot.trim() : "",
    python: typeof doc.python === "string" ? doc.python.trim() : "",
    knowledgeHome: typeof doc.knowledgeHome === "string" ? doc.knowledgeHome.trim() : "",
    cleanHome: typeof doc.cleanHome === "string" ? doc.cleanHome.trim() : "",
  };
}

export async function loadBoujoyPathsFromHost(
  config: WorkspaceAppConfigApi | null | undefined,
): Promise<BoujoyPathsConfigDocument> {
  if (!config?.get) {
    return defaultBoujoyPathsConfigDocument();
  }
  try {
    const raw = await config.get({
      scope: "app",
      appId: BOUJOY_APP_ID,
      key: BOUJOY_PATHS_CONFIG_KEY,
      defaultValue: null,
    });
    return normalizeBoujoyPathsConfigDocument(raw);
  } catch {
    return defaultBoujoyPathsConfigDocument();
  }
}

export async function saveBoujoyPathsToHost(
  config: WorkspaceAppConfigApi | null | undefined,
  patch: Partial<BoujoyPathsConfigDocument>,
): Promise<BoujoyPathsConfigDocument> {
  const current = await loadBoujoyPathsFromHost(config);
  const next = normalizeBoujoyPathsConfigDocument({ ...current, ...patch, version: 1 });
  if (!config?.set) {
    return next;
  }
  await config.set({
    scope: "app",
    appId: BOUJOY_APP_ID,
    key: BOUJOY_PATHS_CONFIG_KEY,
    value: next,
  });
  return next;
}

/** 传给 ensure sidecar 的 argv（空字段省略，交给 ensure 默认）。 */
export function boujoyPathsToEnsureArgs(doc: BoujoyPathsConfigDocument): string[] {
  const args: string[] = [];
  if (doc.vault) {
    args.push("--vault", doc.vault);
  }
  if (doc.dshRoot) {
    args.push("--dsh-root", doc.dshRoot);
  }
  if (doc.python) {
    args.push("--python", doc.python);
  }
  if (doc.knowledgeHome) {
    args.push("--knowledge-home", doc.knowledgeHome);
  }
  if (doc.cleanHome) {
    args.push("--clean-home", doc.cleanHome);
  }
  return args;
}
