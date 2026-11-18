import { invoke } from "@tauri-apps/api/core";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion: string;
  notes?: string;
  pubDate?: string;
}

/** 自动更新在后台下好、等用户确认安装的版本（后端 `app_update::ReadyUpdate`）。 */
export interface ReadyUpdate {
  version: string;
  notes?: string | null;
}

/** 后端 `app_update::AutoUpdateStatus`。 */
export interface AutoUpdateStatus {
  /** 这台机器能不能自动安装（便携版、Linux 非 AppImage 不行） */
  supported: boolean;
  /** 自动下载开关是否打开 */
  enabled: boolean;
  downloading: boolean;
  ready: ReadyUpdate | null;
  /** 有应用在用路由服务：重启会切断进行中的请求 */
  routingInUse: boolean;
}

/** 待安装版本变了的事件，载荷是 {@link ReadyUpdate}；null 表示下好的版本被撤回 */
export const UPDATE_READY_EVENT = "app-update-ready";

export async function checkForUpdate(): Promise<
  { status: "up-to-date" } | { status: "available"; info: UpdateInfo }
> {
  // 可选更新令牌由后端读取，未配置时匿名检查，已有令牌不返回 WebView。
  const info = await invoke<UpdateInfo | null>("check_app_update");
  return info ? { status: "available", info } : { status: "up-to-date" };
}
