import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import JsonEditor from "@/components/JsonEditor";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { useDarkMode } from "@/hooks/useDarkMode";
import { providersApi } from "@/lib/api/providers";
import { PROXY_SCRIPT_EXAMPLE } from "@/lib/proxyScript";

interface ProxyScriptFieldProps {
  value: string;
  onChange: (value: string) => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

export function ProxyScriptField({
  value,
  onChange,
  enabled,
  onEnabledChange,
}: ProxyScriptFieldProps) {
  const { t } = useTranslation();
  const darkMode = useDarkMode();
  const [expanded, setExpanded] = useState(Boolean(value.trim()));
  const [checking, setChecking] = useState(false);
  const [validation, setValidation] = useState<{
    source: string;
    error?: string;
  } | null>(null);
  const currentValidation = validation?.source === value ? validation : null;

  const checkSyntax = async () => {
    const source = value;
    setChecking(true);
    try {
      await providersApi.validateProxyScript(source);
      setValidation({ source });
    } catch (error) {
      setValidation({ source, error: String(error) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="rounded-lg border border-border/50 bg-muted/20"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <CollapsibleTrigger
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          {t("proxyScript.title", { defaultValue: "供应商代理脚本" })}
        </CollapsibleTrigger>
        <Switch
          checked={enabled}
          onCheckedChange={onEnabledChange}
          aria-label={t("proxyScript.enabled", {
            defaultValue: "启用代理脚本",
          })}
        />
      </div>
      <CollapsibleContent>
        <div className="space-y-3 border-t border-border/50 p-4">
          <p className="text-sm text-muted-foreground">
            {t("proxyScript.description", {
              defaultValue:
                "填写单文件 TypeScript 中间件，启用后选择此供应商会自动开启本地路由。关闭开关会保留代码并跳过执行，保存后生效。",
            })}
          </p>
          <JsonEditor
            value={value}
            onChange={onChange}
            language="typescript"
            darkMode={darkMode}
            height={300}
            showValidation={false}
            ariaLabel={t("proxyScript.editor", {
              defaultValue: "TypeScript 代理中间件",
            })}
            placeholder={PROXY_SCRIPT_EXAMPLE}
          />
          <p className="text-xs text-muted-foreground">
            {t("proxyScript.runtime", {
              defaultValue:
                "需要本机 Node.js 24+，支持 node: 内置模块。脚本拥有当前用户的本机权限；next(request) 继承 CC Switch 的网络代理设置。",
            })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {!value.trim() && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onChange(PROXY_SCRIPT_EXAMPLE)}
              >
                {t("proxyScript.example", { defaultValue: "插入透传示例" })}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={checking || !value.trim()}
              onClick={checkSyntax}
            >
              {checking
                ? t("proxyScript.checking", { defaultValue: "正在校验…" })
                : t("proxyScript.validate", { defaultValue: "校验语法" })}
            </Button>
            {currentValidation && !currentValidation.error && (
              <span className="text-xs text-muted-foreground" role="status">
                {t("proxyScript.valid", {
                  defaultValue: "语法校验通过（未执行脚本）",
                })}
              </span>
            )}
          </div>
          {currentValidation?.error && (
            <p
              className="whitespace-pre-wrap break-all text-xs text-destructive"
              role="alert"
            >
              {currentValidation.error}
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
