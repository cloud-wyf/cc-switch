import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import { DatabaseUpgrade } from "@/components/DatabaseUpgrade";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  exit: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(null);
});

describe("DatabaseUpgrade", () => {
  it("keeps local recovery and database details when the private repository has no update", async () => {
    render(
      <DatabaseUpgrade
        payload={{
          path: "D:/config/cc-switch.db",
          error: "Database schema is newer than supported",
          db_version: 42,
          supported_version: 41,
        }}
      />,
    );
    expect(await screen.findByText(/请先备份当前配置目录/)).toBeVisible();
    expect(screen.getByText("数据库版本 v42 · 应用支持 v41")).toBeVisible();
    expect(screen.getByText(/D:\/config\/cc-switch\.db/)).toBeVisible();
    expect(invoke).toHaveBeenCalledWith("check_app_update_available");
    expect(invoke).not.toHaveBeenCalledWith("install_update_and_restart");

    fireEvent.click(screen.getByRole("button", { name: "打开配置目录" }));
    expect(invoke).toHaveBeenCalledWith("open_app_config_folder");
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("waits for an explicit upgrade click and displays download progress", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "check_app_update_available") return "3.20.2-1";
      return new Promise(() => {});
    });
    render(<DatabaseUpgrade payload={{}} />);
    const upgrade = await screen.findByRole("button", { name: "升级应用" });
    expect(invoke).not.toHaveBeenCalledWith("install_update_and_restart");
    fireEvent.click(upgrade);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("install_update_and_restart"),
    );

    const onProgress = vi.mocked(listen).mock.calls[0][1];
    act(() =>
      onProgress({
        event: "update-download-progress",
        id: 1,
        payload: { downloaded: 1024, total: 2048 },
      }),
    );
    expect(screen.getByText("50%")).toBeVisible();
    expect(screen.getByRole("button", { name: "退出" })).toBeDisabled();
  });

  it("shows installation failures and opens the private release page as a fallback", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "check_app_update_available") return "3.20.2-1";
      if (command === "install_update_and_restart")
        throw new Error("GitHub 登录凭据已过期");
      return null;
    });
    render(<DatabaseUpgrade payload={{}} />);
    fireEvent.click(await screen.findByRole("button", { name: "升级应用" }));
    expect(await screen.findByText("GitHub 登录凭据已过期")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "打开发布页" }));
    expect(invoke).toHaveBeenCalledWith("check_for_updates");
    expect(screen.getByRole("button", { name: "重试升级" })).toBeEnabled();
  });

  it("returns to local recovery if the release disappears before installation", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      return command === "check_app_update_available" ? "3.20.2-1" : false;
    });
    render(<DatabaseUpgrade payload={{}} />);
    fireEvent.click(await screen.findByRole("button", { name: "升级应用" }));
    expect(await screen.findByText(/请先备份当前配置目录/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "升级应用" }),
    ).not.toBeInTheDocument();
  });
});
