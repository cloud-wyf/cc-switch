import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProxyScriptField } from "@/components/providers/forms/ProxyScriptField";
import {
  ProviderForm,
  type ProviderFormProps,
} from "@/components/providers/forms/ProviderForm";

const api = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock("@/lib/api/providers", () => ({
  providersApi: { validateProxyScript: api.validate },
}));
vi.mock("@/hooks/useDarkMode", () => ({ useDarkMode: () => false }));
vi.mock("@/components/JsonEditor", () => ({
  default: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
// Isolate the shared wrapper so script persistence is checked independently of each app's protocol form.
vi.mock("@/components/providers/forms/GrokBuildProviderForm", () => ({
  GrokBuildProviderForm: (props: ProviderFormProps) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit({
          name: "test",
          settingsConfig: "{}",
          meta: props.initialData?.meta,
        });
      }}
    >
      {props.proxyScriptField}
      <button type="submit">保存供应商</button>
    </form>
  ),
}));

beforeEach(() => {
  api.validate.mockReset();
});

describe("ProxyScriptField", () => {
  it("reports syntax failures without executing the editor contents", async () => {
    api.validate.mockRejectedValue(
      new Error("SyntaxError: missing expression"),
    );
    render(
      <ProxyScriptField
        value="export default ("
        onChange={vi.fn()}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "校验语法" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "missing expression",
    );
    expect(api.validate).toHaveBeenCalledWith("export default (");
  });

  it("does not show an outdated successful validation for edited code", async () => {
    let finish!: () => void;
    api.validate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(
      <ProxyScriptField
        value="export default () => new Response();"
        onChange={vi.fn()}
        enabled
        onEnabledChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "校验语法" }));
    rerender(
      <ProxyScriptField
        value="export default ("
        onChange={vi.fn()}
        enabled
        onEnabledChange={vi.fn()}
      />,
    );
    await act(async () => finish());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("per-provider proxy script persistence", () => {
  it("preserves code across disabling, reopening, and re-enabling", () => {
    const source = "export default (_request, next) => next();\n";
    const props = {
      appId: "grokbuild" as const,
      providerId: "a",
      submitLabel: "保存",
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
    };
    const { unmount } = render(
      <ProviderForm
        {...props}
        initialData={{
          meta: { localProxyScript: source, costMultiplier: "2" },
        }}
      />,
    );
    const toggle = screen.getByRole("switch", { name: "启用代理脚本" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    const editor = screen.getByRole("textbox", {
      name: "TypeScript 代理中间件",
    });
    expect(editor).toHaveValue(source);
    expect(editor).toBeEnabled();
    expect(props.onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存供应商" }));
    const saved = props.onSubmit.mock.lastCall![0];
    expect(saved.meta).toEqual({
      localProxyScript: source,
      localProxyScriptEnabled: false,
      costMultiplier: "2",
    });

    unmount();
    render(<ProviderForm {...props} initialData={{ meta: saved.meta }} />);
    const restoredToggle = screen.getByRole("switch", { name: "启用代理脚本" });
    expect(restoredToggle).not.toBeChecked();
    expect(
      screen.getByRole("textbox", { name: "TypeScript 代理中间件" }),
    ).toHaveValue(source);
    const expand = screen.getByRole("button", { name: "供应商代理脚本" });
    fireEvent.click(expand);
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(restoredToggle);
    expect(restoredToggle).toBeChecked();
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "保存供应商" }));
    expect(props.onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        meta: { ...saved.meta, localProxyScriptEnabled: true },
      }),
    );
    fireEvent.click(expand);
    expect(
      screen.getByRole("textbox", { name: "TypeScript 代理中间件" }),
    ).toHaveValue(source);
  });

  it("saves and clears the script while retaining unrelated metadata", async () => {
    const onSubmit = vi.fn();
    render(
      <ProviderForm
        appId="grokbuild"
        providerId="a"
        submitLabel="保存"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        initialData={{
          meta: {
            localProxyScript: "export default (_request, next) => next();",
            costMultiplier: "2",
          },
        }}
      />,
    );
    const editor = screen.getByRole("textbox", {
      name: "TypeScript 代理中间件",
    });
    fireEvent.change(editor, {
      target: { value: "export default () => new Response('local');" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存供应商" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          meta: {
            localProxyScript: "export default () => new Response('local');",
            localProxyScriptEnabled: true,
            costMultiplier: "2",
          },
        }),
      ),
    );
    fireEvent.change(editor, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "保存供应商" }));
    expect(onSubmit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        meta: {
          localProxyScript: undefined,
          localProxyScriptEnabled: true,
          costMultiplier: "2",
        },
      }),
    );
  });

  it("loads the selected provider's own script and switch state", async () => {
    const props = {
      appId: "grokbuild" as const,
      submitLabel: "保存",
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
    };
    const { rerender } = render(
      <ProviderForm
        {...props}
        providerId="a"
        initialData={{ meta: { localProxyScript: "script-a" } }}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "TypeScript 代理中间件" }),
    ).toHaveValue("script-a");
    expect(screen.getByRole("switch", { name: "启用代理脚本" })).toBeChecked();
    rerender(
      <ProviderForm
        {...props}
        providerId="b"
        initialData={{
          meta: {
            localProxyScript: "script-b",
            localProxyScriptEnabled: false,
          },
        }}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "TypeScript 代理中间件" }),
      ).toHaveValue("script-b"),
    );
    expect(
      screen.getByRole("switch", { name: "启用代理脚本" }),
    ).not.toBeChecked();
    rerender(
      <ProviderForm
        {...props}
        providerId="b"
        initialData={{
          meta: { localProxyScript: "script-b", localProxyScriptEnabled: true },
        }}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "启用代理脚本" }),
      ).toBeChecked(),
    );
  });
});
