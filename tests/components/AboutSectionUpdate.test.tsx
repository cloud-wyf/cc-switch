import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSection } from "@/components/settings/AboutSection";
import { settingsApi } from "@/lib/api";
import { toast } from "sonner";

const updateState = vi.hoisted(() => ({
  hasUpdate: true,
  updateInfo: { currentVersion: "3.20.1", availableVersion: "3.20.2-1" },
  checkUpdate: vi.fn(),
  resetDismiss: vi.fn(),
  isChecking: false,
}));

vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => updateState }));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("3.20.1"),
}));
vi.mock("@/lib/api", () => ({
  settingsApi: {
    getToolVersions: vi.fn().mockResolvedValue([]),
    probeToolInstallations: vi.fn().mockResolvedValue([]),
    checkUpdates: vi.fn().mockResolvedValue(undefined),
    installUpdateAndRestart: vi.fn().mockResolvedValue(false),
    openPortableUpdateDownload: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

beforeEach(() => {
  updateState.hasUpdate = true;
  updateState.checkUpdate.mockReset().mockResolvedValue(false);
  vi.mocked(settingsApi.openPortableUpdateDownload)
    .mockReset()
    .mockResolvedValue(undefined);
  vi.mocked(settingsApi.installUpdateAndRestart)
    .mockReset()
    .mockResolvedValue(false);
});

describe("AboutSection application updates", () => {
  it("uses the existing in-app install and restart flow only after clicking update", async () => {
    render(<AboutSection isPortable={false} />);
    expect(settingsApi.installUpdateAndRestart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "settings.updateTo" }));
    await waitFor(() =>
      expect(settingsApi.installUpdateAndRestart).toHaveBeenCalledTimes(1),
    );
    expect(updateState.resetDismiss).toHaveBeenCalledTimes(1);
    expect(settingsApi.checkUpdates).not.toHaveBeenCalled();
  });

  it("opens the private portable artifact for the available version", async () => {
    render(<AboutSection isPortable />);
    fireEvent.click(screen.getByRole("button", { name: "settings.updateTo" }));
    await waitFor(() =>
      expect(settingsApi.openPortableUpdateDownload).toHaveBeenCalledWith(
        "3.20.2-1",
      ),
    );
    expect(settingsApi.checkUpdates).not.toHaveBeenCalled();
    expect(settingsApi.installUpdateAndRestart).not.toHaveBeenCalled();
  });

  it("shows private-repository authentication errors during manual checks", async () => {
    updateState.hasUpdate = false;
    updateState.checkUpdate.mockRejectedValue("请使用 gh auth login 登录");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AboutSection isPortable={false} />);
    fireEvent.click(
      screen.getByRole("button", { name: "settings.checkForUpdates" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("settings.checkUpdateFailed", {
        description: "请使用 gh auth login 登录",
        closeButton: true,
      }),
    );
    errorLog.mockRestore();
  });

  it("opens release notes for the available self revision", async () => {
    render(<AboutSection isPortable={false} />);
    fireEvent.click(
      screen.getByRole("button", { name: "settings.releaseNotes" }),
    );
    await waitFor(() =>
      expect(settingsApi.checkUpdates).toHaveBeenCalledWith("3.20.2-1"),
    );
  });
});
