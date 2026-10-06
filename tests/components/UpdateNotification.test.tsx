import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateProvider, useUpdate } from "@/contexts/UpdateContext";
import { checkForUpdate } from "@/lib/updater";

vi.mock("@/lib/updater", () => ({ checkForUpdate: vi.fn() }));

let state: ReturnType<typeof useUpdate>;
function Probe() {
  state = useUpdate();
  return state.hasUpdate && !state.isDismissed ? (
    <button onClick={state.dismissUpdate}>
      {state.updateInfo?.availableVersion}
    </button>
  ) : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(checkForUpdate).mockReset();
});
afterEach(() => vi.useRealTimers());

describe("application update notification", () => {
  it("checks shortly after startup and exposes the update to the sidebar for a self revision", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({
      status: "available",
      info: { currentVersion: "3.20.1", availableVersion: "3.20.2-1" },
    });
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
    expect(checkForUpdate).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(state.updateInfo?.availableVersion).toBe("3.20.2-1");
    fireEvent.click(screen.getByRole("button", { name: "3.20.2-1" }));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not show a notification when no update is available", async () => {
    vi.mocked(checkForUpdate).mockResolvedValue({ status: "up-to-date" });
    render(
      <UpdateProvider>
        <Probe />
      </UpdateProvider>,
    );
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(state.hasUpdate).toBe(false);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
