import { invoke } from "@tauri-apps/api/core";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string;
  notes?: string;
  pubDate?: string;
}

export async function checkForUpdate(): Promise<
  { status: "up-to-date" } | { status: "available"; info: UpdateInfo }
> {
  // 私有仓库认证只在后端处理，访问令牌不进入 WebView。
  const info = await invoke<UpdateInfo | null>("check_app_update");
  return info ? { status: "available", info } : { status: "up-to-date" };
}
