#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_OUT = path.join("reports", "latest", "data.json");

const FUND_CONFIG = [
  {
    code: "012552",
    name: "天弘芯片产业ETF联接A",
    role: "半导体核心配置",
    estimateUrl: "https://fundgz.1234567.com.cn/js/012552.js",
    officialNavUrl:
      "https://api.fund.eastmoney.com/f10/lsjz?fundCode=012552&pageIndex=1&pageSize=40",
    underlying: {
      type: "basket",
      label: "前十大持仓等权实时篮子",
      quoteSymbols: [
        "sh688041",
        "sz002371",
        "sh688981",
        "sh688256",
        "sh603986",
        "sh688008",
        "sh688012",
        "sh603501",
        "sh688521",
        "sh688525",
      ],
    },
  },
  {
    code: "021532",
    name: "天弘半导体设备指数A",
    role: "半导体设备弹性仓",
    estimateUrl: "https://fundgz.1234567.com.cn/js/021532.js",
    officialNavUrl:
      "https://api.fund.eastmoney.com/f10/lsjz?fundCode=021532&pageIndex=1&pageSize=40",
    underlying: {
      type: "basket",
      label: "前十大设备持仓等权实时篮子",
      quoteSymbols: [
        "sh688012",
        "sz002371",
        "sh688072",
        "sz300604",
        "sh688120",
        "sh688126",
        "sh688361",
        "sz300346",
        "sh688019",
        "sz300666",
      ],
    },
  },
  {
    code: "000218",
    name: "国泰黄金ETF联接A",
    role: "黄金防守仓",
    estimateUrl: "https://fundgz.1234567.com.cn/js/000218.js",
    officialNavUrl:
      "https://api.fund.eastmoney.com/f10/lsjz?fundCode=000218&pageIndex=1&pageSize=40",
    underlying: {
      type: "tencent_quote",
      label: "黄金ETF国泰",
      quoteSymbol: "sh518800",
    },
  },
];

const FRESHNESS_LIMITS = {
  intradayEstimateMinutes: 10,
  underlyingRealtimeMinutes: 5,
};

const FETCH_RETRY_ATTEMPTS = 5;
const FETCH_RETRY_BASE_DELAY_MS = 400;
const FUTURE_SKEW_TOLERANCE_MS = 60 * 1000;
const TENCENT_BATCH_CHUNK_SIZE = 40;
const execFileAsync = promisify(execFile);

const CN_TRADE_WINDOWS = [
  [9 * 60 + 30, 11 * 60 + 30],
  [13 * 60, 15 * 60],
];

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function todayInShanghai() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function parseChinaDateTime(value) {
  if (!value) return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute),
      Number(second)
    )
  );
}

function parseChinaCompactDateTime(value) {
  if (!value) return null;
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute),
      Number(second)
    )
  );
}

function formatChinaIso(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function chinaDateParts(date) {
  const offsetMs = 8 * 60 * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    weekday: local.getUTCDay(),
  };
}

function isChinaTradingDay(date) {
  const { weekday } = chinaDateParts(date);
  return weekday >= 1 && weekday <= 5;
}

function minuteOfDayInChina(date) {
  const parts = chinaDateParts(date);
  return parts.hour * 60 + parts.minute;
}

function tradingMinutesBetween(startDate, endDate) {
  if (!(startDate instanceof Date) || !(endDate instanceof Date)) return null;
  if (endDate.getTime() < startDate.getTime()) return null;

  let cursor = new Date(startDate.getTime());
  let totalMinutes = 0;

  while (cursor.getTime() < endDate.getTime()) {
    const parts = chinaDateParts(cursor);
    const dayStart = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day, -8, 0, 0)
    );
    const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const segmentEnd = nextDay.getTime() < endDate.getTime() ? nextDay : endDate;

    if (isChinaTradingDay(cursor)) {
      for (const [startMinutes, endMinutes] of CN_TRADE_WINDOWS) {
        const windowStart = new Date(dayStart.getTime() + startMinutes * 60 * 1000);
        const windowEnd = new Date(dayStart.getTime() + endMinutes * 60 * 1000);
        const overlapStart = Math.max(cursor.getTime(), windowStart.getTime());
        const overlapEnd = Math.min(segmentEnd.getTime(), windowEnd.getTime());
        if (overlapEnd > overlapStart) {
          totalMinutes += (overlapEnd - overlapStart) / 60000;
        }
      }
    }

    cursor = nextDay;
  }

  return Math.round(totalMinutes * 10) / 10;
}

function normalizeFutureSkew(startDate, endDate) {
  if (!(startDate instanceof Date) || !(endDate instanceof Date)) return null;
  const deltaMs = startDate.getTime() - endDate.getTime();
  if (deltaMs <= 0) return { startDate, endDate };
  if (deltaMs <= FUTURE_SKEW_TOLERANCE_MS) {
    return { startDate: endDate, endDate };
  }
  return null;
}

function estimateFreshnessMinutes(dataTimeValue, fetchTimeIso) {
  const dataDate = parseChinaDateTime(dataTimeValue);
  const fetchDate = new Date(fetchTimeIso);
  if (!dataDate || Number.isNaN(fetchDate.getTime())) return null;
  const normalized = normalizeFutureSkew(dataDate, fetchDate);
  if (!normalized) return null;
  return tradingMinutesBetween(normalized.startDate, normalized.endDate);
}

function parseEstimatePayload(text) {
  const match = text.match(/jsonpgz\((.*)\);?$/s);
  if (!match) {
    throw new Error("estimate payload format changed");
  }
  return JSON.parse(match[1]);
}

function parseOfficialNavPayload(payload) {
  const list = payload?.Data?.LSJZList;
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }

  const latest = list[0];
  const latestNav = toNumber(latest.DWJZ);
  const oneWeekBaseNav = toNumber(list[5]?.DWJZ);
  const oneMonthBaseNav = toNumber(list[20]?.DWJZ);
  return {
    nav: latestNav,
    accumulative_nav: toNumber(latest.LJJZ),
    nav_date: latest.FSRQ ?? null,
    daily_change_pct: toNumber(latest.JZZZL),
    performance_1d_pct: toNumber(latest.JZZZL),
    performance_1w_pct:
      latestNav !== null && oneWeekBaseNav !== null
        ? Math.round((latestNav / oneWeekBaseNav - 1) * 10000) / 100
        : null,
    performance_1m_pct:
      latestNav !== null && oneMonthBaseNav !== null
        ? Math.round((latestNav / oneMonthBaseNav - 1) * 10000) / 100
        : null,
  };
}

function parseTencentQuote(text, labelOverride = null) {
  const body = text.match(/="(.*)";?$/)?.[1];
  if (!body) return null;

  const fields = body.split("~");
  return {
    label: labelOverride ?? fields[1] ?? "实时代理",
    price: toNumber(fields[3]),
    change_amount: toNumber(fields[31]),
    change_pct: toNumber(fields[32]),
    data_time: formatChinaIso(parseChinaCompactDateTime(fields[30])),
    code: fields[2] ?? null,
  };
}

function parseTencentBatchQuotePayload(text) {
  const quotes = new Map();
  const linePattern = /v_([a-z0-9]+)="([^"]*)";?/gi;

  for (const match of text.matchAll(linePattern)) {
    const symbol = match[1];
    const body = match[2];
    const fields = body.split("~");
    if (fields.length < 33) continue;

    quotes.set(symbol, {
      symbol,
      label: fields[1] ?? symbol,
      price: toNumber(fields[3]),
      change_amount: toNumber(fields[31]),
      change_pct: toNumber(fields[32]),
      data_time: formatChinaIso(parseChinaCompactDateTime(fields[30])),
      code: fields[2] ?? null,
    });
  }

  return quotes;
}

function freshnessMinutes(dataTimeIso, fetchTimeIso) {
  if (!dataTimeIso || !fetchTimeIso) return null;
  const startDate = new Date(dataTimeIso);
  const endDate = new Date(fetchTimeIso);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  const normalized = normalizeFutureSkew(startDate, endDate);
  if (!normalized) return null;
  return tradingMinutesBetween(normalized.startDate, normalized.endDate);
}

function isDirectionalMismatch(estimate, underlying) {
  const estimatePct = toNumber(estimate?.change_pct);
  const underlyingPct = toNumber(underlying?.change_pct);
  if (estimatePct === null || underlyingPct === null) return false;
  if (Math.abs(estimatePct) < 0.3 || Math.abs(underlyingPct) < 0.3) return false;
  return Math.sign(estimatePct) !== Math.sign(underlyingPct);
}

function formatError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.name ? `${error.name}: ${error.message}` : error.message];
  const causeCode = error.cause?.code;
  const causeHost = error.cause?.hostname;
  const causeStatus = error.cause?.statusCode;

  if (causeCode) parts.push(`cause=${causeCode}`);
  if (causeStatus) parts.push(`status=${causeStatus}`);
  if (causeHost) parts.push(`host=${causeHost}`);

  return parts.join(" | ");
}

function isRetryableError(error) {
  const status = error?.status;
  const causeCode = error?.cause?.code;
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    causeCode === "ECONNRESET" ||
    causeCode === "ETIMEDOUT" ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT" ||
    causeCode === "UND_ERR_HEADERS_TIMEOUT" ||
    causeCode === "UND_ERR_SOCKET"
  );
}

function shouldUseCurlFallback(error) {
  const causeCode = error?.cause?.code;
  return (
    causeCode === "ENOTFOUND" ||
    causeCode === "ECONNRESET" ||
    causeCode === "ETIMEDOUT" ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT" ||
    causeCode === "UND_ERR_HEADERS_TIMEOUT" ||
    causeCode === "UND_ERR_SOCKET"
  );
}

async function fetchViaCurl(url, responseType, headers) {
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--max-time",
    "20",
  ];

  for (const [name, value] of Object.entries(headers)) {
    args.push("--header", `${name}: ${value}`);
  }

  args.push(url);

  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: 10 * 1024 * 1024,
  });

  if (responseType === "json") {
    return JSON.parse(stdout);
  }
  return stdout;
}

async function fetchWithRetry(url, responseType, extraHeaders = {}) {
  let lastError = null;
  const headers = {
    "User-Agent": "Mozilla/5.0 Codex automation",
    Referer: "https://fund.eastmoney.com/",
    ...extraHeaders,
  };

  for (let attempt = 1; attempt <= FETCH_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers,
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} for ${url}`);
        error.status = response.status;
        throw error;
      }

      if (responseType === "json") {
        return response.json();
      }
      return response.text();
    } catch (error) {
      lastError = error;
      if (shouldUseCurlFallback(error)) {
        try {
          return await fetchViaCurl(url, responseType, headers);
        } catch (curlError) {
          lastError = curlError;
        }
      }
      if (!isRetryableError(error) || attempt >= FETCH_RETRY_ATTEMPTS) {
        break;
      }
      await sleep(FETCH_RETRY_BASE_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

function buildDecisionStatus(estimate, underlying) {
  if (estimate?.usable_for_today_decision && underlying?.usable_for_today_decision) {
    if (isDirectionalMismatch(estimate, underlying)) {
      return {
        status: "cautious",
        reason: "盘中估算与底层实时代理方向不一致，不能直接给正常动作建议。",
        decision_feed: estimate,
      };
    }

    return {
      status: "ok",
      reason: "盘中估算与底层实时代理都满足新鲜度门槛。",
      decision_feed: estimate,
    };
  }

  if (estimate?.usable_for_today_decision) {
    return {
      status: "cautious",
      reason: "盘中估算可用，但底层实时代理缺失或不新鲜，只允许保守判断。",
      decision_feed: estimate,
    };
  }

  if (underlying?.usable_for_today_decision) {
    return {
      status: "cautious",
      reason: "底层实时代理可用，但盘中估算缺失或不新鲜，只允许保守判断。",
      decision_feed: underlying,
    };
  }

  return {
    status: "blocked",
    reason: "盘中估算与底层实时代理都不可用于当天判断。",
    decision_feed: null,
  };
}

async function fetchText(url) {
  return fetchWithRetry(url, "text");
}

async function fetchJson(url) {
  return fetchWithRetry(url, "json");
}

async function fetchTencentText(url) {
  return fetchWithRetry(url, "text", {
    Referer: "https://gu.qq.com/",
  });
}

async function fetchTencentBatchQuotes(symbols) {
  const sourceUrl = `https://qt.gtimg.cn/q=${symbols.join(",")}`;
  const text = await fetchTencentText(sourceUrl);
  const quotes = parseTencentBatchQuotePayload(text);
  if (quotes.size === 0) {
    throw new Error(`tencent batch quote payload missing data for ${symbols.join(",")}`);
  }
  return {
    quotes,
    sourceUrl,
  };
}

function collectRequiredQuoteSymbols(funds) {
  const required = new Set();

  for (const fund of funds) {
    if (fund.underlying?.type === "basket") {
      for (const symbol of fund.underlying.quoteSymbols ?? []) {
        required.add(symbol);
      }
    }

    if (fund.underlying?.type === "tencent_quote" && fund.underlying.quoteSymbol) {
      required.add(fund.underlying.quoteSymbol);
    }
  }

  return Array.from(required);
}

async function collectRealtimeQuoteSnapshot(funds) {
  const symbols = collectRequiredQuoteSymbols(funds);
  const bySymbol = new Map();
  const sourceUrls = [];
  const symbolErrors = [];

  for (const chunk of chunkArray(symbols, TENCENT_BATCH_CHUNK_SIZE)) {
    try {
      const { quotes, sourceUrl } = await fetchTencentBatchQuotes(chunk);
      sourceUrls.push(sourceUrl);
      for (const symbol of chunk) {
        const quote = quotes.get(symbol);
        if (quote) {
          bySymbol.set(symbol, quote);
        } else {
          symbolErrors.push({
            symbol,
            error: `missing quote in batch response for ${symbol}`,
          });
        }
      }
      continue;
    } catch (batchError) {
      for (const symbol of chunk) {
        try {
          const { parsed, sourceUrl } = await fetchTencentUnderlyingQuote(symbol, symbol);
          bySymbol.set(symbol, {
            ...parsed,
            symbol,
          });
          sourceUrls.push(sourceUrl);
        } catch (singleError) {
          symbolErrors.push({
            symbol,
            error: `${formatError(batchError)} || fallback=${formatError(singleError)}`,
          });
        }
      }
    }
  }

  return {
    fetch_time: nowIso(),
    source_name: "腾讯行情接口",
    source_urls: Array.from(new Set(sourceUrls)),
    by_symbol: bySymbol,
    symbol_errors: symbolErrors,
  };
}

async function collectEstimate(fund) {
  const fetchTime = nowIso();
  try {
    const raw = await fetchText(`${fund.estimateUrl}?rt=${Date.now()}`);
    const payload = parseEstimatePayload(raw);
    const freshness = estimateFreshnessMinutes(payload.gztime, fetchTime);

    return {
      type: "intraday_estimate",
      value: toNumber(payload.gsz),
      change_pct: toNumber(payload.gszzl),
      previous_nav: toNumber(payload.dwjz),
      previous_nav_date: payload.jzrq ?? null,
      data_time: payload.gztime ?? null,
      fetch_time: fetchTime,
      freshness_minutes: freshness,
      usable_for_today_decision:
        freshness !== null && freshness <= FRESHNESS_LIMITS.intradayEstimateMinutes,
      source_name: "天天基金估值接口",
      source_url: fund.estimateUrl,
    };
  } catch (error) {
    return {
      type: "intraday_estimate",
      fetch_time: fetchTime,
      usable_for_today_decision: false,
      error: formatError(error),
      source_name: "天天基金估值接口",
      source_url: fund.estimateUrl,
    };
  }
}

async function collectOfficialNav(fund) {
  try {
    const payload = await fetchJson(fund.officialNavUrl);
    const parsed = parseOfficialNavPayload(payload);
    return {
      ...parsed,
      source_name: "东方财富历史净值接口",
      source_url: fund.officialNavUrl,
    };
  } catch (error) {
    return {
      source_name: "东方财富历史净值接口",
      source_url: fund.officialNavUrl,
      error: formatError(error),
    };
  }
}

async function fetchTencentUnderlyingQuote(symbol, label) {
  const sourceUrl = `https://qt.gtimg.cn/q=${symbol}`;
  const text = await fetchTencentText(sourceUrl);
  const parsed = parseTencentQuote(text, label);
  if (!parsed) {
    throw new Error(`tencent quote payload missing data for ${symbol}`);
  }
  return {
    parsed,
    sourceUrl,
  };
}

async function collectTencentQuoteUnderlying(underlyingConfig, quoteSnapshot) {
  const fetchTime = quoteSnapshot.fetch_time;
  const symbol = underlyingConfig.quoteSymbol;
  const quote = quoteSnapshot.by_symbol.get(symbol);
  const snapshotErrors = quoteSnapshot.symbol_errors
    .filter((item) => item.symbol === symbol)
    .map((item) => item.error);

  if (!symbol) {
    return {
      label: underlyingConfig.label ?? "实时代理",
      type: "tencent_quote_proxy",
      fetch_time: fetchTime,
      usable_for_today_decision: false,
      error: "quote symbol not configured",
      source_name: quoteSnapshot.source_name,
      source_url: null,
    };
  }

  if (!quote) {
    return {
      label: underlyingConfig.label ?? "实时代理",
      type: "tencent_quote_proxy",
      fetch_time: fetchTime,
      usable_for_today_decision: false,
      error: snapshotErrors.join(" | ") || `quote missing for ${symbol}`,
      source_name: quoteSnapshot.source_name,
      source_url: quoteSnapshot.source_urls.find((url) => url.includes(symbol)) ?? null,
    };
  }

  const freshness = freshnessMinutes(quote.data_time ?? null, fetchTime);

  return {
    ...quote,
    label: underlyingConfig.label ?? quote.label,
    type: "tencent_quote_proxy",
    fetch_time: fetchTime,
    freshness_minutes: freshness,
    usable_for_today_decision:
      freshness !== null && freshness <= FRESHNESS_LIMITS.underlyingRealtimeMinutes,
    source_name: quoteSnapshot.source_name,
    source_url: quoteSnapshot.source_urls.find((url) => url.includes(symbol)) ?? null,
  };
}

async function collectBasketUnderlying(underlyingConfig, quoteSnapshot) {
  const fetchTime = quoteSnapshot.fetch_time;
  const symbols = Array.isArray(underlyingConfig.quoteSymbols)
    ? underlyingConfig.quoteSymbols
    : [];

  if (symbols.length === 0) {
    return {
      label: underlyingConfig.label ?? "实时篮子代理",
      type: "basket_proxy",
      fetch_time: fetchTime,
      usable_for_today_decision: false,
      error: "basket quote symbols not configured",
      source_name: quoteSnapshot.source_name,
      source_url: null,
    };
  }
  const componentErrors = [];
  const components = [];

  for (const symbol of symbols) {
    const quote = quoteSnapshot.by_symbol.get(symbol);
    if (quote) {
      components.push({
        symbol,
        code: quote.code,
        label: quote.label,
        price: quote.price,
        change_amount: quote.change_amount,
        change_pct: quote.change_pct,
        data_time: quote.data_time,
        source_url: quoteSnapshot.source_urls.find((url) => url.includes(symbol)) ?? null,
      });
      continue;
    }

    const errors = quoteSnapshot.symbol_errors
      .filter((item) => item.symbol === symbol)
      .map((item) => item.error);
    componentErrors.push({
      symbol,
      error: errors.join(" | ") || `quote missing for ${symbol}`,
    });
  }

  const usableComponents = components.filter((item) => toNumber(item.change_pct) !== null);
  const componentFreshness = usableComponents
    .map((item) => freshnessMinutes(item.data_time, fetchTime))
    .filter((item) => item !== null);
  const latestDataTime = usableComponents
    .map((item) => item.data_time)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const maxFreshness =
    componentFreshness.length > 0 ? Math.max(...componentFreshness) : null;
  const minimumUsableComponents = Math.max(5, Math.ceil(symbols.length / 2));
  const averageChangePct =
    usableComponents.length > 0
      ? Math.round(
          (usableComponents.reduce((sum, item) => sum + item.change_pct, 0) /
            usableComponents.length) *
            100
        ) / 100
      : null;

  return {
    type: "basket_proxy",
    label: underlyingConfig.label ?? "实时篮子代理",
    data_time: latestDataTime,
    fetch_time: fetchTime,
    freshness_minutes: maxFreshness,
    component_count: components.length,
    usable_component_count: usableComponents.length,
    failed_component_count: componentErrors.length,
    component_errors: componentErrors,
    composition_method: "equal_weight_top_holdings_proxy_single_batch_snapshot",
    change_pct: averageChangePct,
    usable_for_today_decision:
      usableComponents.length >= minimumUsableComponents &&
      maxFreshness !== null &&
      maxFreshness <= FRESHNESS_LIMITS.underlyingRealtimeMinutes,
    source_name: quoteSnapshot.source_name,
    source_url: quoteSnapshot.source_urls.join(", "),
    components,
  };
}

async function collectUnderlying(fund, quoteSnapshot) {
  if (!fund.underlying?.type) {
    return {
      label: fund.underlying?.label ?? "未配置实时代理",
      usable_for_today_decision: false,
      error: "underlying realtime proxy not configured",
      source_name: quoteSnapshot?.source_name ?? "腾讯行情接口",
      source_url: null,
    };
  }

  if (fund.underlying.type === "tencent_quote") {
    return collectTencentQuoteUnderlying(fund.underlying, quoteSnapshot);
  }

  if (fund.underlying.type === "basket") {
    return collectBasketUnderlying(fund.underlying, quoteSnapshot);
  }

  return {
    label: fund.underlying?.label ?? "未识别实时代理",
    usable_for_today_decision: false,
    error: `unsupported underlying type: ${fund.underlying.type}`,
    source_name: quoteSnapshot?.source_name ?? "腾讯行情接口",
    source_url: null,
  };
}

async function collectFund(fund, quoteSnapshot) {
  const [estimate, officialNav, underlyingRealtime] = await Promise.all([
    collectEstimate(fund),
    collectOfficialNav(fund),
    collectUnderlying(fund, quoteSnapshot),
  ]);

  const decision = buildDecisionStatus(estimate, underlyingRealtime);

  return {
    code: fund.code,
    name: fund.name,
    role: fund.role,
    decision_feed: decision.decision_feed,
    decision_status: decision.status,
    decision_reason: decision.reason,
    intraday_estimate: estimate,
    official_nav: officialNav,
    underlying_realtime: underlyingRealtime,
  };
}

async function main() {
  const outPath = getArg("--out", DEFAULT_OUT);
  const reportDate = getArg("--date", todayInShanghai());

  const quoteSnapshot = await collectRealtimeQuoteSnapshot(FUND_CONFIG);
  const funds = await Promise.all(
    FUND_CONFIG.map((fund) => collectFund(fund, quoteSnapshot))
  );
  const summary = {
    report_date: reportDate,
    timezone: DEFAULT_TIMEZONE,
    generated_at: nowIso(),
    funds,
    stats: {
      ok_count: funds.filter((item) => item.decision_status === "ok").length,
      cautious_count: funds.filter((item) => item.decision_status === "cautious").length,
      blocked_count: funds.filter((item) => item.decision_status === "blocked").length,
    },
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
