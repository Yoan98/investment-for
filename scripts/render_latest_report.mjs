#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_INPUT = path.join("reports", "latest", "data.json");
const DEFAULT_REPORT = path.join("reports", "latest", "report.html");
const DEFAULT_SOURCES = path.join("reports", "latest", "sources.md");

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPercent(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(2)}%`;
}

function formatFreshness(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  if (parsed <= 0) return "<1 分钟";
  if (Number.isInteger(parsed)) return `${parsed} 分钟`;
  return `${parsed.toFixed(1)} 分钟`;
}

function changeWord(value) {
  const parsed = toNumber(value);
  if (parsed === null) return "未知";
  if (parsed > 0) return `上涨 ${formatPercent(parsed)}`;
  if (parsed < 0) return `下跌 ${formatPercent(parsed)}`;
  return `持平 ${formatPercent(parsed)}`;
}

function statusLabel(status) {
  if (status === "ok") return "可操作";
  if (status === "cautious") return "谨慎小额";
  return "暂停建议";
}

function statusClass(status) {
  if (status === "ok") return "ok";
  if (status === "cautious") return "warn";
  return "bad";
}

function toChinaString(isoString) {
  if (!isoString) return "未知";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return String(isoString);
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return formatter.format(date).replace(/\//g, "-");
}

function formatDecisionTime(value) {
  if (!value) return "未知";
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value)) return value;
  return toChinaString(value);
}

function usableDecisionFeeds(funds) {
  return funds
    .map((fund) => fund.decision_feed)
    .filter((feed) => feed?.usable_for_today_decision);
}

function collectErrorMessages(funds) {
  return funds.flatMap((fund) =>
    [
      fund.intraday_estimate?.error,
      fund.official_nav?.error,
      fund.underlying_realtime?.error,
      ...(Array.isArray(fund.underlying_realtime?.component_errors)
        ? fund.underlying_realtime.component_errors.map((item) => item.error)
        : []),
    ].filter(Boolean)
  );
}

function detectRunIssue(funds) {
  const errors = collectErrorMessages(funds);
  if (errors.length === 0) return null;

  if (errors.some((message) => /ENOTFOUND/.test(message))) {
    return "本次运行环境未能解析外部数据源域名，属于网络/DNS 故障，不是基金本身没有更新。";
  }

  if (errors.some((message) => /UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT/.test(message))) {
    return "本次运行里的实时代理行情接口出现瞬时网络抖动，部分实时校验源抓取失败。";
  }

  return "本次运行存在外部数据抓取错误，结论已按降级规则自动收紧。";
}

function buildDecisionLevel(funds) {
  const freshEstimates = funds.filter(
    (fund) => fund.intraday_estimate?.usable_for_today_decision
  ).length;
  const freshUnderlyings = funds.filter(
    (fund) => fund.underlying_realtime?.usable_for_today_decision
  ).length;
  const runIssue = detectRunIssue(funds);

  if (freshEstimates >= 2 && freshUnderlyings >= 2) {
    return {
      level: "A",
      title: "今天允许正常输出今日操作建议",
      stance: "以实时数据为主，可以给出谨慎小额操作建议",
      body: "至少两只基金同时具备新鲜盘中估值和新鲜底层代理，当天判断不需要退回旧净值层。",
      downgrade_reason: "",
      run_issue: runIssue,
    };
  }

  if (freshEstimates > 0 || freshUnderlyings > 0) {
    return {
      level: "B",
      title: "今天只允许输出保守版建议",
      stance: "只观察或按原计划小额，不放大单笔",
      body: "实时数据并不完整，但仍有一部分新鲜盘中估值或底层代理可用，因此只能给保守节奏建议。",
      downgrade_reason:
        runIssue ?? "部分基金缺少成套实时校验，无法把当天判断提升到正常建议级别。",
      run_issue: runIssue,
    };
  }

  return {
    level: "C",
    title: "今天不输出操作建议",
    stance: "仅保留正式净值复核和长期逻辑，不做当天动作判断",
    body: "主基金缺少可核验的新鲜盘中估值与底层代理，继续给动作建议会把旧数据误当成当天判断依据。",
    downgrade_reason:
      runIssue ?? "盘中估值与底层实时代理都不新鲜或无法核验，触发 C 级降级。",
    run_issue: runIssue,
  };
}

function buildFreshnessSnapshot(funds) {
  const feeds = usableDecisionFeeds(funds);
  const completeFunds = funds.filter(
    (fund) =>
      fund.intraday_estimate?.usable_for_today_decision &&
      fund.underlying_realtime?.usable_for_today_decision
  ).length;
  const confidence = Math.round((completeFunds / Math.max(funds.length, 1)) * 100);

  if (feeds.length === 0) {
    return {
      confidence,
      coverage: `${completeFunds}/${funds.length} 基金实时决策链路完整`,
      freshness_status: "无可用实时数据",
      fetch_label: "仅可参考正式净值复核",
    };
  }

  const freshnessValues = feeds
    .map((feed) => toNumber(feed.freshness_minutes))
    .filter((value) => value !== null);
  const maxFreshness =
    freshnessValues.length > 0 ? Math.max(...freshnessValues) : null;

  return {
    confidence,
    coverage: `${completeFunds}/${funds.length} 基金实时决策链路完整`,
    freshness_status:
      maxFreshness === null ? "实时数据时间戳缺失" : `最旧实时数据 ${formatFreshness(maxFreshness)}`,
    fetch_label: "盘中判断数据已同步到本次抓取时点",
  };
}

function decisionAction(fund, decisionLevel) {
  if (decisionLevel.level === "C") {
    return {
      action: "今日不操作",
      mode: "等待下一次有新鲜实时数据时再判断。",
    };
  }

  if (fund.code === "012552") {
    return {
      action: decisionLevel.level === "A" ? "按原计划小额分批" : "仅按原计划极小额靠近",
      mode: "不放大单笔，不把盘中轻微波动当趋势确认。",
    };
  }
  if (fund.code === "021532") {
    return {
      action: decisionLevel.level === "A" ? "可小额靠近，但比核心仓更慢" : "只观察或极小额试探",
      mode: "设备链弹性高，允许参考方向，但不能追情绪尖峰。",
    };
  }
  return {
    action: decisionLevel.level === "A" ? "只保留防守仓，不主动追补" : "维持原仓位，不根据盘中波动追补",
    mode: "黄金更多承担组合对冲，不承担追涨任务。",
  };
}

function buildTopConclusion(funds, decisionLevel) {
  if (decisionLevel.level === "C") {
    return {
      headline: "今天只看复核，不给动作建议",
      subhead: "实时判断链路不完整，今天不拿盘中波动做动作依据，只保留正式净值复核和长期逻辑。",
      boundary: "今天暂停动作判断，等下一次实时链路恢复后再决定是否调整节奏。",
    };
  }

  const gold = funds.find((item) => item.code === "000218");
  const equip = funds.find((item) => item.code === "021532");
  const semisAction =
    decisionLevel.level === "A" ? "半导体继续小额分批" : "半导体只做保守靠近";
  const goldAction =
    gold?.decision_status === "ok"
      ? "黄金维持防守仓，不主动追补"
      : "黄金只保留防守仓判断";

  return {
    headline: `${semisAction}，${goldAction}`,
    subhead:
      decisionLevel.level === "A"
        ? `设备链弹性仍强于核心仓，但不适合追尖峰；黄金弱势已经被联接基金估值和底层 ETF 代理同时确认。`
        : `今天能看到部分实时方向，但信息还不够完整，因此只做慢节奏、小幅度的动作判断。`,
    boundary:
      equip?.decision_status === "ok"
        ? "今天可以给到具体基金建议，但只适合小额、分批、不追涨。"
        : "今天的建议只适合作为仓位节奏参考，不适合放大成明确的进攻动作。",
  };
}

function buildSemiconductorSummary(funds, decisionLevel) {
  const chipCore = funds.find((item) => item.code === "012552");
  const chipEquip = funds.find((item) => item.code === "021532");

  if (
    !chipCore?.intraday_estimate?.usable_for_today_decision ||
    !chipEquip?.intraday_estimate?.usable_for_today_decision
  ) {
    return "半导体今天只保留长期逻辑，不扩大动作；当前实时判断链路还不足以支持更激进的节奏判断。";
  }

  const corePct = chipCore?.intraday_estimate?.change_pct;
  const equipPct = chipEquip?.intraday_estimate?.change_pct;
  const proxyCore = chipCore?.underlying_realtime?.change_pct;
  const proxyEquip = chipEquip?.underlying_realtime?.change_pct;

  if (toNumber(corePct) < 0 && toNumber(equipPct) > 0) {
    return `核心宽基估值 ${formatPercent(corePct)}、设备仓估值 ${formatPercent(
      equipPct
    )}，说明半导体内部仍在分化；核心仓更适合按计划慢慢买，设备仓可以参考强势，但不能追高。代理对照分别是 ${formatPercent(
      proxyCore
    )} 和 ${formatPercent(proxyEquip)}。`;
  }

  if (toNumber(corePct) > 0 && toNumber(equipPct) > 0) {
    return `两只半导体基金盘中都偏强，核心宽基 ${formatPercent(
      corePct
    )}、设备仓 ${formatPercent(
      equipPct
    )}；这类上涨更适合延续小额分批，不适合突然放大单笔。代理对照分别是 ${formatPercent(
      proxyCore
    )} 和 ${formatPercent(proxyEquip)}。`;
  }

  return `两只半导体基金盘中都不算强，核心宽基 ${formatPercent(
    corePct
  )}、设备仓 ${formatPercent(
    equipPct
  )}；今天更应该看成节奏管理，而不是方向反转。代理对照分别是 ${formatPercent(
    proxyCore
  )} 和 ${formatPercent(proxyEquip)}。`;
}

function buildGoldSummary(funds) {
  const gold = funds.find((item) => item.code === "000218");

  if (!gold?.intraday_estimate?.usable_for_today_decision) {
    return "黄金今天只保留防守仓定位，不根据盘中走势做动作判断。";
  }

  const estimatePct = gold?.intraday_estimate?.change_pct;
  const proxyPct = gold?.underlying_realtime?.change_pct;

  if (toNumber(estimatePct) < 0 && toNumber(proxyPct) < 0) {
    return `黄金盘中估值 ${formatPercent(
      estimatePct
    )}，ETF 代理 ${formatPercent(
      proxyPct
    )}，弱势是被确认过的；所以今天更像防守仓承压，不适合因为一次下跌就激进补仓。`;
  }

  if (toNumber(estimatePct) > 0 && toNumber(proxyPct) > 0) {
    return `黄金盘中估值 ${formatPercent(
      estimatePct
    )}，ETF 代理 ${formatPercent(
      proxyPct
    )}，说明有修复，但它在组合里仍然只是防守仓，不承担进攻任务。`;
  }

  return `黄金盘中估值 ${formatPercent(
    estimatePct
  )}，ETF 代理 ${formatPercent(
    proxyPct
  )}，方向不算特别干净；今天保持防守仓思路，比判断短线拐点更重要。`;
}

function buildFundReason(fund, decisionLevel) {
  if (decisionLevel.level === "C") {
    return "今天不拿这只基金做动作判断，先等实时链路恢复完整。";
  }

  const estimatePct = toNumber(fund?.intraday_estimate?.change_pct);
  const proxyPct = toNumber(fund?.underlying_realtime?.change_pct);

  if (fund.code === "012552") {
    if (estimatePct !== null && proxyPct !== null && estimatePct <= 0 && proxyPct <= 0) {
      return "核心半导体确实回落，但回落幅度还像正常震荡，不像趋势转弱，继续按计划小额分批更合适。";
    }
    if (estimatePct !== null && proxyPct !== null && estimatePct > 0 && proxyPct > 0) {
      return "核心半导体同步走强，但这类上涨更适合延续计划内买入，不适合突然放大单笔。";
    }
    return "核心半导体方向有波动，慢一点比猜短线拐点更重要。";
  }

  if (fund.code === "021532") {
    if (estimatePct !== null && proxyPct !== null && estimatePct > 0 && proxyPct > 0) {
      return "设备链弹性明显更强，但强势板块也最容易放大利润回吐，所以只能比核心仓更慢地靠近。";
    }
    if (estimatePct !== null && proxyPct !== null && estimatePct <= 0 && proxyPct <= 0) {
      return "设备链一旦转弱，波动通常比核心宽基更大，因此今天更适合观察或极小额试探。";
    }
    return "设备链方向不够干净，保守一点比追当日情绪更重要。";
  }

  if (estimatePct !== null && proxyPct !== null && estimatePct < 0 && proxyPct < 0) {
    return "黄金弱势被联接基金估值和 ETF 代理同时确认，今天更适合把它当防守仓承压，而不是抄底仓。";
  }
  if (estimatePct !== null && proxyPct !== null && estimatePct > 0 && proxyPct > 0) {
    return "黄金有修复，但它在组合里的任务仍然是防守，不需要因为修复就主动追补。";
  }
  return "黄金方向还不够干净，只保留防守仓思路更稳妥。";
}

function buildFundEvidence(fund) {
  const estimateTime = formatDecisionTime(fund?.intraday_estimate?.data_time);
  const proxyTime = formatDecisionTime(fund?.underlying_realtime?.data_time);

  if (!fund?.decision_feed?.usable_for_today_decision) {
    return `这轮实时判断链路不完整；估值时间 ${estimateTime}，代理时间 ${proxyTime}。`;
  }

  return `估值 ${formatPercent(
    fund?.intraday_estimate?.change_pct
  )}（${estimateTime}），代理 ${formatPercent(
    fund?.underlying_realtime?.change_pct
  )}（${proxyTime}）。`;
}

function renderInfoCards(items, emptyText) {
  if (!Array.isArray(items) || items.length === 0) {
    return `
      <article class="event-card">
        <p><strong>${emptyText}</strong></p>
        <p class="muted">这次运行没有抓到足够高价值、且适合放进这一层的官方新增信息。</p>
      </article>
    `;
  }

  return items
    .map(
      (item) => `
      <article class="event-card">
        <p><strong>${item.title}</strong></p>
        <p class="meta">影响对象：${item.impact}｜时间：${item.time}｜来源：<a href="${item.url}" target="_blank" rel="noreferrer">${item.source}</a>｜可信度：${item.credibility}</p>
        <p><b>原始信息：</b>${item.fact}</p>
        <p><b>可能影响：</b>${item.effect}</p>
      </article>
    `
    )
    .join("");
}

function reportHtml(data) {
  const generatedAt = toChinaString(data.generated_at);
  const decisionLevel = buildDecisionLevel(data.funds);
  const freshnessSnapshot = buildFreshnessSnapshot(data.funds);
  const topConclusion = buildTopConclusion(data.funds, decisionLevel);
  const semis = buildSemiconductorSummary(data.funds, decisionLevel);
  const gold = buildGoldSummary(data.funds);
  const recentInfoCards = renderInfoCards(
    data.recent_info_items,
    "近期高价值新增信息：无"
  );
  const longTermCards = renderInfoCards(
    data.long_term_info_items,
    "长期关键锚点：本次未补充"
  );

  const actionCards =
    decisionLevel.level === "C"
      ? `
        <article class="action-card" style="grid-column: 1 / -1;">
          <div class="card-head">
            <strong>今天先不做动作判断</strong>
            <span class="badge bad">暂停建议</span>
          </div>
          <p><b>原因：</b>${topConclusion.subhead}</p>
          <p class="muted"><b>说明：</b>${decisionLevel.downgrade_reason}</p>
        </article>
      `
      : data.funds
          .map((fund) => {
            const action = decisionAction(fund, decisionLevel);
            return `
              <article class="action-card">
                <div class="card-head">
                  <strong>${fund.code} ${fund.name}</strong>
                  <span class="badge ${statusClass(fund.decision_status)}">${statusLabel(
                    fund.decision_status
                  )}</span>
                </div>
                <p><b>建议：</b>${action.action}</p>
                <p><b>节奏：</b>${action.mode}</p>
                <p><b>原因：</b>${buildFundReason(fund, decisionLevel)}</p>
                <p class="muted"><b>证据：</b>${buildFundEvidence(fund)}</p>
              </article>
            `;
          })
          .join("");

  const rows = data.funds
    .map(
      (fund) => `
      <tr>
        <td>${fund.code}</td>
        <td>${fund.name}</td>
        <td>${fund.role}</td>
        <td>${changeWord(fund.decision_feed?.change_pct ?? fund.intraday_estimate?.change_pct)}</td>
        <td>${formatDecisionTime(fund.decision_feed?.data_time ?? fund.intraday_estimate?.data_time)}</td>
        <td>${fund.decision_feed?.usable_for_today_decision ? "是" : "否"}</td>
        <td>${fund.official_nav?.nav ?? "未知"} / ${fund.official_nav?.nav_date ?? "未知"}</td>
        <td>${changeWord(fund.official_nav?.performance_1d_pct)}</td>
        <td>${changeWord(fund.official_nav?.performance_1w_pct)}</td>
        <td>${changeWord(fund.official_nav?.performance_1m_pct)}</td>
        <td>${fund.decision_status === "ok" ? "当天数据可直接参考" : fund.decision_status === "cautious" ? "只可保守参考" : "当天不做判断"}</td>
        <td>长期逻辑未改，仍按 ${fund.role} 看待。</td>
        <td>实时代理类型：${fund.underlying_realtime?.type ?? "未知"}；代理涨跌 ${formatPercent(
          fund.underlying_realtime?.change_pct
        )}。</td>
      </tr>
    `
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${data.report_date} 半导体与黄金基金最新报告</title>
  <style>
    :root {
      --bg: #f6f1e8;
      --paper: #fffdf8;
      --ink: #213036;
      --muted: #65727a;
      --line: #ddd4c6;
      --ok: #1e6a39;
      --warn: #9b6400;
      --bad: #b13c2e;
      --chip: #0d695d;
      --gold: #a87519;
      --shadow: 0 16px 42px rgba(59, 41, 21, 0.10);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(13, 105, 93, 0.12), transparent 28rem),
        radial-gradient(circle at top right, rgba(168, 117, 25, 0.12), transparent 30rem),
        linear-gradient(180deg, #f7f2e9 0%, #f1e8da 100%);
      font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", serif;
      line-height: 1.7;
    }
    main { width: min(1120px, calc(100% - 28px)); margin: 24px auto 52px; }
    section {
      background: rgba(255, 253, 248, 0.94);
      border: 1px solid var(--line);
      border-radius: 26px;
      box-shadow: var(--shadow);
      padding: 24px;
      margin-bottom: 22px;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: clamp(28px, 4vw, 44px); line-height: 1.12; margin-bottom: 12px; }
    h2 { font-size: clamp(22px, 2.6vw, 30px); margin-bottom: 14px; }
    .meta-row, .summary-grid, .actions, .event-grid { display: grid; gap: 14px; }
    .meta-row { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 16px; }
    .meta-pill, .summary-card, .action-card, .event-card { border: 1px solid var(--line); border-radius: 20px; background: var(--paper); }
    .meta-pill { padding: 10px 12px; color: var(--muted); font-size: 14px; }
    .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 20px; }
    .summary-card { padding: 18px; }
    .summary-card.chip { border-top: 5px solid var(--chip); }
    .summary-card.gold { border-top: 5px solid var(--gold); }
    .actions { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 16px; }
    .action-card { padding: 18px; }
    .card-head { display: flex; align-items: start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .badge { border-radius: 999px; padding: 4px 10px; color: white; font-size: 12px; font-weight: 700; white-space: nowrap; }
    .badge.ok { background: var(--ok); }
    .badge.warn { background: var(--warn); }
    .badge.bad { background: var(--bad); }
    .muted, .meta { color: var(--muted); font-size: 14px; }
    .event-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .event-card { padding: 18px; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 20px; background: var(--paper); }
    table { width: 100%; border-collapse: collapse; min-width: 980px; font-size: 14px; }
    th, td { padding: 12px 13px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #efe6d8; }
    tr:last-child td { border-bottom: 0; }
    @media (max-width: 780px) {
      .meta-row, .summary-grid, .actions, .event-grid { grid-template-columns: 1fr; }
      main { width: min(100% - 18px, 1120px); margin-top: 12px; }
    }
  </style>
</head>
<body>
<main>
  <section>
    <div class="meta-row">
      <div class="meta-pill">数据可信度：${freshnessSnapshot.confidence}%</div>
      <div class="meta-pill">实时覆盖：${freshnessSnapshot.coverage}</div>
      <div class="meta-pill">抓取时间：${generatedAt} CST</div>
      <div class="meta-pill">新鲜程度：${freshnessSnapshot.freshness_status}</div>
    </div>
    <h1>${topConclusion.headline}</h1>
    <p class="muted">${topConclusion.subhead}</p>
    <div class="summary-grid">
      <article class="summary-card chip">
        <h2>半导体今天怎么看</h2>
        <p>${semis}</p>
      </article>
      <article class="summary-card gold">
        <h2>黄金今天怎么看</h2>
        <p>${gold}</p>
      </article>
    </div>
    <h2 style="margin-top:18px;">今日操作建议</h2>
    <p class="muted">${topConclusion.boundary}</p>
    <div class="actions">${actionCards}</div>
  </section>

  <section>
    <h2>原始信息层</h2>
    <h3>近期信息</h3>
    <div class="event-grid">${recentInfoCards}</div>
    <h3 style="margin-top:20px;">长期信息</h3>
    <div class="event-grid">${longTermCards}</div>
  </section>

  <section>
    <h2>当前已买基金信息一览</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>基金代码</th>
            <th>基金名称</th>
            <th>基金角色</th>
            <th>当天决策数据</th>
            <th>决策数据时间</th>
            <th>是否新鲜</th>
            <th>最新正式净值</th>
            <th>近 1 日</th>
            <th>近 1 周</th>
            <th>近 1 月</th>
            <th>短期判断</th>
            <th>长期逻辑判断</th>
            <th>支持依据</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>补充说明</h2>
    <p><b>信息来源摘要：</b>当天主判断来自天天基金估值接口与实时代理行情接口；正式确认层来自东方财富历史净值接口；原始信息层使用已复核的 WSTS、World Gold Council 与 SAFE 官方公开来源。</p>
    <p><b>不确定性说明：</b>半导体两只基金的代理并非基金官方实时净值，而是前十大持仓等权实时篮子，因此它更适合做当天方向校验，不适合替代正式净值做长期收益统计。黄金代理使用黄金 ETF 实时行情，适合判断当天方向，但同样不替代基金收盘确认值。</p>
    <p><b>数据异常说明：</b>${[decisionLevel.downgrade_reason, ...(data.info_source_errors ?? [])].filter(Boolean).join("；") || "本次未触发数据降级，且原始信息层抓取正常。"}</p>
  </section>
</main>
</body>
</html>`;
}

function sourcesMarkdown(data) {
  const liveBlocks = data.funds
    .flatMap((fund) => {
      const blocks = [];
      blocks.push(`- 来源名称：${fund.intraday_estimate?.source_name ?? "未知"}
- 链接：${fund.intraday_estimate?.source_url ?? "未知"}
- 用途：${fund.code} ${fund.name} 的盘中估值。
- 数据时间：${fund.intraday_estimate?.data_time ?? "未知"}
- 抓取时间：${toChinaString(fund.intraday_estimate?.fetch_time)}
- 新鲜度：${formatFreshness(fund.intraday_estimate?.freshness_minutes)}（有效交易时间）
- 是否可用于当天判断：${fund.intraday_estimate?.usable_for_today_decision ? "是" : "否"}
- 抓取错误：${fund.intraday_estimate?.error ?? "无"}
- 可信度备注：销售平台估值，适合做当天节奏判断，不替代正式净值。`);

      blocks.push(`- 来源名称：${fund.underlying_realtime?.source_name ?? "未知"}
- 链接：${fund.underlying_realtime?.source_url ?? "未知"}
- 用途：${fund.code} ${fund.name} 的实时代理校验。
- 数据时间：${toChinaString(fund.underlying_realtime?.data_time)}
- 抓取时间：${toChinaString(fund.underlying_realtime?.fetch_time)}
- 新鲜度：${formatFreshness(fund.underlying_realtime?.freshness_minutes)}（有效交易时间）
- 是否可用于当天判断：${fund.underlying_realtime?.usable_for_today_decision ? "是" : "否"}
- 抓取错误：${fund.underlying_realtime?.error ?? "无"}
- 可信度备注：代理数据用于交叉验证当天方向；半导体使用前十大持仓等权篮子，黄金使用底层黄金 ETF。`);
      return blocks;
    })
    .join("\n\n");

  const officialBlocks = data.funds
    .map(
      (fund) => `- 来源名称：${fund.official_nav?.source_name ?? "未知"}
- 链接：${fund.official_nav?.source_url ?? "未知"}
- 用途：${fund.code} ${fund.name} 的正式净值确认。
- 数据时间：${fund.official_nav?.nav_date ?? "未知"}
- 抓取错误：${fund.official_nav?.error ?? "无"}
- 可信度备注：正式净值可信度高，用于前一交易日确认层。`
    )
    .join("\n\n");

  const recentInfoBlocks = (Array.isArray(data.recent_info_items)
    ? data.recent_info_items
    : []
  )
    .map(
      (item) => `- 条目标题：${item.title}
- 来源名称：${item.source}
- 链接：${item.url}
- 用途：${item.impact} 的近期原始信息。
- 发布时间：${item.time}
- 可信度备注：${item.credibility}；用于原始信息层，不直接替代当天盘中判断。`
    )
    .join("\n\n");

  const longTermInfoBlocks = (Array.isArray(data.long_term_info_items)
    ? data.long_term_info_items
    : []
  )
    .map(
      (item) => `- 条目标题：${item.title}
- 来源名称：${item.source}
- 链接：${item.url}
- 用途：${item.impact} 的长期原始信息。
- 发布时间：${item.time}
- 可信度备注：${item.credibility}；用于原始信息层，不直接替代当天盘中判断。`
    )
    .join("\n\n");

  return `# Sources - ${data.report_date}

> 生成时间：${toChinaString(data.generated_at)} CST

## 实时/准实时决策层

${liveBlocks}

## 正式确认层

${officialBlocks}

## 原始信息层 - 近期信息

${recentInfoBlocks || "- 本次未抓到可写入近期信息的官方事件。"}

## 原始信息层 - 长期信息

${longTermInfoBlocks || "- 本次未抓到可写入长期信息的官方事件。"}
`;
}

async function main() {
  const inputPath = getArg("--input", DEFAULT_INPUT);
  const reportPath = getArg("--report", DEFAULT_REPORT);
  const sourcesPath = getArg("--sources", DEFAULT_SOURCES);

  const raw = await readFile(inputPath, "utf8");
  const data = JSON.parse(raw);

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${reportHtml(data)}\n`, "utf8");
  await writeFile(sourcesPath, `${sourcesMarkdown(data)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
