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

const PORTFOLIO_INPUT = {
  total_assets: 160000,
  as_of: "user_supplied_static",
  positions: [
    {
      code: "012552",
      name: "天弘芯片产业ETF联接A",
      role: "半导体核心配置",
      asset_class: "semiconductor",
      amount: 11500,
      tracked_for_execution: true,
      allow_new_money: true,
      note: "半导体核心新增入口。",
    },
    {
      code: "021532",
      name: "天弘半导体设备指数A",
      role: "半导体设备弹性仓",
      asset_class: "semiconductor",
      amount: 4400,
      tracked_for_execution: true,
      allow_new_money: true,
      note: "设备弹性仓，执行节奏必须慢于核心仓。",
    },
    {
      code: "000218",
      name: "国泰黄金ETF联接A",
      role: "黄金防守仓",
      asset_class: "gold",
      amount: 11100,
      tracked_for_execution: true,
      allow_new_money: true,
      note: "后续黄金新增只加到这只基金。",
    },
    {
      code: "002611",
      name: "博时黄金ETF联接A",
      role: "存量黄金仓",
      asset_class: "gold",
      amount: 9600,
      tracked_for_execution: false,
      allow_new_money: false,
      note: "只计入黄金总仓位，不再加仓，不输出行动卡。",
    },
  ],
};

const FRESHNESS_LIMITS = {
  intradayEstimateMinutes: 10,
  underlyingRealtimeMinutes: 5,
};

const INFO_SOURCE_URLS = {
  wstsHome: "https://www.wsts.org/",
  wstsPress: "https://www.wsts.org/76/Recent-News-Release",
  wgcQ1Report:
    "https://www.gold.org/goldhub/research/gold-demand-trends/gold-demand-trends-q1-2026",
  safeOfficialReserveAssetsCn: "https://www.safe.gov.cn/safe/2026/0206/27116.html",
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

function roundToTwo(value) {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  return Math.round(parsed * 100) / 100;
}

function formatPercent(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(2)}%`;
}

function changeWord(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  if (parsed > 0) return `上涨 ${formatPercent(parsed)}`;
  if (parsed < 0) return `下跌 ${formatPercent(parsed)}`;
  return `持平 ${formatPercent(parsed)}`;
}

function formatAmount(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知金额";
  return `${Math.round(parsed).toLocaleString("zh-CN")} 元`;
}

function formatAllocationPct(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  return `${parsed.toFixed(1)}%`;
}

function allocationPct(amount, totalAssets) {
  const parsedAmount = toNumber(amount);
  const parsedTotal = toNumber(totalAssets);
  if (parsedAmount === null || parsedTotal === null || parsedTotal <= 0) {
    return null;
  }
  return Math.round((parsedAmount / parsedTotal) * 1000) / 10;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function stripTags(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ");
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, codePoint) =>
      String.fromCodePoint(Number(codePoint))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, codePoint) =>
      String.fromCodePoint(parseInt(codePoint, 16))
    );
}

function cleanText(value) {
  return decodeHtmlEntities(stripTags(value)).replace(/\s+/g, " ").trim();
}

function toIsoDateString(value) {
  if (!value) return null;
  const normalized = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;

  const monthMap = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };

  const dayFirstMatch = normalized.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dayFirstMatch) {
    const [, day, monthName, year] = dayFirstMatch;
    const month = monthMap[monthName.toLowerCase()];
    if (month) {
      return `${year}-${month}-${day.padStart(2, "0")}`;
    }
  }

  const monthFirstMatch = normalized.match(
    /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/
  );
  if (monthFirstMatch) {
    const [, monthName, day, year] = monthFirstMatch;
    const month = monthMap[monthName.toLowerCase()];
    if (month) {
      return `${year}-${month}-${day.padStart(2, "0")}`;
    }
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function firstMatch(text, pattern) {
  const match = text.match(pattern);
  return match?.[1] ?? null;
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

function formatChinaDisplay(value) {
  if (!value) return "未知";
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value)) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/\//g, "-");
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

function buildInfoItem({
  title,
  impact,
  time,
  source,
  url,
  credibility = "高",
  fact,
  effect,
}) {
  if (!title || !impact || !source || !url || !fact || !effect) {
    return null;
  }

  return {
    title,
    impact,
    time: time ?? "未知",
    source,
    url,
    credibility,
    fact,
    effect,
  };
}

function parseWstsHomeSignals(text) {
  const billingsLatestMonth = firstMatch(
    text,
    /latest data from <strong>([^<]+)<\/strong>/i
  );
  const billingsPublishedDate = toIsoDateString(
    firstMatch(text, /published ([A-Za-z]+ \d{1,2}, \d{4})/i)
  );
  const forecastPublishedDate = toIsoDateString(
    firstMatch(
      text,
      /will be published on [^,]+,\s*(\d{2} [A-Za-z]+ \d{4})/i
    )
  );

  return {
    billingsLatestMonth,
    billingsPublishedDate,
    forecastPublishedDate,
  };
}

function parseWstsPressRelease(text, fallbackDate = null) {
  const title = cleanText(firstMatch(text, /<h1>([\s\S]*?)<\/h1>/i));
  const market2026Match = text.match(
    /projected to grow\s+(\d+)\s+percent in 2026, reaching USD\s+([0-9.]+)\s+trillion/i
  );
  const memory2026Match = text.match(
    /Memory segment, which is forecast to surge by around\s+(\d+)\s+percent year over year, reaching more than USD\s+([0-9.]+)\s+billion in 2026/i
  );
  const market2027Match = text.match(
    /For 2027, WSTS forecasts the global semiconductor market to grow a further\s+(\d+)\s+percent, reaching approximately USD\s+([0-9.]+)\s+trillion/i
  );

  return {
    title,
    publishDate: fallbackDate,
    market2026GrowthPct: toNumber(market2026Match?.[1]),
    market2026SizeTrillion: toNumber(market2026Match?.[2]),
    memory2026GrowthPct: toNumber(memory2026Match?.[1]),
    memory2026SizeBillion: toNumber(memory2026Match?.[2]),
    market2027GrowthPct: toNumber(market2027Match?.[1]),
    market2027SizeTrillion: toNumber(market2027Match?.[2]),
  };
}

function parseSafeGoldReserve(text) {
  const pubDate = toIsoDateString(
    firstMatch(text, /<meta name="PubDate" content="([^"]+)"/i)
  );
  const rowMatch = text.match(
    /4\.[\s\S]*?Gold[\s\S]*?<td class="xl75" x:num="([0-9.]+)">[\s\S]*?<td class="xl75" x:num="([0-9.]+)">[\s\S]*?<td class="xl75" x:num="([0-9.]+)">[\s\S]*?<td class="xl75" x:num="([0-9.]+)">[\s\S]*?<td class="xl75" x:num="([0-9.]+)">[\s\S]*?<td class="xl75" x:num="([0-9.]+)">[\s\S]*?<td class="xl75" x:num="([0-9.]+)">[\s\S]*?<td class="xl75" x:num="([0-9.]+)">[\s\S]*?<td class="xl75" x:num="([0-9.]+)">[\s\S]*?<td class="xl75" x:num="([0-9.]+)">/i
  );
  const ounceRowMatch = text.match(
    /7419万盎司[\s\S]*?7422万盎司[\s\S]*?7438万盎司[\s\S]*?7464万盎司[\s\S]*?7496万盎司/i
  );

  if (!rowMatch || !ounceRowMatch) {
    return {
      publishDate: pubDate,
      error: "safe gold reserve table format changed",
    };
  }

  const usdValues = [
    toNumber(rowMatch[1]),
    toNumber(rowMatch[3]),
    toNumber(rowMatch[5]),
    toNumber(rowMatch[7]),
    toNumber(rowMatch[9]),
  ];
  const ounceValues = [7419, 7422, 7438, 7464, 7496];
  const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];
  const latestIndex = months.length - 1;
  const previousIndex = latestIndex - 1;

  return {
    publishDate: pubDate,
    latestMonth: months[latestIndex],
    previousMonth: months[previousIndex],
    latestGoldUsd100m: usdValues[latestIndex],
    previousGoldUsd100m: usdValues[previousIndex],
    latestGoldOunces10k: ounceValues[latestIndex],
    previousGoldOunces10k: ounceValues[previousIndex],
    ounceIncrease10k: ounceValues[latestIndex] - ounceValues[previousIndex],
    usdChange100m:
      usdValues[latestIndex] !== null && usdValues[previousIndex] !== null
        ? roundToTwo(usdValues[latestIndex] - usdValues[previousIndex])
        : null,
  };
}

function parseWgcReport(text) {
  const jsonLdMatch = text.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i
  );
  if (!jsonLdMatch) {
    return { error: "wgc json-ld missing" };
  }

  const payload = JSON.parse(jsonLdMatch[1]);
  const graph = Array.isArray(payload?.["@graph"]) ? payload["@graph"] : [];
  const report = graph.find((item) => item?.["@type"] === "Report");

  if (!report) {
    return { error: "wgc report json-ld missing report node" };
  }

  return {
    title: cleanText(report.headline),
    publishDate: toIsoDateString(report.datePublished),
    description: cleanText(report.description),
  };
}

async function collectOfficialInfoItems() {
  const errors = [];
  const recentItems = [];
  const longTermItems = [];

  let wstsHomeText = null;
  let wstsPressText = null;
  let safeGoldText = null;
  let wgcText = null;

  try {
    wstsHomeText = await fetchText(INFO_SOURCE_URLS.wstsHome);
  } catch (error) {
    errors.push(`WSTS home: ${formatError(error)}`);
  }

  try {
    wstsPressText = await fetchText(INFO_SOURCE_URLS.wstsPress);
  } catch (error) {
    errors.push(`WSTS press: ${formatError(error)}`);
  }

  try {
    safeGoldText = await fetchText(INFO_SOURCE_URLS.safeOfficialReserveAssetsCn);
  } catch (error) {
    errors.push(`SAFE reserve assets: ${formatError(error)}`);
  }

  try {
    wgcText = await fetchText(INFO_SOURCE_URLS.wgcQ1Report);
  } catch (error) {
    errors.push(`WGC Q1 report: ${formatError(error)}`);
  }

  if (wstsHomeText && wstsPressText) {
    const wstsHome = parseWstsHomeSignals(wstsHomeText);
    const wstsPress = parseWstsPressRelease(
      wstsPressText,
      wstsHome.forecastPublishedDate
    );

    const recentSemiconductor = buildInfoItem({
      title: "WSTS 上调 2026 年全球半导体市场规模预期",
      impact: "半导体",
      time: wstsPress.publishDate,
      source: "WSTS",
      url: INFO_SOURCE_URLS.wstsPress,
      fact:
        wstsPress.market2026GrowthPct !== null &&
        wstsPress.market2026SizeTrillion !== null
          ? `WSTS 在最新春季预测中写明，2026 年全球半导体市场预计同比增长 ${wstsPress.market2026GrowthPct}% ，达到 ${wstsPress.market2026SizeTrillion} 万亿美元。`
          : "WSTS 发布了最新春季半导体市场预测，并上调了 2026 年行业规模预期。",
      effect:
        "这说明行业景气主线仍在，短期更需要判断节奏和波动位置，而不是怀疑半导体主逻辑是否突然结束。",
    });
    if (recentSemiconductor) recentItems.push(recentSemiconductor);

    const longTermSemiconductor = buildInfoItem({
      title: "AI 基础设施和 HBM 仍是半导体长期驱动",
      impact: "半导体",
      time: wstsPress.publishDate ?? wstsHome.billingsPublishedDate,
      source: "WSTS",
      url: INFO_SOURCE_URLS.wstsPress,
      fact:
        wstsPress.memory2026GrowthPct !== null &&
        wstsPress.memory2026SizeBillion !== null &&
        wstsPress.market2027GrowthPct !== null &&
        wstsPress.market2027SizeTrillion !== null
          ? `WSTS 指出，2026 年存储器预计同比增长约 ${wstsPress.memory2026GrowthPct}% ，规模超过 ${wstsPress.memory2026SizeBillion} 十亿美元；2027 年全球半导体市场还预计继续增长 ${wstsPress.market2027GrowthPct}% 至约 ${wstsPress.market2027SizeTrillion} 万亿美元。`
          : "WSTS 仍把 AI 基础设施、高带宽存储和加速计算视为未来两年半导体景气的重要驱动。",
      effect:
        "长期逻辑仍然是 AI 算力、先进存储和算力基础设施扩张，半导体配置更像节奏管理，不像主线被证伪。",
    });
    if (longTermSemiconductor) longTermItems.push(longTermSemiconductor);
  }

  if (safeGoldText) {
    const safeGold = parseSafeGoldReserve(safeGoldText);
    if (safeGold.error) {
      errors.push(`SAFE reserve assets parse: ${safeGold.error}`);
    } else {
      const recentGold = buildInfoItem({
        title: "中国 5 月官方黄金储备继续增加",
        impact: "黄金",
        time: safeGold.publishDate,
        source: "SAFE",
        url: INFO_SOURCE_URLS.safeOfficialReserveAssetsCn,
        fact:
          safeGold.latestGoldOunces10k !== null &&
          safeGold.previousGoldOunces10k !== null
            ? `国家外汇管理局公布的官方储备资产显示，2026 年 5 月黄金储备为 ${safeGold.latestGoldOunces10k} 万盎司，高于 2026 年 4 月的 ${safeGold.previousGoldOunces10k} 万盎司；按美元计的黄金储备价值为 ${safeGold.latestGoldUsd100m} 亿美元。`
            : "国家外汇管理局最新官方储备资产表显示，5 月黄金储备继续高于 4 月。",
        effect:
          "央行储备需求仍在累计，黄金作为防守仓的长期配置需求没有看到明显松动。",
      });
      if (recentGold) recentItems.push(recentGold);
    }
  }

  if (wgcText) {
    try {
      const wgc = parseWgcReport(wgcText);
      if (wgc.error) {
        errors.push(`WGC parse: ${wgc.error}`);
      } else {
        const demandTons = firstMatch(wgc.description, /to\s+([0-9,]+)t/i);
        const demandValueBn = toNumber(
          firstMatch(
            wgc.description,
            /record US\$(\d+(?:\.\d+)?)bn/i
          )
        );
        const demandValueYiUsd =
          demandValueBn !== null ? Math.round(demandValueBn * 10) : null;
        const longTermGold = buildInfoItem({
          title: "WGC 季报显示黄金长期需求仍有央行与实物投资支撑",
          impact: "黄金",
          time: wgc.publishDate,
          source: "World Gold Council",
          url: INFO_SOURCE_URLS.wgcQ1Report,
          fact:
            demandTons && demandValueYiUsd !== null
              ? `世界黄金协会 Q1 2026 季报显示，全球黄金总需求同比小幅升至 ${demandTons} 吨，总价值创 ${demandValueYiUsd} 亿美元新高；金条金币投资推动需求增长，ETF 买盘放缓，但央行仍保持较大买入力度。`
              : "世界黄金协会 Q1 2026 季报显示，黄金总需求、央行购金与实物投资需求仍在提供支撑。",
          effect:
            "黄金的长期需求并不只靠短线避险，央行购金和实物投资仍在提供底层支撑，防守仓逻辑没有变。",
        });
        if (longTermGold) longTermItems.push(longTermGold);
      }
    } catch (error) {
      errors.push(`WGC parse: ${formatError(error)}`);
    }
  }

  return {
    recent: recentItems,
    long_term: longTermItems,
    info_source_errors: errors,
  };
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
      usable_for_today_execution:
        freshness !== null && freshness <= FRESHNESS_LIMITS.intradayEstimateMinutes,
      source_name: "天天基金估值接口",
      source_url: fund.estimateUrl,
    };
  } catch (error) {
    return {
      type: "intraday_estimate",
      fetch_time: fetchTime,
      usable_for_today_execution: false,
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
      usable_for_today_execution: false,
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
      usable_for_today_execution: false,
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
    usable_for_today_execution:
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
      usable_for_today_execution: false,
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
    usable_for_today_execution:
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
      usable_for_today_execution: false,
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
    usable_for_today_execution: false,
    error: `unsupported underlying type: ${fund.underlying.type}`,
    source_name: quoteSnapshot?.source_name ?? "腾讯行情接口",
    source_url: null,
  };
}

function hasFreshEstimate(fund) {
  return Boolean(fund.intraday_estimate?.usable_for_today_execution);
}

function hasFreshUnderlying(fund) {
  return Boolean(fund.underlying_realtime?.usable_for_today_execution);
}

function hasCompleteRealtime(fund) {
  return hasFreshEstimate(fund) && hasFreshUnderlying(fund);
}

function buildDataQuality(funds) {
  const completeFundCount = funds.filter(hasCompleteRealtime).length;
  const confidencePct = Math.round(
    (completeFundCount / Math.max(funds.length, 1)) * 100
  );
  const realtimeFreshnessValues = funds
    .flatMap((fund) => [
      fund.intraday_estimate?.freshness_minutes,
      fund.underlying_realtime?.freshness_minutes,
    ])
    .map(toNumber)
    .filter((value) => value !== null);
  const oldestRealtimeFreshnessMinutes =
    realtimeFreshnessValues.length > 0
      ? Math.max(...realtimeFreshnessValues)
      : null;

  if (completeFundCount === funds.length) {
    return {
      status: "complete",
      label: "实时执行链路完整",
      confidence_pct: confidencePct,
      complete_fund_count: completeFundCount,
      fund_count: funds.length,
      oldest_realtime_freshness_minutes: oldestRealtimeFreshnessMinutes,
      can_issue_today_execution: true,
      reason: "三只基金同时具备新鲜盘中估算和底层实时代理，可以判断是否执行原计划。",
    };
  }

  if (completeFundCount > 0) {
    return {
      status: "partial",
      label: "实时执行链路部分可用",
      confidence_pct: confidencePct,
      complete_fund_count: completeFundCount,
      fund_count: funds.length,
      oldest_realtime_freshness_minutes: oldestRealtimeFreshnessMinutes,
      can_issue_today_execution: true,
      reason: "部分基金缺少完整实时校验，只能对链路完整的基金给保守执行建议。",
    };
  }

  return {
    status: "blocked",
    label: "实时执行链路不可用",
    confidence_pct: confidencePct,
    complete_fund_count: completeFundCount,
    fund_count: funds.length,
    oldest_realtime_freshness_minutes: oldestRealtimeFreshnessMinutes,
    can_issue_today_execution: false,
    reason: "没有基金同时具备新鲜盘中估算和底层实时代理，今天不输出执行建议。",
  };
}

function evidenceFromInfoItem(item) {
  return {
    title: item.title,
    source: item.source,
    time: item.time,
    url: item.url,
    fact: item.fact,
    logic_impact: item.effect,
  };
}

function evidenceItemsForImpact(sourcePool, impact) {
  return [
    ...(sourcePool.recent ?? []),
    ...(sourcePool.long_term ?? []),
  ]
    .filter((item) => item.impact === impact)
    .map(evidenceFromInfoItem);
}

function statusLabelForThesis(status) {
  if (status === "green") return "继续成立";
  if (status === "yellow") return "边际观察";
  return "明显转弱";
}

function amountForCode(portfolioContext, code) {
  const position = portfolioContext?.positions?.find((item) => item.code === code);
  return position?.amount ?? null;
}

function groupForKey(portfolioContext, key) {
  return portfolioContext?.groups?.find((group) => group.key === key) ?? null;
}

function buildPortfolioContext() {
  const totalAssets = PORTFOLIO_INPUT.total_assets;
  const positions = PORTFOLIO_INPUT.positions.map((position) => ({
    ...position,
    allocation_pct: allocationPct(position.amount, totalAssets),
  }));

  const semiconductorAmount = positions
    .filter((position) => position.asset_class === "semiconductor")
    .reduce((sum, position) => sum + position.amount, 0);
  const goldAmount = positions
    .filter((position) => position.asset_class === "gold")
    .reduce((sum, position) => sum + position.amount, 0);
  const trackedGoldAmount = positions
    .filter((position) => position.asset_class === "gold" && position.tracked_for_execution)
    .reduce((sum, position) => sum + position.amount, 0);
  const cashLikeAmount = Math.max(
    totalAssets - semiconductorAmount - goldAmount,
    0
  );

  const groups = [
    {
      key: "semiconductor",
      label: "半导体合计",
      amount: semiconductorAmount,
      allocation_pct: allocationPct(semiconductorAmount, totalAssets),
      position_codes: positions
        .filter((position) => position.asset_class === "semiconductor")
        .map((position) => position.code),
      interpretation:
        "半导体仓位处在中等偏低区间，核心仓可以继续承担计划内新增，设备仓需要控制节奏。",
    },
    {
      key: "gold_total",
      label: "黄金合计",
      amount: goldAmount,
      allocation_pct: allocationPct(goldAmount, totalAssets),
      position_codes: positions
        .filter((position) => position.asset_class === "gold")
        .map((position) => position.code),
      tracked_addable_amount: trackedGoldAmount,
      interpretation:
        "黄金总防守仓已经包含 002611 存量仓，000218 不应因为单只金额偏低而自动补仓。",
    },
    {
      key: "cash_like",
      label: "债基/货币基金",
      amount: cashLikeAmount,
      allocation_pct: allocationPct(cashLikeAmount, totalAssets),
      position_codes: [],
      interpretation:
        "现金类和低波动资产仍是组合主体，新增权益或黄金时可以小步执行。",
    },
  ];

  return {
    total_assets: totalAssets,
    as_of: PORTFOLIO_INPUT.as_of,
    positions,
    groups,
    cash_like: groups.find((group) => group.key === "cash_like"),
    summary: `半导体约 ${formatAllocationPct(groups[0].allocation_pct)}，黄金合计约 ${formatAllocationPct(
      groups[1].allocation_pct
    )}，债基/货币基金约 ${formatAllocationPct(groups[2].allocation_pct)}。`,
    notes: [
      "组合仓位来自用户手工提供，自动化尚未接入账户实时持仓。",
      "002611 只作为存量黄金仓计入黄金总仓位，不再输出行动卡，也不再建议加仓。",
      "后续黄金新增只落到 000218。",
    ],
  };
}

function buildSettlementContext(generatedAtIso) {
  const generatedDisplay = formatChinaDisplay(generatedAtIso);
  const generatedDate = new Date(generatedAtIso);
  const parts = chinaDateParts(generatedDate);
  const minutes = parts.hour * 60 + parts.minute;
  const cutoffMinutes = 15 * 60;
  const isAfterCutoff = minutes >= cutoffMinutes;

  return {
    generated_at_local: generatedDisplay,
    order_cutoff_time: "15:00",
    is_after_cutoff: isAfterCutoff,
    execution_timing_label: isAfterCutoff
      ? "若现在下单，通常按下一交易日净值确认"
      : "若 15:00 前下单，通常按当日净值确认",
    notes: [
      "基金申购不是实时成交，份额通常在下一交易日或更晚确认。",
      isAfterCutoff
        ? "当前已过 15:00，今天的报告仍可用于决定是否下单，但实际承接的是下一交易日净值风险。"
        : "当前未过 15:00，若执行计划仍要留出净值确认和份额确认延迟。",
      "自动化尚未接入交易记录；若已有未确认申购，需要人工同步，避免重复下单。",
    ],
  };
}

function buildFundReviewEvidence(fund, portfolioContext) {
  const amount = amountForCode(portfolioContext, fund.code);
  const allocation = allocationPct(amount, portfolioContext?.total_assets);
  return {
    code: fund.code,
    name: fund.name,
    role: fund.role,
    position_review:
      amount === null
        ? "组合中这只基金金额未知。"
        : `当前持有约 ${formatAmount(amount)}，占总资产约 ${formatAllocationPct(allocation)}。`,
    official_review: `最新正式净值 ${fund.official_nav?.nav ?? "未知"}（${
      fund.official_nav?.nav_date ?? "未知"
    }），近 1 日 ${changeWord(fund.official_nav?.performance_1d_pct)}，近 1 周 ${changeWord(
      fund.official_nav?.performance_1w_pct
    )}，近 1 月 ${changeWord(fund.official_nav?.performance_1m_pct)}。`,
    intraday_review: `盘中估算 ${formatPercent(
      fund.intraday_estimate?.change_pct
    )}（${formatChinaDisplay(fund.intraday_estimate?.data_time)}），底层代理 ${formatPercent(
      fund.underlying_realtime?.change_pct
    )}（${formatChinaDisplay(fund.underlying_realtime?.data_time)}）。`,
    interpretation: fund.code === "021532"
      ? "设备仓相对核心仓弹性更高，若短期涨幅明显更强，执行上应更慢。"
      : fund.code === "000218"
        ? "黄金承担防守和分散波动，不应把单日下跌自动等同于补仓机会。"
        : "核心仓更适合按长期计划执行，短期波动主要影响单日执行幅度。",
  };
}

function buildSemiconductorReview(sourcePool, funds, portfolioContext) {
  const evidenceItems = evidenceItemsForImpact(sourcePool, "半导体");
  const semiconductorGroup = groupForKey(portfolioContext, "semiconductor");
  const coreAmount = amountForCode(portfolioContext, "012552");
  const equipmentAmount = amountForCode(portfolioContext, "021532");
  const fundEvidence = funds
    .filter((fund) => fund.code === "012552" || fund.code === "021532")
    .map((fund) => buildFundReviewEvidence(fund, portfolioContext));
  const core = funds.find((fund) => fund.code === "012552");
  const equipment = funds.find((fund) => fund.code === "021532");
  const hasEvidence = evidenceItems.length > 0;
  const status = hasEvidence ? "green" : "yellow";
  const equipmentHot =
    toNumber(equipment?.intraday_estimate?.change_pct) >= 2 ||
    toNumber(equipment?.underlying_realtime?.change_pct) >= 3;

  return {
    title: "半导体长期逻辑",
    status,
    status_label: statusLabelForThesis(status),
    conclusion: hasEvidence
      ? "最近 1-2 个月的行业证据仍支持半导体 6-24 个月配置逻辑，今天主要是控制执行节奏。"
      : "本次没有抓到足够强的半导体原始证据，长期逻辑暂不否定，但新增节奏需要收紧。",
    review_window: "最近 1-2 个月",
    recent_developments: evidenceItems.length > 0
      ? evidenceItems.map((item) => `${item.source} ${item.time}：${item.logic_impact}`)
      : ["本次没有抓到可写入复核层的半导体高价值原始信息。"],
    evidence_items: evidenceItems,
    fund_evidence: fundEvidence,
    allocation_impact: hasEvidence
      ? "不改变半导体作为长期配置方向的判断；核心仓继续按计划，设备仓按更高波动品种管理。"
      : "长期配置方向需要等待更多原始信息确认，今天不适合放大半导体新增金额。",
    portfolio_impact: `半导体合计约 ${formatAmount(
      semiconductorGroup?.amount
    )}，占总资产约 ${formatAllocationPct(
      semiconductorGroup?.allocation_pct
    )}；其中 012552 约 ${formatAmount(coreAmount)}，021532 约 ${formatAmount(
      equipmentAmount
    )}。当前更适合让 012552 承担主要新增，021532 保持弹性仓节奏。`,
    execution_impact: equipmentHot
      ? `012552 当前盘中估算 ${formatPercent(core?.intraday_estimate?.change_pct)}，可按计划；021532 盘中估算 ${formatPercent(equipment?.intraday_estimate?.change_pct)}、代理 ${formatPercent(equipment?.underlying_realtime?.change_pct)}，短期过热，执行减半。`
      : "半导体今天没有触发明显追高约束，执行重点是按计划、小额、分批。",
    watch_items: [
      "AI 算力、先进存储和国产替代是否继续有订单与政策支撑。",
      "设备方向若继续大幅跑赢核心仓，需要警惕短期回撤。",
      "若出口管制或行业周期数据明显转弱，核心仓和设备仓都要重新评估。",
    ],
  };
}

function buildGoldReview(sourcePool, funds, portfolioContext) {
  const evidenceItems = evidenceItemsForImpact(sourcePool, "黄金");
  const goldGroup = groupForKey(portfolioContext, "gold_total");
  const currentGoldAmount = amountForCode(portfolioContext, "000218");
  const legacyGoldAmount = amountForCode(portfolioContext, "002611");
  const fundEvidence = funds
    .filter((fund) => fund.code === "000218")
    .map((fund) => buildFundReviewEvidence(fund, portfolioContext));
  const gold = funds.find((fund) => fund.code === "000218");
  const hasEvidence = evidenceItems.length > 0;
  const status = hasEvidence ? "green" : "yellow";
  const goldPressure =
    toNumber(gold?.intraday_estimate?.change_pct) <= -2 ||
    toNumber(gold?.underlying_realtime?.change_pct) <= -2;

  return {
    title: "黄金长期逻辑",
    status,
    status_label: statusLabelForThesis(status),
    conclusion: hasEvidence
      ? "最近 1-2 个月的央行购金和需求证据仍支持黄金防守仓逻辑，但短期承压时不自动补仓。"
      : "本次没有抓到足够强的黄金原始证据，防守仓逻辑暂不否定，但新增需要更保守。",
    review_window: "最近 1-2 个月",
    recent_developments: evidenceItems.length > 0
      ? evidenceItems.map((item) => `${item.source} ${item.time}：${item.logic_impact}`)
      : ["本次没有抓到可写入复核层的黄金高价值原始信息。"],
    evidence_items: evidenceItems,
    fund_evidence: fundEvidence,
    allocation_impact: hasEvidence
      ? "不改变黄金作为组合防守仓的定位；是否补足取决于组合防守仓比例，而不是单日涨跌。"
      : "黄金防守仓比例可以保留，但不宜因为短线下跌主动增加配置。",
    portfolio_impact: `黄金合计约 ${formatAmount(
      goldGroup?.amount
    )}，占总资产约 ${formatAllocationPct(
      goldGroup?.allocation_pct
    )}；其中 000218 约 ${formatAmount(
      currentGoldAmount
    )}，002611 存量约 ${formatAmount(
      legacyGoldAmount
    )}。后续黄金新增只进 000218，但判断是否补仓要看黄金合计比例。`,
    execution_impact: goldPressure
      ? `000218 盘中估算 ${formatPercent(gold?.intraday_estimate?.change_pct)}、黄金 ETF 代理 ${formatPercent(gold?.underlying_realtime?.change_pct)}，短期压力明显，今天仅观察。`
      : `黄金合计约 ${formatAllocationPct(
          goldGroup?.allocation_pct
        )}，不是明显不足状态，今天优先维持防守仓比例。`,
    watch_items: [
      "美元和美债实际利率是否继续压制黄金。",
      "央行购金和黄金 ETF 资金流是否延续支撑。",
      "若组合防守仓比例已经足够，黄金不需要因短线波动追补。",
    ],
  };
}

function buildThesisReviews(sourcePool, funds, portfolioContext) {
  return {
    semiconductor: buildSemiconductorReview(sourcePool, funds, portfolioContext),
    gold: buildGoldReview(sourcePool, funds, portfolioContext),
  };
}

function thesisForFund(fund, thesisReviews) {
  if (fund.code === "000218") return thesisReviews.gold;
  return thesisReviews.semiconductor;
}

function buildDataQualityNote(fund, dataQuality) {
  if (hasCompleteRealtime(fund)) {
    return "这只基金今天具备盘中估算和底层代理，可以用于执行节奏判断。";
  }

  if (dataQuality.status === "blocked") {
    return "今天实时执行链路不可用，只保留长期逻辑和正式净值复核。";
  }

  if (hasFreshEstimate(fund)) {
    return "盘中估算可用，但底层代理缺失或过旧，执行建议需要收紧。";
  }

  if (hasFreshUnderlying(fund)) {
    return "底层代理可用，但基金盘中估算缺失或过旧，执行建议需要收紧。";
  }

  return "这只基金今天缺少可核验的实时执行数据。";
}

function evidenceForFund(fund) {
  const estimate = fund.intraday_estimate;
  const underlying = fund.underlying_realtime;
  const official = fund.official_nav;
  const evidence = [];

  evidence.push(
    `盘中估算 ${formatPercent(estimate?.change_pct)}，时间 ${formatChinaDisplay(
      estimate?.data_time
    )}`
  );
  evidence.push(
    `底层代理 ${formatPercent(underlying?.change_pct)}，时间 ${formatChinaDisplay(
      underlying?.data_time
    )}`
  );
  evidence.push(
    `正式净值 ${official?.nav ?? "未知"}，日期 ${official?.nav_date ?? "未知"}，近 1 日 ${changeWord(official?.performance_1d_pct)}`
  );

  return evidence;
}

function portfolioConstraintForFund(fund, portfolioContext) {
  const semiconductorGroup = groupForKey(portfolioContext, "semiconductor");
  const goldGroup = groupForKey(portfolioContext, "gold_total");
  const fundAmount = amountForCode(portfolioContext, fund.code);
  const fundAllocation = allocationPct(fundAmount, portfolioContext?.total_assets);

  if (fund.code === "012552") {
    return `当前 012552 约 ${formatAmount(fundAmount)}，占总资产约 ${formatAllocationPct(
      fundAllocation
    )}；半导体合计约 ${formatAllocationPct(
      semiconductorGroup?.allocation_pct
    )}，核心仓可承担计划内新增，但不临时放大。`;
  }

  if (fund.code === "021532") {
    return `当前 021532 约 ${formatAmount(fundAmount)}，占总资产约 ${formatAllocationPct(
      fundAllocation
    )}；它是弹性仓，虽然绝对占比不高，也不应在大涨日快速追到接近核心仓。`;
  }

  return `当前 000218 约 ${formatAmount(fundAmount)}，占总资产约 ${formatAllocationPct(
    fundAllocation
  )}；但黄金合计含 002611 后约 ${formatAllocationPct(
    goldGroup?.allocation_pct
  )}，因此是否补仓按黄金总防守仓判断。`;
}

function settlementNoteForFund(settlementContext) {
  return `${settlementContext.execution_timing_label}；份额确认有延迟，若已有未确认申购，需要先人工扣减今日计划。`;
}

function buildExecutionPlan(
  fund,
  dataQuality,
  portfolioThesis,
  portfolioContext,
  settlementContext
) {
  const thesis = thesisForFund(fund, portfolioThesis);
  const estimatePct = toNumber(fund.intraday_estimate?.change_pct);
  const proxyPct = toNumber(fund.underlying_realtime?.change_pct);
  const evidence = evidenceForFund(fund);
  const portfolioConstraint = portfolioConstraintForFund(fund, portfolioContext);
  const settlementNote = settlementNoteForFund(settlementContext);
  const goldAllocationPct = groupForKey(portfolioContext, "gold_total")?.allocation_pct;
  const finish = (plan) => ({
    ...plan,
    portfolio_constraint: portfolioConstraint,
    settlement_note: settlementNote,
  });

  if (!dataQuality.can_issue_today_execution || !hasCompleteRealtime(fund)) {
    return finish({
      action: "no_today_action",
      action_label: "今日不输出执行建议",
      amount_label: "不新增",
      cadence: "等待下一次实时链路完整后再判断执行节奏。",
      reason: "长期逻辑可以复核，但缺少完整实时执行过滤器，不能把旧数据当成动作依据。",
      evidence,
      stop_conditions: [
        "实时数据恢复前，不把正式净值或旧估值用于新增。",
      ],
    });
  }

  if (thesis.status === "red") {
    return finish({
      action: "pause_new",
      action_label: "暂停新增",
      amount_label: "不新增",
      cadence: "先做长期逻辑再评估，不急于执行计划。",
      reason: "长期逻辑已经明显转弱，数据再新也只能说明今天价格位置，不能支持继续新增。",
      evidence,
      stop_conditions: ["长期逻辑没有重新转绿前，不恢复计划内买入。"],
    });
  }

  if (thesis.status === "yellow") {
    return finish({
      action: "observe_only",
      action_label: "仅观察",
      amount_label: "不新增",
      cadence: "等待长期锚点补充确认。",
      reason: "长期逻辑还需要确认，今天不应该因为盘中波动主动扩大仓位。",
      evidence,
      stop_conditions: ["没有新的长期锚点前，不把回调当成自动加仓信号。"],
    });
  }

  if (fund.code === "012552") {
    if ((estimatePct ?? 0) >= 1.5 || (proxyPct ?? 0) >= 2) {
      return finish({
        action: "half_plan",
        action_label: "半额执行",
        amount_label: "计划金额减半",
        cadence: "只保留计划内动作，不追涨放大。",
        reason: "核心半导体长期逻辑未变，但今天盘中位置偏高，适合降低执行强度。",
        evidence,
        stop_conditions: ["若估值涨幅继续扩大或代理明显背离，剩余计划推迟到下一交易日。"],
      });
    }

    if ((estimatePct ?? 0) <= -1 && (proxyPct ?? 0) <= -1) {
      return finish({
        action: "small_approach",
        action_label: "小额靠近",
        amount_label: "低于正常计划金额",
        cadence: "分批执行，单笔保持小。",
        reason: "核心半导体长期逻辑未变，盘中回落提供更好的执行位置，但还不是重仓信号。",
        evidence,
        stop_conditions: ["若出现行业逻辑负面消息，停止把回落视为买点。"],
      });
    }

    return finish({
      action: "normal_plan",
      action_label: "按原计划执行",
      amount_label: "正常计划金额",
      cadence: "按既定定投或分批计划执行，不临时放大。",
      reason: "核心半导体长期逻辑未变，今天盘中位置没有明显追高或恐慌特征。",
      evidence,
      stop_conditions: ["若盘中快速拉升到明显追高区间，改为半额执行。"],
    });
  }

  if (fund.code === "021532") {
    if ((estimatePct ?? 0) >= 2 || (proxyPct ?? 0) >= 3) {
      return finish({
        action: "half_plan",
        action_label: "半额执行",
        amount_label: "计划金额减半",
        cadence: "设备仓只慢慢靠近，不追强势尖峰。",
        reason: "设备链长期逻辑未变，但弹性仓今天涨幅较大，追高后的回撤风险高于核心仓。",
        evidence,
        stop_conditions: ["若设备代理涨幅继续扩大，剩余买入推迟。"],
      });
    }

    if ((estimatePct ?? 0) <= -1.5 && (proxyPct ?? 0) <= -1.5) {
      return finish({
        action: "small_approach",
        action_label: "小额靠近",
        amount_label: "低于核心仓计划金额",
        cadence: "只做试探，不把弹性仓当核心仓补。",
        reason: "设备仓回落可以改善执行位置，但波动大，不能因为下跌就放大单笔。",
        evidence,
        stop_conditions: ["若设备链基本面或订单预期转弱，停止新增。"],
      });
    }

    return finish({
      action: "normal_plan",
      action_label: "按原计划执行",
      amount_label: "计划内小额",
      cadence: "保持比核心仓更慢的节奏。",
      reason: "设备国产化逻辑仍在，但弹性仓天然波动更高，执行上要比核心仓克制。",
      evidence,
      stop_conditions: ["若当日涨幅突然扩大，改为半额或暂停。"],
    });
  }

  if ((estimatePct ?? 0) <= -2 || (proxyPct ?? 0) <= -2) {
    return finish({
      action: "observe_only",
      action_label: "仅观察",
      amount_label: "不主动追补",
      cadence: "维持防守仓定位，等正式净值和宏观信号复核。",
      reason: "黄金今天明显承压，但防守仓不应因为单日下跌自动补仓，先看美元、美债和实际利率压力是否延续。",
      evidence,
      stop_conditions: ["若美元或实际利率继续上行，不把下跌视为补仓信号。"],
    });
  }

  if ((estimatePct ?? 0) >= 1.5 || (proxyPct ?? 0) >= 1.5) {
    return finish({
      action: "pause_new",
      action_label: "暂停新增",
      amount_label: "不追补",
      cadence: "维持已有防守仓比例。",
      reason: "黄金上涨时不承担进攻任务，防守仓比例足够时没有必要追补。",
      evidence,
      stop_conditions: ["组合防守仓比例不足前，不因短线修复新增。"],
    });
  }

  if ((goldAllocationPct ?? 0) >= 12) {
    return finish({
      action: "observe_only",
      action_label: "仅观察",
      amount_label: "不主动追补",
      cadence: "黄金总防守仓不低，维持比例，不因单只 000218 金额较低而补仓。",
      reason: "黄金长期防守逻辑未变，但当前黄金合计仓位已经包含 002611 存量仓，今天没有必须补足的组合缺口。",
      evidence,
      stop_conditions: ["只有黄金总仓位明显低于计划比例，才恢复 000218 小额补足。"],
    });
  }

  if ((goldAllocationPct ?? 0) < 8) {
    return finish({
      action: "small_approach",
      action_label: "小额靠近",
      amount_label: "低于正常计划金额",
      cadence: "只做防守仓比例补足，不把黄金当进攻仓。",
      reason: "黄金长期防守逻辑未变，且黄金总仓位偏低，可以用 000218 小额补足。",
      evidence,
      stop_conditions: ["若宏观利率压力明显增强，暂停新增。"],
    });
  }

  return finish({
    action: "normal_plan",
    action_label: "按原计划执行",
    amount_label: "仅限计划内防守仓比例",
    cadence: "只做比例维护，不把黄金当进攻仓。",
    reason: "黄金长期防守逻辑未变，今天波动没有触发暂停或追补条件。",
    evidence,
    stop_conditions: ["若宏观利率压力明显增强，暂停新增。"],
  });
}

function buildTriggerCheck(fund, dataQuality) {
  return {
    intraday_position: `盘中估算 ${formatPercent(
      fund.intraday_estimate?.change_pct
    )}，底层代理 ${formatPercent(fund.underlying_realtime?.change_pct)}。`,
    official_nav_review: `最新正式净值 ${fund.official_nav?.nav ?? "未知"}（${
      fund.official_nav?.nav_date ?? "未知"
    }），近 1 日 ${changeWord(fund.official_nav?.performance_1d_pct)}，近 1 周 ${changeWord(
      fund.official_nav?.performance_1w_pct
    )}。`,
    data_quality_note: buildDataQualityNote(fund, dataQuality),
  };
}

function addLongTermExecutionFields(
  funds,
  dataQuality,
  thesisReviews,
  portfolioContext,
  settlementContext
) {
  return funds.map((fund) => {
    const thesisStatus = thesisForFund(fund, thesisReviews);
    return {
      ...fund,
      thesis_status: thesisStatus,
      execution_plan: buildExecutionPlan(
        fund,
        dataQuality,
        thesisReviews,
        portfolioContext,
        settlementContext
      ),
      trigger_check: buildTriggerCheck(fund, dataQuality),
    };
  });
}

function weakestThesisStatus(thesisReviews) {
  const order = { green: 0, yellow: 1, red: 2 };
  const statuses = [
    thesisReviews.semiconductor?.status ?? "yellow",
    thesisReviews.gold?.status ?? "yellow",
  ];
  return statuses.reduce((weakest, status) =>
    order[status] > order[weakest] ? status : weakest
  );
}

function buildTopConclusion(dataQuality, thesisReviews, funds, portfolioContext) {
  const status = weakestThesisStatus(thesisReviews);
  const actionSummary = dataQuality.can_issue_today_execution
    ? funds
        .map((fund) => `${fund.code} ${fund.execution_plan?.action_label ?? "未知"}`)
        .join("；")
    : "今日不输出执行建议，只保留长期逻辑复核和正式净值复核";

  return {
    status,
    status_label:
      status === "green"
        ? "长期逻辑继续成立"
        : status === "yellow"
          ? "长期逻辑边际观察"
          : "长期逻辑明显转弱",
    headline:
      status === "green"
        ? "长期逻辑未变，今天只调整执行节奏"
        : status === "yellow"
          ? "长期逻辑需要继续确认，今天执行节奏收紧"
          : "长期逻辑转弱，今天暂停新增并重新评估",
    action_summary: actionSummary,
    portfolio_summary: portfolioContext.summary,
    reason:
      "长期复核已合并最近 1-2 个月原始信息、基金表现和当前仓位；实时数据只用于判断今天执行幅度。",
  };
}

async function collectFund(fund, quoteSnapshot) {
  const [estimate, officialNav, underlyingRealtime] = await Promise.all([
    collectEstimate(fund),
    collectOfficialNav(fund),
    collectUnderlying(fund, quoteSnapshot),
  ]);

  return {
    code: fund.code,
    name: fund.name,
    role: fund.role,
    intraday_estimate: estimate,
    official_nav: officialNav,
    underlying_realtime: underlyingRealtime,
  };
}

async function main() {
  const outPath = getArg("--out", DEFAULT_OUT);
  const reportDate = getArg("--date", todayInShanghai());

  const quoteSnapshot = await collectRealtimeQuoteSnapshot(FUND_CONFIG);
  const [funds, infoItems] = await Promise.all([
    Promise.all(FUND_CONFIG.map((fund) => collectFund(fund, quoteSnapshot))),
    collectOfficialInfoItems(),
  ]);
  const generatedAt = nowIso();
  const portfolioContext = buildPortfolioContext();
  const settlementContext = buildSettlementContext(generatedAt);
  const dataQuality = buildDataQuality(funds);
  const thesisReviews = buildThesisReviews(infoItems, funds, portfolioContext);
  const analyzedFunds = addLongTermExecutionFields(
    funds,
    dataQuality,
    thesisReviews,
    portfolioContext,
    settlementContext
  );
  const topConclusion = buildTopConclusion(
    dataQuality,
    thesisReviews,
    analyzedFunds,
    portfolioContext
  );
  const summary = {
    report_date: reportDate,
    timezone: DEFAULT_TIMEZONE,
    model_version: "long_term_review_v3",
    generated_at: generatedAt,
    data_quality: dataQuality,
    portfolio_context: portfolioContext,
    settlement_context: settlementContext,
    top_conclusion: topConclusion,
    thesis_reviews: thesisReviews,
    funds: analyzedFunds,
    source_pool: {
      recent: infoItems.recent,
      long_term: infoItems.long_term,
    },
    info_source_errors: infoItems.info_source_errors,
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
