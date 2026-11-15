/**
 * @fileoverview Pure formatting utilities for speed metrics, token counts,
 * USD estimates, countdown timers, adaptive TTFT baselines, and custom datetime displays.
 */

import { callSidecarApi } from './httpClient.js';

export function formatMetric(value, unit = '') {
  return Number.isFinite(value) ? `${value.toFixed(1)}${unit}` : '—';
}

export function formatTokens(num) {
  const n = Number(num || 0);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatTokensPrecise(num) {
  const n = Number(num || 0);
  if (n <= 0) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCnyApprox(usdAmount, rate = 7.2) {
  const rmb = Number(usdAmount || 0) * rate;
  if (rmb <= 0) return '≈ ¥0';
  if (rmb >= 10) return `≈ ¥${Math.round(rmb)}`;
  return `≈ ¥${rmb.toFixed(1)}`;
}

export function formatDateSpanBadge(startMs, endMs) {
  const s = startMs && Number.isFinite(startMs) ? new Date(startMs) : new Date();
  const e = endMs && Number.isFinite(endMs) ? new Date(endMs) : new Date();
  return `${s.getMonth() + 1}月${s.getDate()}日 ~ ${e.getMonth() + 1}月${e.getDate()}日`;
}

export function formatUsd(amount, { precise = false } = {}) {
  if (amount == null || !Number.isFinite(Number(amount))) return '待定';
  const val = Number(amount || 0);
  if (precise) {
    if (val > 0 && val < 0.001) return '<$0.001';
    return val >= 1 ? `$${val.toFixed(2)}` : `$${val.toFixed(3)}`;
  }
  return `$${val.toFixed(2)}`;
}

export function speedReasonText(reason) {
  return ({
    incomplete_or_invalid_timing: '生成未完成',
    invalid_output_tokens: '无有效输出',
    inconsistent_timing: '耗时数据异常',
    short_timing: '耗时过短 (<0.5s)',
    legacy_cache: '旧版缓存记录',
  })[reason] || '';
}

export function sampleSummary(summary) {
  const valid = summary?.sampleCount || 0;
  const excluded = summary?.excludedCount || 0;
  return `${valid}/${valid + excluded} 步`;
}

export function formatCountdown(isoTime, nowMs = Date.now()) {
  if (!isoTime) return '未知重置时间';
  const targetMs = Date.parse(isoTime);
  if (!Number.isFinite(targetMs) || targetMs <= 0) return '未知重置时间';
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return '即将重置';
  if (diffMs < 60_000) return '<1分钟后重置';

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}天 ${hours}小时后重置`;
  if (hours > 0) return `${hours}小时 ${minutes}分后重置`;
  return `${minutes}分钟后重置`;
}

export function formatCompactDateTime(ms) {
  if (!ms || !Number.isFinite(ms)) return '选择时间';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatElapsedSec(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) {
    return `${m}m ${String(remS).padStart(2, '0')}s`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

export function formatStepDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds)) || Number(seconds) <= 0) {
    return '—';
  }
  const s = Number(seconds);
  if (s < 60) {
    return `${s.toFixed(1)}s`;
  }
  const roundedSec = Math.round(s);
  const m = Math.floor(roundedSec / 60);
  const remS = roundedSec % 60;
  if (m < 60) {
    return `${m}m${String(remS).padStart(2, '0')}s`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h${String(remM).padStart(2, '0')}m`;
}

export function formatStepDurationDetail(step) {
  const total = step?.totalDurationSec;
  if (total == null || !Number.isFinite(Number(total)) || Number(total) <= 0) {
    return step?.isComplete === false ? '该步仍在生成中' : '无有效单步耗时记录';
  }
  const parts = [`总耗时 ${Number(total).toFixed(2)}s`];
  if (Number.isFinite(step?.ttftSec) && step.ttftSec >= 0) {
    parts.push(`首字 ${Number(step.ttftSec).toFixed(2)}s`);
  }
  if (Number.isFinite(step?.thinkingDurationSec) && step.thinkingDurationSec > 0) {
    parts.push(`思考 ${Number(step.thinkingDurationSec).toFixed(2)}s`);
  }
  if (Number.isFinite(step?.nativeStreamSec) && step.nativeStreamSec > 0) {
    parts.push(`输出流 ${Number(step.nativeStreamSec).toFixed(2)}s`);
  }
  return parts.join(' · ');
}

/**
 * 格式化单步首 Token 耗时 (TTFT) 悬停详情。
 *
 * @param {object|null|undefined} step
 * @param {{ isSlow?: boolean, isStall?: boolean, medianSec?: number|null }|null} [ttftInfo]
 * @returns {string}
 */
export function formatStepTtftDetail(step, ttftInfo = null) {
  if (!Number.isFinite(step?.ttftSec) || step.ttftSec < 0) {
    return step?.isComplete === false ? '等待首 Token 响应中' : '无有效首 Token 耗时记录';
  }
  let text = `首 Token 耗时 ${Number(step.ttftSec).toFixed(2)}s`;
  if (Number.isFinite(step?.thinkingDurationSec) && step.thinkingDurationSec > 0) {
    text += ` · 思考 ${Number(step.thinkingDurationSec).toFixed(2)}s`;
  }
  if (ttftInfo && ttftInfo.medianSec !== null && Number.isFinite(ttftInfo.medianSec)) {
    text += ` (同模型中位 ${ttftInfo.medianSec.toFixed(1)}s)`;
  }
  if (ttftInfo?.isStall) {
    text += ' · 明显卡顿';
  } else if (ttftInfo?.isSlow) {
    text += ' · 较慢';
  }
  return text;
}

/**
 * 归一化 Orchestrator 系列 ID 显示格式枚举（`'compact'` 精简代号 vs `'full'` 原始完整 ID，默认 `'compact'`）。
 *
 * @param {unknown} mode
 * @returns {'compact'|'full'}
 */
export function normalizeOrchestratorIdDisplayMode(mode) {
  return String(mode ?? '').trim().toLowerCase() === 'full' ? 'full' : 'compact';
}

/**
 * 统一解析步骤、会话摘要或模型汇总行面向用户的模型显示文本与悬停提示。
 *
 * 规则：
 * - Orchestrator 系列（`Orchestrator (Carbon)`、`Orchestrator (Argon)`、`gemini-flash-worker-agy` / `M669`）
 *   独立遵循 `orchestratorIdMode`（`'compact'` 显示 `orchestrator-carbon` / `orchestrator-argon` / `worker-agy-hydrogen`；
 *   `'full'` 显示带括号标注的完整上游 ID），不受普通模型“精简代号 / 原始模型 ID”切换影响；
 * - 其余普通模型继续按 `showUpstreamModel` 与视图选项切换。
 *
 * @param {object|null|undefined} target
 * @param {{ showUpstreamModel?: boolean, orchestratorIdMode?: string }|boolean} [settings]
 * @param {{ preferLabelInShort?: boolean, fallback?: string }} [options]
 * @returns {{ text: string, title: string, isOrchestratorSeries: boolean }}
 */
export function resolveModelDisplayInfo(target, settings = {}, options = {}) {
  const showUpstream =
    typeof settings === 'boolean' ? settings : Boolean(settings?.showUpstreamModel);
  const orchestratorMode = normalizeOrchestratorIdDisplayMode(
    typeof settings === 'object' && settings ? settings.orchestratorIdMode : 'compact'
  );
  const preferLabelInShort = Boolean(options?.preferLabelInShort);
  const fallback = options?.fallback ?? '模型未知';

  if (!target || typeof target !== 'object') {
    return { text: fallback, title: fallback, isOrchestratorSeries: false };
  }

  const shortText = String(
    target.activeModelShort ?? target.modelShort ?? target.shortName ?? ''
  ).trim();
  const labelText = String(
    target.activeModelLabel ?? target.modelLabel ?? target.label ?? ''
  ).trim();
  const upstreamText = String(
    target.activeModelUpstream ?? target.modelUpstream ?? target.upstreamName ?? ''
  ).trim();
  const responseText = String(target.responseModel ?? '').trim();
  const modelKeyText = String(target.modelKey ?? '').trim();

  const isCompaction =
    Boolean(target.isCompactionStep) ||
    /·压缩\s*$/.test(shortText) ||
    /·压缩\s*$/.test(upstreamText) ||
    /·压缩\s*$/.test(labelText);

  const combined = `${modelKeyText} ${shortText} ${labelText} ${upstreamText} ${responseText}`;
  const isOrchWorker =
    /\bMODEL_PLACEHOLDER_M669\b|\b[a-z0-9.-]*worker-agy\b|\bworker-agy-hydrogen\b|\bOrchestrator\s+Worker\b/i.test(
      combined
    );
  const isOrchSeries =
    isOrchWorker ||
    /\bgemini-pro-orchestrator(?:-argon)?\b|\borchestrator-(?:carbon|argon)\b|\borch-(?:carbon|argon)(?:·压缩)?(?=\s|$)|Orchestrator\s*\((?:Carbon|Argon)\)|\bMODEL_PLACEHOLDER_M(?:667|681)\b/i.test(
      combined
    );

  if (isOrchSeries) {
    let compactId = 'orchestrator-carbon';
    let fullId = 'gemini-pro-orchestrator (carbon-4)';
    if (isOrchWorker) {
      compactId = 'worker-agy-hydrogen';
      fullId = 'gemini-flash-worker-agy (hydrogen-4)';
    } else if (/\bargon\b|\bMODEL_PLACEHOLDER_M681\b|\borch-argon\b/i.test(combined)) {
      compactId = 'orchestrator-argon';
      fullId = 'gemini-pro-orchestrator-argon (argon-4)';
    }
    const suffix = isCompaction ? '·压缩' : '';
    const text = `${orchestratorMode === 'full' ? fullId : compactId}${suffix}`;
    const multiUpstream =
      Array.isArray(target.upstreamModels) && target.upstreamModels.length > 1
        ? target.upstreamModels.join(' / ')
        : '';
    const title = multiUpstream || `${fullId}${suffix}`;
    return { text, title, isOrchestratorSeries: true };
  }

  const standardText =
    (showUpstream
      ? upstreamText || responseText || shortText || labelText
      : preferLabelInShort
        ? labelText || shortText
        : shortText || labelText) || fallback;
  const standardTitle =
    showUpstream && Array.isArray(target.upstreamModels) && target.upstreamModels.length > 1
      ? target.upstreamModels.join(' / ')
      : standardText;
  return { text: standardText, title: standardTitle, isOrchestratorSeries: false };
}

/**
 * 将模型名称拆分为可优先折叠的前缀 (`head`) 与需优先保留的核心区分尾部 (`tail`)。
 * 保证在纯 LTR 排版下严格满足 `head + tail === normalizedStr`。
 *
 * @param {unknown} rawText
 * @returns {{ head: string, tail: string }}
 */
export function splitModelHeadTail(rawText) {
  const str = String(rawText ?? '').replace(/[\r\n]+/g, ' ');
  if (str.length <= 10) {
    return { head: '', tail: str };
  }
  const parenMatch = str.match(/^(.+?\s+)(\([^()]+\)(?:·压缩)?)$/);
  if (parenMatch && parenMatch[2].length <= 16) {
    return { head: parenMatch[1], tail: parenMatch[2] };
  }
  const parts = str.match(/[^-_/\s]+[-_/\s]*/g);
  if (!parts || parts.length <= 1) {
    return { head: str.slice(0, -9), tail: str.slice(-9) };
  }
  let tail = parts[parts.length - 1];
  let idx = parts.length - 2;
  while (idx >= 1 && tail.length + parts[idx].length <= 10) {
    tail = parts[idx] + tail;
    idx -= 1;
  }
  const head = parts.slice(0, idx + 1).join('');
  if (!head) {
    return { head: str.slice(0, -9), tail: str.slice(-9) };
  }
  return { head, tail };
}

/**
 * 将指令文本安全复制到系统剪贴板：
 * 1. 优先在 await 前同步触发临时 `<textarea>` 选区 `execCommand('copy')`，保留 Webview 用户激活态；
 * 2. 回退至异步 `navigator.clipboard.writeText`；
 * 3. 若宿主沙箱拦截前端剪贴板权限，通过本地 Sidecar `/api/clipboard` 写入系统剪贴板。
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyTextToClipboard(text) {
  const str = String(text ?? '');
  if (!str) return false;
  if (typeof window !== 'undefined') {
    window.__AGLastCopiedText = str;
  }

  let syncCopied = false;
  if (
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function' &&
    typeof document.execCommand === 'function' &&
    document.body?.appendChild
  ) {
    let ta = null;
    const prevActive = document.activeElement;
    try {
      ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute?.('readonly', '');
      if (ta.style) {
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '-9999px';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
      }
      document.body.appendChild(ta);
      ta.focus?.({ preventScroll: true });
      ta.select?.();
      ta.setSelectionRange?.(0, str.length);
      syncCopied = Boolean(document.execCommand('copy'));
    } catch {
      syncCopied = false;
    } finally {
      ta?.remove?.();
      try {
        prevActive?.focus?.({ preventScroll: true });
      } catch {
        // ignore focus restore failure
      }
    }
  }

  let asyncCopied = false;
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(str);
      asyncCopied = true;
    } catch {
      asyncCopied = false;
    }
  }

  if (syncCopied || asyncCopied) {
    return true;
  }

  try {
    const res = await callSidecarApi('/api/clipboard', {
      method: 'POST',
      body: { text: str },
    });
    if (res?.ok) return true;
  } catch {
    // ignore fallback failure
  }
  return false;
}

/**
 * 复制文本并驱动单槽位定时反馈回调（如按钮短暂切换为 `已复制` 后自动恢复）。
 */
export async function copyWithTimedFeedback(text, timerHolder, onToggle, durationMs = 1500) {
  const ok = await copyTextToClipboard(text);
  if (!ok || typeof onToggle !== 'function') return ok;
  if (timerHolder?.id) {
    clearTimeout(timerHolder.id);
    timerHolder.id = null;
  }
  onToggle(true);
  if (timerHolder) {
    timerHolder.id = setTimeout(() => {
      timerHolder.id = null;
      onToggle(false);
    }, durationMs);
  }
  return true;
}

/**
 * 提取步骤用于首字延迟 (TTFT) 基线分桶的模型规范键。
 *
 * @param {object|null|undefined} st
 * @returns {string}
 */
export function resolveStepTtftModelBucket(st) {
  const raw = String(
    st?.responseModel || st?.modelUpstream || st?.modelShort || st?.modelKey || 'unknown'
  )
    .replace(/·压缩|\[自动压缩\]/g, '')
    .trim()
    .toLowerCase();
  return raw || 'unknown';
}

/**
 * 按模型级别与推理深度特征推导合理的 TTFT 先验阈值（快响应 / 标准 / 旗舰深度思考）。
 *
 * @param {object|null|undefined} st
 * @returns {{ tier: 'fast'|'standard'|'deep', warnFloor: number, stallFloor: number, prefillPer100k: number }}
 */
export function resolveModelTtftPriors(st) {
  const sig = `${st?.modelKey || ''} ${st?.responseModel || ''} ${st?.modelUpstream || ''} ${st?.modelShort || ''} ${st?.modelLabel || ''}`.toLowerCase();
  if (
    /\b(?:flash|lite|haiku|hydrogen|mini)\b|worker-agy/.test(sig) &&
    !/thinking|carbon|opus/.test(sig)
  ) {
    return { tier: 'fast', warnFloor: 5.0, stallFloor: 10.0, prefillPer100k: 1.2 };
  }
  if (/\b(?:carbon|orchestrator|opus|thinking|xhigh|high|o1|o3|o4|gpt-5)\b/.test(sig)) {
    return { tier: 'deep', warnFloor: 18.0, stallFloor: 36.0, prefillPer100k: 3.0 };
  }
  return { tier: 'standard', warnFloor: 9.0, stallFloor: 18.0, prefillPer100k: 2.0 };
}

/**
 * 从当前会话步骤列表按同模型统计首字延迟（TTFT）实测中位数基线（至少 3 条已完成样本）。
 *
 * @param {object[]} [steps=[]]
 * @returns {Map<string, { count: number, medianSec: number }>}
 */
export function buildModelTtftBaselines(steps = []) {
  const byBucket = new Map();
  for (const s of steps || []) {
    if (!s || s.isCompactionStep || s.isComplete === false) continue;
    const v = Number(s.ttftSec);
    if (!Number.isFinite(v) || v < 0) continue;
    const bucket = resolveStepTtftModelBucket(s);
    let arr = byBucket.get(bucket);
    if (!arr) {
      arr = [];
      byBucket.set(bucket, arr);
    }
    arr.push(v);
  }
  const baselines = new Map();
  for (const [bucket, vals] of byBucket.entries()) {
    if (vals.length < 3) continue;
    const sorted = vals.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianSec =
      sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    baselines.set(bucket, { count: sorted.length, medianSec });
  }
  return baselines;
}

/**
 * 结合模型先验分级、未缓存 Pre-fill 体量、缓冲思考耗时与本会话同模型实测中位数，
 * 判定单步 TTFT 是否真正偏慢或卡顿，避免误标旗舰思考模型的正常首字耗时。
 *
 * @param {object|null|undefined} st
 * @param {Map<string, { count: number, medianSec: number }>|null} [baselinesMap=null]
 */
export function classifyStepTtft(st, baselinesMap = null) {
  const ttftNum = Number(st?.ttftSec);
  if (!Number.isFinite(ttftNum) || ttftNum < 0) {
    return {
      hasTtft: false,
      ttftNum: null,
      isSlow: false,
      isStall: false,
      medianSec: null,
      warnAt: null,
      stallAt: null,
    };
  }
  const priors = resolveModelTtftPriors(st);
  const base = baselinesMap?.get(resolveStepTtftModelBucket(st)) || null;
  const thinkDur = Number(st?.thinkingDurationSec);
  const effectiveTtft =
    Number.isFinite(thinkDur) && thinkDur > 1 && ttftNum >= thinkDur * 0.9
      ? Math.max(0, ttftNum - thinkDur * 0.85)
      : ttftNum;
  const fresh100k = Math.max(0, Number(st?.inputTokens || 0)) / 100000;
  const prefillAdd = fresh100k * priors.prefillPer100k;
  const medianSec = base?.medianSec ?? null;
  const warnAt = Math.max(
    priors.warnFloor + prefillAdd,
    medianSec !== null ? medianSec * 2.0 : 0
  );
  const stallAt = Math.max(
    priors.stallFloor + prefillAdd * 1.5,
    medianSec !== null ? medianSec * 3.2 : 0
  );
  const isStall = effectiveTtft >= stallAt;
  const isSlow = !isStall && effectiveTtft >= warnAt;
  return {
    hasTtft: true,
    ttftNum,
    isSlow,
    isStall,
    medianSec,
    warnAt,
    stallAt,
  };
}
