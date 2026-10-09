import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { ToolProgress } from "./useToolManagement";

export function ToolActionProgress({ progress }: { progress: ToolProgress }) {
  const { t } = useTranslation();
  const logRef = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  useEffect(() => {
    if (logRef.current && followOutput.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [progress.logs]);

  return (
    <div className="space-y-1 text-caption text-fg-2">
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <span>{t(`appsPage.progress.${progress.stage}`)}</span>
        <span className="text-fg-3">
          {t(`appsPage.network.${progress.networkMode}`)}
        </span>
      </div>
      {progress.logs.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none hover:text-fg-1">
            {t("appsPage.progress.logs")}
          </summary>
          <pre
            ref={logRef}
            tabIndex={0}
            aria-label={t("appsPage.progress.logs")}
            onScroll={(event) => {
              const el = event.currentTarget;
              followOutput.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-control bg-muted p-2 font-mono text-caption"
          >
            {progress.logs.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
