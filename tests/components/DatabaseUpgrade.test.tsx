import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import { DatabaseUpgrade } from "@/components/DatabaseUpgrade";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  exit: vi.fn().mockResolvedValue(undefined),
}));

describe("DatabaseUpgrade", () => {
  it("shows local recovery instructions and database details without checking upstream updates", () => {
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

    expect(
      screen.getByRole("heading", { name: "数据库版本过新" }),
    ).toBeVisible();
    expect(screen.getByText("数据库版本 v42 · 应用支持 v41")).toBeVisible();
    expect(screen.getByText(/D:\/config\/cc-switch\.db/)).toBeVisible();
    expect(
      screen.getByText("Database schema is newer than supported"),
    ).toBeVisible();
    expect(screen.getByText(/请先备份当前配置目录/)).toBeVisible();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("keeps the configuration folder and exit actions available when version details are missing", () => {
    render(<DatabaseUpgrade payload={{}} />);

    expect(screen.queryByText(/数据库版本 v/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开配置目录" }));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("open_app_config_folder");

    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
