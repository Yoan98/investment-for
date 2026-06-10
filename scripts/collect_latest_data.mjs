#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_OUT = path.join("reports", "latest-data.json");

const FUND_CONFIG = [
  {
    code: "012552",
    name: "天弘芯片产业ETF联接A",
    role: "半导体核心配置",
    estimateUrl: "https://fundgz.1234567.com.cn/js/012552.js",
    officialNavUrl:
      "https://api.fund.eastmoney.com/f10/lsjz?fundCode=012552&pageIndex=1&pageSize=20",
    underlying: {
      type: "basket",
      label: "前十大持仓等权实时篮子",
      secids: [
        "1.688041",
        "0.002371",
        "1.688981",
        "1.688256",
        "1.603986",
        "1.688008",
        "1.688012",
        "1.603501",
        "1.688521",
        "1.688525",
      ],
    },
  },
  {
    code: "021532",
    name: "天弘半导体设备指数A",
    role: "半导体设备弹性仓",
    estimateUrl: "https://fundgz.1234567.com.cn/js/021532.js",
    officialNavUrl:
      "https://api.fund.eastmoney.com/f10/lsjz?fundCode=021532&pageIndex=1&pageSize=20",
    underlying: {
      type: "basket",
      label: "前十大设备持仓等权实时篮子",
      secids: [
        "1.688012",
        "0.002371",
        "1.688072",
        "0.300604",
        "1.688120",
        "1.688126",
        "1.688361",
        "0.300346",
        "1.688019",
        "0.300666",
      ],
    },
  },
  {
    code: "000218",
    name: "国泰黄金ETF联接A",
    role: "黄金防守仓",
    estimateUrl: "https://fundgz.1234567.com.cn/js/000218.js",
    officialNavUrl:
      "https://api.fund.eastmoney.com/f10/lsjz?fundCode=000218&pageIndex=1&pageSize=20",
    underlying: {
      type: "single_quote",
      label: "黄金ETF国泰",
      quoteSecid: "1.518800",
    },
  },
];

const FRESHNESS_LIMITS = {
  intradayEstimateMinutes: 10,
  underlyingRealtimeMinutes: 5,
};

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

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function estimateFreshnessMinutes(dataTimeValue, fetchTimeIso) {
  const dataDate = parseChinaDateTime(dataTimeValue);
  const fetchDate = new Date(fetchTimeIso);
  if (!dataDate || Number.isNaN(fetchDate.getTime())) return null;
  return tradingMinutesBetween(dataDate, fetchDate);
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
  return {
    nav: toNumber(latest.DWJZ),
    accumulative_nav: toNumber(latest.LJJZ),
    nav_date: latest.FSRQ ?? null,
    daily_change_pct: toNumber(latest.JZZZL),
  };
}

function parseEastmoneyQuote(payload) {
  const data = payload?.data;
  if (!data) return null;

  const timestampSeconds = toNumber(data.f124);
  const quoteTimestampSeconds = toNumber(data.f86) ?? timestampSeconds;
  const dataTime = quoteTimestampSeconds
    ? new Date(quoteTimestampSeconds * 1000).toISOString()
    : null;

  return {
    label: data.f58 ?? "实时代理",
    price: toNumber(data.f43) !== null ? toNumber(data.f43) / 100 : null,
    change_amount: toNumber(data.f169) !== null ? toNumber(data.f169) / 100 : null,
    change_pct: toNumber(data.f170) !== null ? toNumber(data.f170) / 100 : null,
    data_time: dataTime,
    code: data.f57 ?? null,
  };
}

function freshnessMinutes(dataTimeIso, fetchTimeIso) {
  if (!dataTimeIso || !fetchTimeIso) return null;
  const startDate = new Date(dataTimeIso);
  const endDate = new Date(fetchTimeIso);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  return tradingMinutesBetween(startDate, endDate);
}

function isDirectionalMismatch(estimate, underlying) {
  const estimatePct = toNumber(estimate?.change_pct);
  const underlyingPct = toNumber(underlying?.change_pct);
  if (estimatePct === null || underlyingPct === null) return false;
  if (Math.abs(estimatePct) < 0.3 || Math.abs(underlyingPct) < 0.3) return false;
  return Math.sign(estimatePct) !== Math.sign(underlyingPct);
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
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 Codex automation",
      Referer: "https://fund.eastmoney.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 Codex automation",
      Referer: "https://fund.eastmoney.com/",
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
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
      error: String(error),
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
      error: String(error),
    };
  }
}

async function fetchUnderlyingQuote(secid) {
  const sourceUrl =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}` +
    "&fields=f43,f57,f58,f86,f124,f169,f170";
  const payload = await fetchJson(sourceUrl);
  const parsed = parseEastmoneyQuote(payload);
  return {
    parsed,
    sourceUrl,
  };
}

async function collectSingleQuoteUnderlying(underlyingConfig) {
  const fetchTime = nowIso();

  try {
    const { parsed, sourceUrl } = await fetchUnderlyingQuote(underlyingConfig.quoteSecid);
    const freshness = freshnessMinutes(parsed?.data_time ?? null, fetchTime);

    return {
      ...parsed,
      type: "single_quote_proxy",
      fetch_time: fetchTime,
      freshness_minutes: freshness,
      usable_for_today_decision:
        freshness !== null && freshness <= FRESHNESS_LIMITS.underlyingRealtimeMinutes,
      source_name: "东财实时行情接口",
      source_url: sourceUrl,
    };
  } catch (error) {
    return {
      label: underlyingConfig.label ?? "实时代理",
      type: "single_quote_proxy",
      fetch_time: fetchTime,
      usable_for_today_decision: false,
      error: String(error),
      source_name: "东财实时行情接口",
      source_url: null,
    };
  }
}

async function collectBasketUnderlying(underlyingConfig) {
  const fetchTime = nowIso();
  const secids = Array.isArray(underlyingConfig.secids) ? underlyingConfig.secids : [];

  if (secids.length === 0) {
    return {
      label: underlyingConfig.label ?? "实时篮子代理",
      type: "basket_proxy",
      fetch_time: fetchTime,
      usable_for_today_decision: false,
      error: "basket secids not configured",
      source_name: "东财实时行情接口",
      source_url: null,
    };
  }

  const settled = await Promise.allSettled(secids.map((secid) => fetchUnderlyingQuote(secid)));
  const components = [];

  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled" && result.value?.parsed) {
      const item = result.value.parsed;
      components.push({
        secid: secids[index],
        code: item.code,
        label: item.label,
        price: item.price,
        change_amount: item.change_amount,
        change_pct: item.change_pct,
        data_time: item.data_time,
        source_url: result.value.sourceUrl,
      });
    }
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
    composition_method: "equal_weight_top_holdings_proxy",
    change_pct: averageChangePct,
    usable_for_today_decision:
      usableComponents.length >= Math.max(5, Math.ceil(secids.length / 2)) &&
      maxFreshness !== null &&
      maxFreshness <= FRESHNESS_LIMITS.underlyingRealtimeMinutes,
    source_name: "东财实时行情接口",
    source_url: "multiple eastmoney quote endpoints",
    components,
  };
}

async function collectUnderlying(fund) {
  if (!fund.underlying?.type) {
    return {
      label: fund.underlying?.label ?? "未配置实时代理",
      usable_for_today_decision: false,
      error: "underlying realtime proxy not configured",
      source_name: "东财实时行情接口",
      source_url: null,
    };
  }

  if (fund.underlying.type === "single_quote") {
    return collectSingleQuoteUnderlying(fund.underlying);
  }

  if (fund.underlying.type === "basket") {
    return collectBasketUnderlying(fund.underlying);
  }

  return {
    label: fund.underlying?.label ?? "未识别实时代理",
    usable_for_today_decision: false,
    error: `unsupported underlying type: ${fund.underlying.type}`,
    source_name: "东财实时行情接口",
    source_url: null,
  };
}

async function collectFund(fund) {
  const [estimate, officialNav, underlyingRealtime] = await Promise.all([
    collectEstimate(fund),
    collectOfficialNav(fund),
    collectUnderlying(fund),
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
  const reportDate = getArg("--date", new Date().toISOString().slice(0, 10));

  const funds = await Promise.all(FUND_CONFIG.map(collectFund));
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
