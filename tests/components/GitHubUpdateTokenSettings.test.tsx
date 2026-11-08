import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubUpdateTokenSettings } from "@/components/settings/GitHubUpdateTokenSettings";
import { settingsApi } from "@/lib/api";
import { toast } from "@/lib/toast";

vi.mock("@/lib/api", () => ({
  settingsApi: {
    hasGitHubUpdateToken: vi.fn(),
    setGitHubUpdateToken: vi.fn(),
  },
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const key = (name: string) => `settings.githubUpdateToken.${name}`;

beforeEach(() => {
  vi.mocked(settingsApi.hasGitHubUpdateToken)
    .mockReset()
    .mockResolvedValue(false);
  vi.mocked(settingsApi.setGitHubUpdateToken)
    .mockReset()
    .mockResolvedValue(true);
  vi.mocked(toast.error).mockClear();
});

describe("optional GitHub update token", () => {
  it("starts anonymously, masks the draft, and clears it after saving", async () => {
    render(<GitHubUpdateTokenSettings />);
    await screen.findByText(key("anonymous"));
    const input = screen.getByLabelText(key("title"));
    expect(input).toHaveAttribute("type", "password");
    expect(settingsApi.setGitHubUpdateToken).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  test-user-token  " } });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await screen.findByText(key("authenticated"));
    expect(settingsApi.setGitHubUpdateToken).toHaveBeenCalledWith(
      "test-user-token",
    );
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("type", "password");
  });

  it("loads only the configured status and clears the stored token explicitly", async () => {
    vi.mocked(settingsApi.hasGitHubUpdateToken).mockResolvedValue(true);
    render(<GitHubUpdateTokenSettings />);
    await screen.findByText(key("authenticated"));
    expect(screen.getByLabelText(key("title"))).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "common.clear" }));
    await screen.findByText(key("anonymous"));
    expect(settingsApi.setGitHubUpdateToken).toHaveBeenCalledWith(null);
  });

  it("preserves the previous status and draft when saving fails without echoing the token", async () => {
    vi.mocked(settingsApi.setGitHubUpdateToken).mockRejectedValue(
      new Error("failure with test-secret-token"),
    );
    render(<GitHubUpdateTokenSettings />);
    await screen.findByText(key("anonymous"));
    const input = screen.getByLabelText(key("title"));
    fireEvent.change(input, { target: { value: "test-secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(key("saveFailed")),
    );
    expect(input).toHaveValue("test-secret-token");
    expect(screen.getByText(key("anonymous"))).toBeInTheDocument();
    expect(
      screen.queryByText("failure with test-secret-token"),
    ).not.toBeInTheDocument();
  });

  it("retains configured status after a failed clear", async () => {
    vi.mocked(settingsApi.hasGitHubUpdateToken).mockResolvedValue(true);
    vi.mocked(settingsApi.setGitHubUpdateToken).mockResolvedValue(false);
    render(<GitHubUpdateTokenSettings />);
    await screen.findByText(key("authenticated"));
    fireEvent.click(screen.getByRole("button", { name: "common.clear" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(key("saveFailed")),
    );
    expect(screen.getByText(key("authenticated"))).toBeInTheDocument();
  });

  it("blocks saving after a status-read failure and allows a retry", async () => {
    vi.mocked(settingsApi.hasGitHubUpdateToken)
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(false);
    render(<GitHubUpdateTokenSettings />);
    await screen.findByText(key("loadFailed"));
    expect(screen.getByLabelText(key("title"))).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await screen.findByText(key("anonymous"));
    expect(screen.getByLabelText(key("title"))).toBeEnabled();
  });
});
