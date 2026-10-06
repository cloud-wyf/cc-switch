import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ScrollText,
  X,
} from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useProxyEvents } from "@/lib/query/proxy";
import { formatDuration } from "@/lib/proxyEvents";
import type {
  ProxyEventKind,
  ProxyEventQuery,
  ProxyEventSortKey,
  ProxyEventStatusFilter,
  ProxyEventSummary,
} from "@/types/proxy";
import { getAppLabel, PROXY_APP_IDS } from "@/config/appConfig";
import { cn } from "@/lib/utils";
import { ProxyEventDetail } from "./ProxyEventDetail";

const PAGE_SIZE = 50;
const FILTERS_STORAGE_KEY = "cc-switch.proxyEventLog.filters";
const APP_OPTIONS: string[] = [...PROXY_APP_IDS, "claude-desktop"];
const KIND_OPTIONS: ProxyEventKind[] = [
  "chat",
  "count_tokens",
  "models",
  "probe",
  "compact",
  "search",
  "image",
  "other",
];
const STATUS_OPTIONS: ProxyEventStatusFilter[] = [
  "success",
  "error",
  "4xx",
  "5xx",
  "none",
];
const SORTABLE: Array<{ column: string; key: ProxyEventSortKey }> = [
  { column: "time", key: "id" },
  { column: "app", key: "app_type" },
  { column: "kind", key: "kind" },
  { column: "provider", key: "target" },
  { column: "model", key: "model" },
  { column: "status", key: "status" },
  { column: "duration", key: "duration_ms" },
];

// 应用和类型记住的是隐藏项：以后新增的应用和类型默认可见，不会被旧的选择藏掉。
interface Filters {
  hiddenApps: string[];
  hiddenKinds: ProxyEventKind[];
  status: ProxyEventStatusFilter | "all";
  script: "all" | "used" | "unused";
  model: string;
  target: string;
  search: string;
}

const EMPTY_FILTERS: Filters = {
  hiddenApps: [],
  hiddenKinds: [],
  status: "all",
  script: "all",
  model: "",
  target: "",
  search: "",
};

const knownOptions = <T,>(value: unknown, options: readonly T[]): T[] =>
  Array.isArray(value)
    ? options.filter((option) => value.includes(option))
    : [];

const text = (value: unknown) => (typeof value === "string" ? value : "");

// 存储可能来自旧版本或被改坏，逐项校验，认不出的项回到默认值。
function readFilters(): Filters {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(FILTERS_STORAGE_KEY) ?? "{}",
    );
    return {
      hiddenApps: knownOptions(saved.hiddenApps, APP_OPTIONS),
      hiddenKinds: knownOptions(saved.hiddenKinds, KIND_OPTIONS),
      status: STATUS_OPTIONS.includes(saved.status) ? saved.status : "all",
      script:
        saved.script === "used" || saved.script === "unused"
          ? saved.script
          : "all",
      model: text(saved.model),
      target: text(saved.target),
      search: text(saved.search),
    };
  } catch {
    return EMPTY_FILTERS;
  }
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** 侧栏全局页：列表和详情都留在内容区，筛选继续沿用原有存储。 */
export function ProxyEventLogPage() {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  return (
    <>
      <AppPageHeader
        icon={
          selectedId === null ? (
            <ScrollText className="h-5 w-5" strokeWidth={1.5} />
          ) : undefined
        }
        leading={
          selectedId !== null ? (
            <Button
              variant="quiet"
              size="icon-compact"
              aria-label={t("common.back")}
              onClick={() => setSelectedId(null)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          ) : undefined
        }
        title={
          selectedId === null
            ? t("nav.proxyLogs")
            : t("proxy.eventLog.viewer.detail.title", { id: selectedId })
        }
      />
      <div
        key={selectedId ?? "list"}
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto scroll-stable overflow-x-hidden px-6 pb-10 pt-4"
      >
        {selectedId === null ? (
          <ProxyEventLogList onSelect={setSelectedId} />
        ) : (
          <ProxyEventDetail id={selectedId} />
        )}
      </div>
    </>
  );
}

function statusTone(event: ProxyEventSummary): string {
  const status = event.client_status ?? event.status;
  if (status === null || status === undefined) return "text-muted-foreground";
  if (status < 400) return "text-green-600 dark:text-green-400";
  return "text-red-600 dark:text-red-400";
}

interface MultiFilterProps<T extends string> {
  label: string;
  allLabel: string;
  options: readonly T[];
  hidden: T[];
  optionLabel: (option: T) => string;
  onChange: (hidden: T[]) => void;
}

function MultiFilter<T extends string>({
  label,
  allLabel,
  options,
  hidden,
  optionLabel,
  onChange,
}: MultiFilterProps<T>) {
  const { t } = useTranslation();
  const toggle = (option: T, show: boolean) =>
    onChange(
      options.filter((item) =>
        item === option ? !show : hidden.includes(item),
      ),
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-8 w-[150px] items-center justify-between whitespace-nowrap rounded-md border border-border-default bg-background px-3 text-xs shadow-sm focus:border-border-active focus:outline-none"
        aria-label={label}
      >
        <span className="truncate">
          {hidden.length === 0
            ? allLabel
            : `${label} ${options.length - hidden.length}/${options.length}`}
        </span>
        <ChevronDown className="h-4 w-4 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="z-[100] min-w-[150px]">
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            className="pl-8 pr-2 text-xs"
            checked={!hidden.includes(option)}
            onCheckedChange={(checked) => toggle(option, checked)}
            onSelect={(event) => event.preventDefault()}
          >
            {optionLabel(option)}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-xs"
          disabled={hidden.length === 0}
          onSelect={() => onChange([])}
        >
          {t("proxy.eventLog.viewer.filters.showAll")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProxyEventLogList({
  onSelect,
}: {
  onSelect: (id: number) => void;
}) {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<Filters>(readFilters);
  const [sortBy, setSortBy] = useState<ProxyEventSortKey>("id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const model = useDebounced(filters.model, 300);
  const target = useDebounced(filters.target, 300);
  const search = useDebounced(filters.search, 300);

  const query: ProxyEventQuery = {
    excludeAppTypes: filters.hiddenApps,
    excludeKinds: filters.hiddenKinds,
    status: filters.status === "all" ? undefined : filters.status,
    scriptUsed:
      filters.script === "all" ? undefined : filters.script === "used",
    model: model.trim() || undefined,
    target: target.trim() || undefined,
    search: search.trim() || undefined,
    sortBy,
    sortDir,
    page,
    pageSize: PAGE_SIZE,
  };
  const { data, isPending, isError, isFetching, refetch } =
    useProxyEvents(query);

  useEffect(() => {
    window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
  }, [filters]);

  useEffect(() => {
    setPage(0);
  }, [
    filters.hiddenApps,
    filters.hiddenKinds,
    filters.status,
    filters.script,
    model,
    target,
    search,
  ]);

  const update = (patch: Partial<Filters>) =>
    setFilters((current) => ({ ...current, ...patch }));
  const active = [
    filters.hiddenApps.length > 0,
    filters.hiddenKinds.length > 0,
    filters.status !== "all",
    filters.script !== "all",
    filters.model.trim() !== "",
    filters.target.trim() !== "",
    filters.search.trim() !== "",
  ].filter(Boolean).length;
  const toggleSort = (key: ProxyEventSortKey) => {
    if (sortBy === key) {
      setSortDir((current) => (current === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(key);
      setSortDir("desc");
    }
    setPage(0);
  };

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4" data-testid="proxy-event-list">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/50 p-2">
        <MultiFilter
          label={t("proxy.eventLog.viewer.filters.app")}
          allLabel={t("proxy.eventLog.viewer.filters.allApps")}
          options={APP_OPTIONS}
          hidden={filters.hiddenApps}
          optionLabel={getAppLabel}
          onChange={(hiddenApps) => update({ hiddenApps })}
        />
        <MultiFilter
          label={t("proxy.eventLog.viewer.filters.kind")}
          allLabel={t("proxy.eventLog.viewer.filters.allKinds")}
          options={KIND_OPTIONS}
          hidden={filters.hiddenKinds}
          optionLabel={(kind) => t(`proxy.eventLog.viewer.kinds.${kind}`)}
          onChange={(hiddenKinds) => update({ hiddenKinds })}
        />
        <Select
          value={filters.status}
          onValueChange={(value) =>
            update({ status: value as Filters["status"] })
          }
        >
          <SelectTrigger
            className="h-8 w-[130px] text-xs"
            aria-label={t("proxy.eventLog.viewer.filters.status")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t("proxy.eventLog.viewer.status.all")}
            </SelectItem>
            {STATUS_OPTIONS.map((status) => (
              <SelectItem key={status} value={status}>
                {t(`proxy.eventLog.viewer.status.${status}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.script}
          onValueChange={(value) =>
            update({ script: value as Filters["script"] })
          }
        >
          <SelectTrigger
            className="h-8 w-[130px] text-xs"
            aria-label={t("proxy.eventLog.viewer.filters.script")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t("proxy.eventLog.viewer.script.all")}
            </SelectItem>
            <SelectItem value="used">
              {t("proxy.eventLog.viewer.script.used")}
            </SelectItem>
            <SelectItem value="unused">
              {t("proxy.eventLog.viewer.script.unused")}
            </SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="h-8 w-[150px] text-xs"
          aria-label={t("proxy.eventLog.viewer.filters.target")}
          placeholder={t("proxy.eventLog.viewer.filters.target")}
          value={filters.target}
          onChange={(event) => update({ target: event.target.value })}
        />
        <Input
          className="h-8 w-[150px] text-xs"
          aria-label={t("proxy.eventLog.viewer.filters.model")}
          placeholder={t("proxy.eventLog.viewer.filters.model")}
          value={filters.model}
          onChange={(event) => update({ model: event.target.value })}
        />
        <Input
          className="h-8 min-w-[200px] flex-1 text-xs"
          aria-label={t("proxy.eventLog.viewer.filters.search")}
          placeholder={t("proxy.eventLog.viewer.filters.search")}
          value={filters.search}
          onChange={(event) => update({ search: event.target.value })}
        />
        {active > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => setFilters(EMPTY_FILTERS)}
          >
            <X className="mr-1 h-3.5 w-3.5" />
            {t("proxy.eventLog.viewer.filters.reset", { count: active })}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw
            className={cn("mr-1 h-3.5 w-3.5", isFetching && "animate-spin")}
          />
          {t("proxy.eventLog.viewer.refresh")}
        </Button>
      </div>

      {data && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="proxy-event-summary"
        >
          {[
            t("proxy.eventLog.viewer.summary.total", { count: data.total }),
            t("proxy.eventLog.viewer.summary.failed", { count: data.failed }),
            t("proxy.eventLog.viewer.summary.scriptUsed", {
              count: data.scriptUsed,
            }),
            t("proxy.eventLog.viewer.summary.avgDuration", {
              value: formatDuration(data.avgDurationMs),
            }),
          ].join(" · ")}
        </p>
      )}

      {isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("proxy.eventLog.viewer.loadFailed")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/50 bg-card/40">
          <Table>
            <TableHeader>
              <TableRow>
                {SORTABLE.map(({ column, key }) => (
                  <TableHead
                    key={column}
                    className="whitespace-nowrap"
                    aria-sort={
                      sortBy === key
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-medium hover:text-foreground"
                      onClick={() => toggleSort(key)}
                    >
                      {t(`proxy.eventLog.viewer.columns.${column}`)}
                      {sortBy === key &&
                        (sortDir === "asc" ? (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        ))}
                    </button>
                  </TableHead>
                ))}
                <TableHead className="whitespace-nowrap">
                  {t("proxy.eventLog.viewer.columns.script")}
                </TableHead>
                <TableHead>
                  {t("proxy.eventLog.viewer.columns.result")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-center text-muted-foreground"
                  >
                    {t("common.loading")}
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    className="text-center text-muted-foreground"
                  >
                    {t("proxy.eventLog.viewer.noData")}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((event) => (
                  <TableRow
                    key={event.id}
                    className="cursor-pointer"
                    onClick={() => onSelect(event.id)}
                    data-testid="proxy-event-row"
                  >
                    <TableCell className="whitespace-nowrap text-xs tabular-nums">
                      {event.started_at.slice(5, 19)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {event.app_type ? getAppLabel(event.app_type) : "—"}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-xs"
                      title={`${event.method} ${event.url}`}
                    >
                      {event.kind
                        ? t(`proxy.eventLog.viewer.kinds.${event.kind}`)
                        : "—"}
                    </TableCell>
                    <TableCell
                      className="max-w-[160px] truncate text-sm"
                      title={event.target}
                    >
                      {event.attempt === 0 ? (
                        <span className="text-muted-foreground">
                          {t("proxy.eventLog.viewer.notForwarded")}
                        </span>
                      ) : (
                        event.target
                      )}
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate font-mono text-xs">
                      {event.request_model &&
                      event.model &&
                      event.request_model !== event.model ? (
                        <span title={`${event.request_model} → ${event.model}`}>
                          {event.request_model}
                          <span className="text-muted-foreground">
                            {" "}
                            → {event.model}
                          </span>
                        </span>
                      ) : (
                        (event.model ?? event.request_model ?? "—")
                      )}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "whitespace-nowrap text-xs tabular-nums",
                        statusTone(event),
                      )}
                    >
                      {event.status === null || event.status === undefined
                        ? (event.client_status ??
                          t("proxy.eventLog.viewer.status.none"))
                        : event.client_status !== null &&
                            event.client_status !== undefined &&
                            event.client_status !== event.status
                          ? `${event.status} → ${event.client_status}`
                          : event.status}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs tabular-nums">
                      {formatDuration(event.duration_ms)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {event.script_used ? (
                        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                          {t("proxy.eventLog.viewer.scriptUsed")}
                        </span>
                      ) : null}
                      {event.route_changed ? (
                        <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                          {t("proxy.eventLog.viewer.routeChanged")}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell
                      className="max-w-[320px] truncate text-xs"
                      title={event.error ?? undefined}
                    >
                      {event.error ? (
                        <span className="text-red-600 dark:text-red-400">
                          {event.error}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          {event.finish_reason}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {t("proxy.eventLog.viewer.page", { page: page + 1, pages })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            aria-label={t("proxy.eventLog.viewer.prev")}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={page + 1 >= pages}
            onClick={() => setPage((current) => current + 1)}
            aria-label={t("proxy.eventLog.viewer.next")}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
