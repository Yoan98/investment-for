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
      label: "待配置半导体核心代理",
      quoteSecid: null,
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
      label: "待配置半导体设备代理",
      quoteSecid: null,
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
      label: "待配置黄金实时代理",
      quoteSecid: null,
    },
  },
];

const FRESHNESS_LIMITS = {
  intradayEstimateMinutes: 20,
  underlyingRealtimeMinutes: 5,
};

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
  const dataTime = timestampSeconds
    ? new Date(timestampSeconds * 1000).toISOString()
    : null;

  return {
    label: data.f58 ?? "实时代理",
    price: toNumber(data.f43) !== null ? toNumber(data.f43) / 100 : null,
    change_pct: toNumber(data.f170) !== null ? toNumber(data.f170) / 100 : null,
    data_time: dataTime,
  };
}

function freshnessMinutes(dataTimeIso, fetchTimeIso) {
  if (!dataTimeIso || !fetchTimeIso) return null;
  const deltaMs = new Date(fetchTimeIso).getTime() - new Date(dataTimeIso).getTime();
  if (!Number.isFinite(deltaMs)) return null;
  return Math.round((deltaMs / 60000) * 10) / 10;
}

function buildDecisionStatus(estimate, underlying) {
  if (estimate?.usable_for_today_decision && underlying?.usable_for_today_decision) {
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
    const freshness = freshnessMinutes(payload.gztime, fetchTime);

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

async function collectUnderlying(fund) {
  const fetchTime = nowIso();

  if (!fund.underlying?.quoteSecid) {
    return {
      label: fund.underlying?.label ?? "未配置实时代理",
      fetch_time: fetchTime,
      usable_for_today_decision: false,
      error: "underlying realtime proxy not configured",
      source_name: "东财实时行情接口",
      source_url: null,
    };
  }

  const sourceUrl =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${fund.underlying.quoteSecid}` +
    "&fields=f43,f57,f58,f124,f170";

  try {
    const payload = await fetchJson(sourceUrl);
    const parsed = parseEastmoneyQuote(payload);
    const freshness = freshnessMinutes(parsed?.data_time ?? null, fetchTime);

    return {
      ...parsed,
      fetch_time: fetchTime,
      freshness_minutes: freshness,
      usable_for_today_decision:
        freshness !== null && freshness <= FRESHNESS_LIMITS.underlyingRealtimeMinutes,
      source_name: "东财实时行情接口",
      source_url: sourceUrl,
    };
  } catch (error) {
    return {
      label: fund.underlying?.label ?? "实时代理",
      fetch_time: fetchTime,
      usable_for_today_decision: false,
      error: String(error),
      source_name: "东财实时行情接口",
      source_url: sourceUrl,
    };
  }
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
