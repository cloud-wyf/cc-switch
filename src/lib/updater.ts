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
  // 可选更新令牌由后端读取，未配置时匿名检查，已有令牌不返回 WebView。
  const info = await invoke<UpdateInfo | null>("check_app_update");
  return info ? { status: "available", info } : { status: "up-to-date" };
}
