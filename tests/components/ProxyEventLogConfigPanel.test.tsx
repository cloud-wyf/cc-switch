import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ProxyEventLogConfigPanel } from "@/components/proxy/ProxyEventLogConfigPanel";
import { proxyKeys } from "@/lib/query/proxy";
import type { ProxyEventLogConfig } from "@/types/proxy";
import { server } from "../msw/server";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let savedConfig: ProxyEventLogConfig;
let writes: ProxyEventLogConfig[];
let saveFails: boolean;

function renderPanel() {
  const client = createTestQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <ProxyEventLogConfigPanel />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  savedConfig = { enabled: true, logBodyLimit: 65536, purgeDays: 7 };
  writes = [];
  saveFails = false;
  server.use(
    http.post("http://tauri.local/get_proxy_event_log_config", () =>
      HttpResponse.json(savedConfig),
    ),
    http.post(
      "http://tauri.local/set_proxy_event_log_config",
      async ({ request }) => {
        if (saveFails)
          return new HttpResponse("database unavailable", { status: 500 });
        const { config } = (await request.json()) as {
          config: ProxyEventLogConfig;
        };
        savedConfig = config;
        writes.push(config);
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
});

describe("ProxyEventLogConfigPanel", () => {
  it("converts KiB to bytes when saving and restores the saved values on reopening", async () => {
    const view = renderPanel();
    const limit = await screen.findByLabelText("proxy.eventLog.bodyLimit");
    const days = screen.getByLabelText("proxy.eventLog.purgeDays");
    expect(limit).toHaveValue(64);
    expect(days).toHaveValue(7);

    fireEvent.change(limit, { target: { value: "128" } });
    fireEvent.change(days, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(writes).toEqual([
        { enabled: true, logBodyLimit: 131072, purgeDays: 30 },
      ]),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    view.unmount();
    renderPanel();
    expect(
      await screen.findByLabelText("proxy.eventLog.bodyLimit"),
    ).toHaveValue(128);
    expect(screen.getByLabelText("proxy.eventLog.purgeDays")).toHaveValue(30);
  });

  it.each([
    [0, 1],
    [1024, 365],
  ])(
    "accepts %i KiB and %i days while preserving the logging switch",
    async (limit, days) => {
      savedConfig.enabled = false;
      renderPanel();
      fireEvent.change(
        await screen.findByLabelText("proxy.eventLog.bodyLimit"),
        {
          target: { value: String(limit) },
        },
      );
      fireEvent.change(screen.getByLabelText("proxy.eventLog.purgeDays"), {
        target: { value: String(days) },
      });
      fireEvent.click(screen.getByRole("button", { name: "common.save" }));
      await waitFor(() =>
        expect(writes).toEqual([
          { enabled: false, logBodyLimit: limit * 1024, purgeDays: days },
        ]),
      );
    },
  );

  it.each([
    ["bodyLimit", "", "invalidBodyLimit"],
    ["bodyLimit", "-1", "invalidBodyLimit"],
    ["bodyLimit", "1.5", "invalidBodyLimit"],
    ["bodyLimit", "1025", "invalidBodyLimit"],
    ["purgeDays", "", "invalidPurgeDays"],
    ["purgeDays", "0", "invalidPurgeDays"],
    ["purgeDays", "1.5", "invalidPurgeDays"],
    ["purgeDays", "366", "invalidPurgeDays"],
  ])("does not save invalid %s value %s", async (field, value, message) => {
    renderPanel();
    fireEvent.change(await screen.findByLabelText(`proxy.eventLog.${field}`), {
      target: { value },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(`proxy.eventLog.${message}`),
    );
    expect(writes).toEqual([]);
  });

  it("keeps unsaved values after a save failure or background refresh and supports retry", async () => {
    saveFails = true;
    const { client } = renderPanel();
    const limit = await screen.findByLabelText("proxy.eventLog.bodyLimit");
    fireEvent.change(limit, { target: { value: "256" } });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(writes).toEqual([]);
    expect(limit).toHaveValue(256);
    await client.invalidateQueries({ queryKey: proxyKeys.eventLogConfig });
    expect(limit).toHaveValue(256);

    saveFails = false;
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(writes).toEqual([
        { enabled: true, logBodyLimit: 262144, purgeDays: 7 },
      ]),
    );
  });

  it("offers retry on load failure without saving fallback defaults", async () => {
    server.use(
      http.post(
        "http://tauri.local/get_proxy_event_log_config",
        () => new HttpResponse("database unavailable", { status: 500 }),
      ),
    );
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "proxy.eventLog.loadFailed",
    );
    expect(
      screen.queryByRole("button", { name: "common.save" }),
    ).not.toBeInTheDocument();
    server.use(
      http.post("http://tauri.local/get_proxy_event_log_config", () =>
        HttpResponse.json(savedConfig),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "proxy.eventLog.retry" }),
    );
    expect(
      await screen.findByLabelText("proxy.eventLog.bodyLimit"),
    ).toHaveValue(64);
    expect(writes).toEqual([]);
  });
});
