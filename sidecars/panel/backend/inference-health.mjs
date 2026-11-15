/**
 * @fileoverview 推理健康度归因与可操作自救处方引擎（纯算法，零外部依赖）。
 *
 * 理论锚点与混杂因素隔离原则：
 * 1. 前缀缓存队列溢出切流（RadixAttention / Preble Queue Spill）：
 *    排除 `>= 240s` TTL 过期、上下文压缩（CHECKPOINT）、模型切换与 Plan->Execution 阶段切换，
 *    仅在同模型同执行层且短间隔内捕获冷切流（cache < 20% 且 fresh input 激增）或前缀回退（rewind >= 4k）。
 * 2. 测试时计算断崖（TTC Budget Throttling）：
 *    基于本会话同模型非异常步的非参数中位数基线，捕获思考占比/思考时长骤降（<-70% 基线）或高产出零思考。
 * 3. 长上下文注意力腐化（Lost in the Middle / KV Quantization Rot）：
 *    统计未改文件 10 步内 >=60% 行区间重叠重读（Amnesia）、单轮同文件多次返工与 4-gram 复读坍缩。
 * 4. 工程执行内生失误（Endogenous Faults）：
 *    捕获 `edit_file` 原文对齐失败、非测试类内联脚本语法崩溃，排除正常的 `npm test` / `pytest` 失败；
 *    支持用户显式否定与 `git checkout/restore/reset` 回滚确认。
 */

const IH_CACHE_TTL_MAX_SEC = 295;
const IH_CACHE_ZERO_PREV_MIN = 12000;
const IH_REPLICA_PREV_CACHE_MIN = 24000;

function ihMedian(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return null;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ihFormatCompactTok(n) {
  const num = Number(n || 0);
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(Math.round(num));
}

function ihIsExecWorkerStep(st, hasPlannerModel) {
  if (st?.healthSignals?.inExecutionPhase) return true;
  if (!hasPlannerModel) return false;
  const sig = `${st?.modelDisplayName || ''} ${st?.responseModel || ''} ${st?.modelLabel || ''}`;
  return /Orchestrator Worker|gemini-flash-worker-agy|\bhydrogen\b/i.test(sig);
}

function ihIsWorkerMarkerText(st) {
  const sig = `${st?.modelDisplayName || ''} ${st?.responseModel || ''} ${st?.modelLabel || ''}`;
  return /Orchestrator Worker|gemini-flash-worker-agy|\bhydrogen\b/i.test(sig);
}

function ihBuildModelBaselines(chronoSteps, hasPlannerModel) {
  const byModel = new Map();
  for (const st of chronoSteps) {
    if (!st || st.isCompactionStep) continue;
    if (ihIsExecWorkerStep(st, hasPlannerModel)) continue;
    const key = st.modelKey || 'unknown';
    let entry = byModel.get(key);
    if (!entry) {
      entry = {
        demonstratesThinking: false,
        thinkShares: [],
        thinkDurShares: [],
        tpsValues: [],
      };
      byModel.set(key, entry);
    }
    const hs = st.healthSignals || {};
    const idText = `${st.modelKey || ''} ${st.modelLabel || ''}`;
    if (
      (st.thinkingTokens || 0) >= 80 ||
      (st.thinkingDurationSec || 0) >= 1.2 ||
      hs.hasThinkingText === true ||
      /-(?:xhigh|high)\b|carbon|opus|thinking/i.test(idText)
    ) {
      entry.demonstratesThinking = true;
    }
    if ((st.outputTokens || 0) >= 400 && (st.thinkingTokens || 0) > 0) {
      entry.thinkShares.push(st.thinkingTokens / st.outputTokens);
    }
    if ((st.totalDurationSec || 0) >= 3 && (st.thinkingDurationSec || 0) > 0) {
      entry.thinkDurShares.push(st.thinkingDurationSec / st.totalDurationSec);
    }
    if (st.speedSampleEligible && Number.isFinite(st.tokPerSec)) {
      entry.tpsValues.push(st.tokPerSec);
    }
  }

  const resolved = new Map();
  for (const [key, raw] of byModel.entries()) {
    resolved.set(key, {
      demonstratesThinking: raw.demonstratesThinking,
      medianThinkShare: ihMedian(raw.thinkShares) ?? 0,
      medianThinkDurShare: ihMedian(raw.thinkDurShares) ?? 0,
      medianTps: ihMedian(raw.tpsValues),
    });
  }
  return resolved;
}

function ihBuildTurnDiagnosis({
  turnIndex,
  turnSteps,
  stepFindingsMap,
  agentId,
  agentBadge,
}) {
  let infraCount = 0;
  let upstreamCount = 0;
  let driftCount = 0;
  let zeroCacheCount = 0;
  let partialDriftCount = 0;
  let zeroThinkCount = 0;
  let burstThinkCount = 0;
  let editFaultCount = 0;
  let toolFaultCount = 0;
  let amnesiaReadCount = 0;
  let hasThrashing = false;
  let hasHighRepeat = false;
  let hasExecWorkerFault = false;
  let maxCtxInTurn = 0;
  let userRejectedTurn = false;
  let confirmedRollback = false;
  let anchorStepIndex = null;
  let bestAnchorScore = -1;
  const candidateReasons = [];

  let lastAnomIdx = -1;
  for (let i = 0; i < turnSteps.length; i++) {
    const f = stepFindingsMap.get(turnSteps[i]) || {};
    if ((f.stepPoints || 0) > 0) lastAnomIdx = i;
  }
  const trailingCleanSteps =
    lastAnomIdx >= 0 ? turnSteps.length - 1 - lastAnomIdx : turnSteps.length;
  const tailVerifiedPass =
    lastAnomIdx >= 0 &&
    turnSteps
      .slice(lastAnomIdx + 1)
      .some((s) => Boolean(s?.healthSignals?.cleanVerifyPass));

  for (const st of turnSteps) {
    const hs = st.healthSignals || {};
    const f = stepFindingsMap.get(st) || {};
    const ctxVal = Number(st.contextTokens || st.estimatedContextTokens || 0);
    if (ctxVal > maxCtxInTurn) maxCtxInTurn = ctxVal;
    if (hs.userRejectedTurn) userRejectedTurn = true;
    if (hs.confirmedRollback) confirmedRollback = true;

    const hasStepAnomaly = Boolean(
      f.replicaDrift ||
        f.upstreamFault ||
        f.zeroThinking ||
        f.burstUnderthinking ||
        f.editFaultCount > 0 ||
        f.toolFaultCount > 0 ||
        f.amnesiaReadCount > 0 ||
        f.thrashingEdits ||
        f.highRepeat ||
        f.workerFault
    );
    if (hasStepAnomaly) {
      const w = f.stepPoints || 0;
      if (anchorStepIndex === null || w > bestAnchorScore) {
        anchorStepIndex = st.stepIndex;
        bestAnchorScore = w;
      }
    }

    if (f.upstreamFault) {
      infraCount += 1;
      upstreamCount += 1;
    }
    if (f.replicaDrift) {
      infraCount += 1;
      driftCount += 1;
      if (f.replicaDrift.kind === 'cold_zero') zeroCacheCount += 1;
      else partialDriftCount += 1;
    }
    if (f.zeroThinking) zeroThinkCount += 1;
    if (f.burstUnderthinking) burstThinkCount += 1;
    editFaultCount += f.editFaultCount || 0;
    toolFaultCount += f.toolFaultCount || 0;
    amnesiaReadCount += f.amnesiaReadCount || 0;
    if (f.thrashingEdits) hasThrashing = true;
    if (f.highRepeat) hasHighRepeat = true;
    if (f.workerFault) hasExecWorkerFault = true;

    if (f.proof) {
      candidateReasons.push({
        ord: candidateReasons.length,
        text: `#${st.stepIndex} ${f.proof}`,
        weight: f.stepPoints || 0,
      });
    }
  }

  candidateReasons.sort((a, b) => b.weight - a.weight || a.ord - b.ord);
  const reasons = candidateReasons.slice(0, 3).map((r) => r.text);

  if (anchorStepIndex === null) {
    anchorStepIndex = turnSteps[0]?.stepIndex ?? null;
  }

  const hasCleanTailRecovery =
    turnSteps.length >= 3 &&
    trailingCleanSteps >= 2 &&
    !userRejectedTurn &&
    !confirmedRollback;

  let dInfra = 0;
  if (
    infraCount === 1 &&
    upstreamCount === 0 &&
    zeroThinkCount === 0 &&
    burstThinkCount === 0 &&
    editFaultCount === 0 &&
    toolFaultCount === 0 &&
    !hasThrashing &&
    amnesiaReadCount === 0
  ) {
    if (hasCleanTailRecovery) {
      dInfra = 8;
    } else if (zeroCacheCount === 1 && trailingCleanSteps === 0) {
      dInfra = 34;
    } else {
      dInfra = 16;
    }
  } else if (infraCount > 0) {
    dInfra = Math.min(40, 24 + 10 * (infraCount - 1) + (zeroCacheCount >= 2 ? 6 : 0));
    if (
      hasCleanTailRecovery &&
      zeroThinkCount === 0 &&
      editFaultCount === 0 &&
      toolFaultCount === 0 &&
      infraCount <= 2
    ) {
      dInfra = Math.min(dInfra, 18);
    }
  }

  let dThink = 0;
  if (zeroThinkCount > 0 || burstThinkCount > 0) {
    const baseThinkPenalty = zeroThinkCount > 0 ? 24 : 18;
    const compoundBoost = infraCount > 0 ? 10 : 0;
    dThink = Math.min(
      36,
      baseThinkPenalty + compoundBoost + Math.max(0, zeroThinkCount + burstThinkCount - 1) * 6
    );
    if (hasCleanTailRecovery && tailVerifiedPass && infraCount === 0) {
      dThink = Math.round(dThink * 0.55);
    }
  }

  let dFault = 0;
  if (
    editFaultCount === 1 &&
    toolFaultCount === 0 &&
    amnesiaReadCount === 0 &&
    !hasExecWorkerFault &&
    trailingCleanSteps >= 1 &&
    !userRejectedTurn &&
    !confirmedRollback
  ) {
    dFault = 8;
  } else if (editFaultCount > 0 || toolFaultCount > 0) {
    let rawFault =
      (editFaultCount > 0 ? 20 + 14 * (editFaultCount - 1) : 0) + toolFaultCount * 16;
    if (
      hasCleanTailRecovery &&
      tailVerifiedPass &&
      editFaultCount + toolFaultCount <= 2 &&
      !hasExecWorkerFault
    ) {
      rawFault = Math.round(rawFault * 0.5);
    }
    dFault = Math.min(46, rawFault);
  }

  const amnesiaPts =
    amnesiaReadCount === 0
      ? 0
      : amnesiaReadCount === 1 && editFaultCount === 0 && !hasThrashing && hasCleanTailRecovery
        ? 10
        : 18 + 12 * (amnesiaReadCount - 1);
  const thrashPts = !hasThrashing
    ? 0
    : hasCleanTailRecovery && tailVerifiedPass
      ? 18
      : maxCtxInTurn >= 140000
        ? 36
        : 34;
  const dRot = Math.min(38, amnesiaPts + thrashPts + (hasHighRepeat ? 28 : 0));

  let score = Math.max(5, 100 - (dInfra + dThink + dFault + dRot));
  if (confirmedRollback) {
    score = Math.min(score, 25);
    if (reasons.length < 3) {
      reasons.push('该轮后续已触发用户打断并执行 Git 回滚');
    }
  } else if (userRejectedTurn && score < 85) {
    score = Math.min(score, 48);
    if (reasons.length < 3) {
      reasons.push('下一轮用户显式反馈做法不佳并要求调整');
    }
  }

  const level =
    score < 40 ? 'critical' : score < 68 ? 'warn' : score < 85 ? 'notice' : 'healthy';

  if (level !== 'warn' && level !== 'critical') {
    return {
      turnIndex,
      score,
      level,
      category: '',
      badge: '',
      title: '',
      summary: '',
      anchorStepIndex,
      reasons,
      agentId,
      agentBadge,
      primaryAction: null,
      secondaryAction: null,
    };
  }

  let category = 'tool_fault_loop';
  if (
    hasHighRepeat ||
    (maxCtxInTurn >= 140000 && (dRot >= 16 || (dFault >= 22 && dInfra === 0)))
  ) {
    category = 'context_rot';
  } else if (hasExecWorkerFault && (dFault >= 16 || confirmedRollback)) {
    category = 'worker_handoff';
  } else if (dInfra > 0) {
    category = 'replica_drift';
  } else if (dThink > 0) {
    category = 'thinking_throttled';
  }

  const stepRef = anchorStepIndex !== null ? `#${anchorStepIndex}` : '当前问题步';
  let badge = '执行循环';
  let title = '本轮工具执行连续失误';
  let summary = '单轮内出现多次编辑对齐失败或内联命令语法报错，建议停止继续试错并重新核对准确行号。';
  if (category === 'tool_fault_loop' && hasThrashing && dFault === 0) {
    badge = '反复返工';
    title = '同一代码区域连续推翻改写';
    summary = '单轮内针对同一代码片段连续多次覆写或来回回退，建议先停下核清边界条件后再一次性修改。';
  }
  let primaryAction = {
    kind: 'copy',
    label: `复制 ${stepRef} 止损指令`,
    copyText: `停下当前尝试（${stepRef} 附近出现连续工具失误）。请重新读取目标文件的准确行范围核对现状，确认后再做最小改动。`,
    toast: '已复制止损指令',
  };
  let secondaryAction = {
    kind: 'jump_step',
    label: `定位 ${stepRef}`,
    stepIndex: anchorStepIndex,
    agentId,
  };

  if (category === 'context_rot') {
    badge = '上下文退化';
    title = `长上下文注意力退化（${ihFormatCompactTok(maxCtxInTurn)}）`;
    summary =
      '高水位下模型出现短期失忆或定位偏差，继续追加指令易越改越乱，建议立即压缩上下文或新开窗口。';
    primaryAction = {
      kind: 'copy',
      label: '复制 /compact 指令',
      copyText: '/compact',
      toast: '已复制 /compact',
    };
    secondaryAction = {
      kind: 'copy',
      label: '复制交接摘要指令',
      copyText:
        '先停下修改。请把当前已修改文件、未完成目标、关键约束与验证结论整理成结构化交接摘要，我将新开会话继续。',
      toast: '已复制交接指令',
    };
  } else if (category === 'worker_handoff') {
    badge = '执行层切换';
    title = '轻量执行模型接管后出现失误';
    summary =
      '当前轮次处于 Plan->Execution 轻量执行层且产生工具失误，建议切回完整旗舰模型核对方案后重做。';
    primaryAction = {
      kind: 'copy',
      label: '复制旗舰重审指令',
      copyText: `停止继续尝试。请切回主规划模式重新检查 ${stepRef} 之前的修改边界与真实代码上下文，确认方案后再修改。`,
      toast: '已复制重审指令',
    };
  } else if (category === 'replica_drift') {
    if (zeroCacheCount > 0 && partialDriftCount === 0) {
      badge = '缓存清零';
      if (dThink === 0 && dFault === 0 && upstreamCount === 0) {
        title =
          zeroCacheCount >= 2
            ? '本轮前缀缓存连续清零（重复全量计费）'
            : '前缀缓存意外清零（触发冷预填充）';
        summary =
          '短间隔内服务端前缀缓存跌至 0%，导致首字变慢与输入全量计费；当前推理质量未见异常，若连续清零建议检查代理会话保持或稍候再发。';
        primaryAction = {
          kind: 'jump_step',
          label: `定位 ${stepRef}`,
          stepIndex: anchorStepIndex,
          agentId,
        };
        secondaryAction = {
          kind: 'copy',
          label: '复制稳态续写提示',
          copyText:
            '请继续当前任务，修改同一文件时尽量合并相邻块以降低重复预填充开销。',
          toast: '已复制提示',
        };
      } else {
        title = '缓存清零伴随推理质量下滑';
        summary =
          '检测到短时前缀缓存跌至 0% 且思考深度/工具执行质量同步下滑，建议先核对或从断点回退重做。';
        primaryAction = {
          kind: 'copy',
          label: `复制 ${stepRef} 回退指令`,
          copyText: `我需要打断当前做法：从 ${stepRef} 步开始出现异常，请先回退或核对 ${stepRef} 之前的正确状态，再按原目标重新执行。`,
          toast: '已复制回退指令',
        };
      }
    } else {
      badge = '副本漂移';
      title =
        upstreamCount > 0 && driftCount === 0
          ? '上游超时重连后推理质量下滑'
          : '服务端切流/缓存倒退引发质量下滑';
      summary =
        '检测到短时前缀缓存异常或上游流中断重连，随后思考深度/产出质量显著偏离基线，建议从断点回退重做。';
      primaryAction = {
        kind: 'copy',
        label: `复制 ${stepRef} 回退指令`,
        copyText: `我需要打断当前做法：从 ${stepRef} 步开始出现异常，请先回退或核对 ${stepRef} 之前的正确状态，再按原目标重新执行。`,
        toast: '已复制回退指令',
      };
    }
  } else if (category === 'thinking_throttled') {
    badge = '思考坍缩';
    title = '本轮思考深度显著低于基线';
    summary =
      '执行代码改动时思考投入相比同会话基线大幅缩水，疑似上游思考预算受限，建议强制分步列出计划或切换模型池。';
    primaryAction = {
      kind: 'copy',
      label: '复制强制推理约束',
      copyText:
        '先暂停直接改代码。请先逐条列出受影响文件、精确行号、潜在边界条件和验证步骤，确认无误后再动手修改。',
      toast: '已复制约束指令',
    };
  }

  return {
    turnIndex,
    score,
    level,
    category,
    badge,
    title,
    summary,
    anchorStepIndex,
    reasons,
    agentId,
    agentBadge,
    primaryAction,
    secondaryAction,
    alertKey: `${agentId || 'main'}:T${turnIndex}:${category}:${score}:${anchorStepIndex ?? 'none'}:${reasons.length}`,
  };
}

/**
 * 对单个代理（主代理或子代理）的标准化步骤数组执行推理健康度评估与归因。
 * 会原地标注每个步骤的 `stepHealthLevel`、`stepHealthBadge`、`stepHealthDetail`、`isCacheAnomaly` 与所在轮次分值，
 * 并返回供顶部实时预警卡与气泡使用的 `activeAlert` 与 `turnDiagnoses`。
 *
 * @param {object[]} steps 按时间升序排列的步骤数组
 * @param {{ agentId?: string, agentLabel?: string, agentBadge?: string, isRunning?: boolean }} [options]
 */
export function evaluateAgentInferenceHealth(steps = [], options = {}) {
  const agentId = options.agentId || 'main';
  const agentBadge = options.agentBadge || '主';

  if (!Array.isArray(steps) || steps.length === 0) {
    return {
      sessionScore: 100,
      anomalyStepCount: 0,
      anomalyTurnCount: 0,
      activeAlert: null,
      turnDiagnoses: [],
    };
  }

  const hasPlannerModel = steps.some(
    (s) => s && !s.isCompactionStep && !s.healthSignals?.inExecutionPhase && !ihIsWorkerMarkerText(s)
  );
  const baselines = ihBuildModelBaselines(steps, hasPlannerModel);

  const stepFindingsMap = new Map();
  let prevNonCompact = null;
  let prevIsWorker = false;

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (!st || typeof st !== 'object') continue;
    const hs = st.healthSignals || {};

    if (st.isCompactionStep) {
      prevNonCompact = null;
      prevIsWorker = false;
      st.stepHealthLevel = 'healthy';
      st.stepHealthBadge = '';
      st.stepHealthDetail = '';
      st.isCacheAnomaly = false;
      st.cacheZeroReason = st.cacheReadTokens === 0 ? 'compaction' : '';
      continue;
    }

    const isWorker = ihIsExecWorkerStep(st, hasPlannerModel);
    const baseline = baselines.get(st.modelKey || 'unknown') || {
      demonstratesThinking: false,
      medianThinkShare: 0,
      medianThinkDurShare: 0,
      medianTps: null,
    };

    const upstreamFault = (hs.upstreamErrorCount || 0) > 0 || (hs.retryCount || 0) > 0;
    let replicaDrift = null;
    st.cacheZeroReason = '';
    if (
      prevNonCompact &&
      st.modelKey === prevNonCompact.modelKey &&
      !hs.justSwitchedExecPhase &&
      isWorker === prevIsWorker &&
      prevNonCompact.createdAtMs > 0 &&
      st.createdAtMs >= prevNonCompact.createdAtMs
    ) {
      const prevFinishMs =
        prevNonCompact.createdAtMs +
        Math.max(0, Number(prevNonCompact.totalDurationSec || 0) * 1000);
      const idleSec =
        st.createdAtMs >= prevFinishMs
          ? Math.max(0, (st.createdAtMs - prevFinishMs) / 1000)
          : Math.max(0, (st.createdAtMs - prevNonCompact.createdAtMs) / 1000);
      if (idleSec < IH_CACHE_TTL_MAX_SEC) {
        if (
          st.cacheReadTokens === 0 &&
          prevNonCompact.cacheReadTokens >= IH_CACHE_ZERO_PREV_MIN &&
          st.inputTokens >= Math.max(10000, prevNonCompact.cacheReadTokens * 0.6)
        ) {
          replicaDrift = {
            kind: 'cold_zero',
            dtSec: Math.round(idleSec),
            lostTokens: prevNonCompact.cacheReadTokens,
          };
        } else if (
          st.cacheReadTokens > 0 &&
          prevNonCompact.cacheReadTokens >= IH_REPLICA_PREV_CACHE_MIN &&
          prevNonCompact.cacheReadTokens - st.cacheReadTokens >= 4096
        ) {
          replicaDrift = {
            kind: 'prefix_rewind',
            dtSec: Math.round(idleSec),
            lostTokens: prevNonCompact.cacheReadTokens - st.cacheReadTokens,
          };
        } else if (
          st.cacheReadTokens > 0 &&
          prevNonCompact.cacheReadTokens >= IH_REPLICA_PREV_CACHE_MIN &&
          st.cacheReadTokens < prevNonCompact.cacheReadTokens * 0.2 &&
          st.inputTokens >= prevNonCompact.cacheReadTokens * 0.65
        ) {
          replicaDrift = {
            kind: 'cold_spill',
            dtSec: Math.round(idleSec),
            lostTokens: Math.max(0, prevNonCompact.cacheReadTokens - st.cacheReadTokens),
          };
        }
      } else if (
        st.cacheReadTokens === 0 &&
        prevNonCompact.cacheReadTokens >= IH_CACHE_ZERO_PREV_MIN
      ) {
        st.cacheZeroReason = 'ttl_expired';
      }
    } else if (st.cacheReadTokens === 0) {
      st.cacheZeroReason = hs.justSwitchedExecPhase
        ? 'phase_switch'
        : prevNonCompact && st.modelKey !== prevNonCompact.modelKey
          ? 'model_switch'
          : 'cold_start';
    }
    if (!replicaDrift && st.cacheReadTokens === 0 && !st.cacheZeroReason) {
      st.cacheZeroReason = prevNonCompact ? 'low_prefix' : 'cold_start';
    }

    let zeroThinking = false;
    let burstUnderthinking = false;
    if (!isWorker && baseline.demonstratesThinking) {
      const qualifiesZeroCheck =
        (hs.isCodeEditStep && st.outputTokens >= 500) ||
        st.outputTokens >= 1200 ||
        ((Boolean(replicaDrift) || upstreamFault) && st.outputTokens >= 600);
      if (
        qualifiesZeroCheck &&
        st.thinkingTokens === 0 &&
        !hs.hasThinkingText &&
        (st.thinkingDurationSec || 0) < 0.35
      ) {
        zeroThinking = true;
      } else if ((hs.isMutationStep || st.outputTokens >= 2400) && st.outputTokens >= 2400) {
        const shareLow =
          baseline.medianThinkShare >= 0.15 &&
          st.thinkingTokens > 0 &&
          st.thinkingTokens / st.outputTokens < Math.min(0.08, baseline.medianThinkShare * 0.3);
        const durLow =
          baseline.medianThinkDurShare >= 0.15 &&
          st.thinkingDurationSec != null &&
          (st.totalDurationSec || 0) >= 10 &&
          st.thinkingDurationSec / st.totalDurationSec <
            Math.min(0.08, baseline.medianThinkDurShare * 0.3);
        const unsplitBurstAfterInfra =
          st.thinkingTokens === 0 &&
          st.outputTokens >= 4500 &&
          (Boolean(replicaDrift) || upstreamFault || (hs.sameRegionReworkCount || 0) >= 2);
        if (shareLow || durLow || unsplitBurstAfterInfra) {
          burstUnderthinking = true;
        }
      }
    }

    const editFaultCount = hs.editFaultCount || 0;
    const toolFaultCount = hs.toolFaultCount || 0;
    const amnesiaReadCount = hs.amnesiaReadCount || 0;
    const sameRegionReworkCount = hs.sameRegionReworkCount || 0;
    const oscillationRevertCount = hs.oscillationRevertCount || 0;
    const thrashingEdits = sameRegionReworkCount >= 3 || oscillationRevertCount >= 2;
    const highRepeat = (hs.outputRepeatRatio || 0) >= 0.55;
    const workerFault = isWorker && (editFaultCount > 0 || toolFaultCount > 0);

    const proofParts = [];
    if (upstreamFault) {
      proofParts.push(
        hs.upstreamErrorText
          ? `上游报错重试 (${hs.upstreamErrorText})`
          : `上游重试 ${hs.retryCount || hs.upstreamErrorCount} 次`
      );
    }
    if (replicaDrift) {
      proofParts.push(
        replicaDrift.kind === 'cold_zero'
          ? `${replicaDrift.dtSec}s 内热缓存清零（丢失 ${ihFormatCompactTok(replicaDrift.lostTokens)} tok）`
          : replicaDrift.kind === 'prefix_rewind'
            ? `${replicaDrift.dtSec}s 内缓存倒退 ${ihFormatCompactTok(replicaDrift.lostTokens)} tok`
            : `${replicaDrift.dtSec}s 内热缓存骤降 ${ihFormatCompactTok(replicaDrift.lostTokens)} tok`
      );
    }
    if (zeroThinking) {
      proofParts.push(`修改/长回复思考缺失 (+${st.outputTokens} tok)`);
    } else if (burstUnderthinking) {
      proofParts.push(`少想狂写 (+${st.outputTokens} tok)`);
    }
    if (editFaultCount > 0) {
      proofParts.push(`编辑原文匹配失败 ${editFaultCount} 次`);
    }
    if (toolFaultCount > 0) {
      proofParts.push(`内联脚本语法崩溃 ${toolFaultCount} 次`);
    }
    if (amnesiaReadCount > 0) {
      proofParts.push(`短窗重复重读未改文件 ${amnesiaReadCount} 次`);
    }
    if (thrashingEdits) {
      proofParts.push(
        oscillationRevertCount >= 2
          ? '同位置代码来回反复回退改写'
          : `同区域代码连续推翻改写 ${sameRegionReworkCount} 次`
      );
    }
    if (highRepeat) {
      proofParts.push(`输出高度复读 (${Math.round((hs.outputRepeatRatio || 0) * 100)}%)`);
    }
    if (workerFault) {
      proofParts.push('轻量执行层工具出错');
    }

    const stepPoints =
      (upstreamFault ? 18 : 0) +
      (replicaDrift ? (replicaDrift.kind === 'cold_zero' ? 24 : 18) : 0) +
      (zeroThinking || burstUnderthinking ? 22 : 0) +
      editFaultCount * 20 +
      toolFaultCount * 16 +
      amnesiaReadCount * 18 +
      (thrashingEdits ? 22 : 0) +
      (highRepeat ? 26 : 0);

    let stepBadge = '';
    if (replicaDrift?.kind === 'cold_zero') stepBadge = '清零';
    else if (replicaDrift) stepBadge = '切流';
    else if (upstreamFault) stepBadge = '超时';
    else if (editFaultCount > 0 || toolFaultCount > 0) stepBadge = '失误';
    else if (thrashingEdits) stepBadge = '返工';
    else if (amnesiaReadCount > 0) stepBadge = '重读';
    else if (zeroThinking || burstUnderthinking) stepBadge = '缩水';
    else if (highRepeat) stepBadge = '复读';

    const stepLevel =
      stepPoints === 0
        ? 'healthy'
        : stepPoints < 25
          ? 'notice'
          : stepPoints < 40
            ? 'warn'
            : 'critical';

    st.stepHealthLevel = stepLevel;
    st.stepHealthBadge = stepBadge;
    st.stepHealthDetail = proofParts.join(' · ');
    st.isCacheAnomaly = Boolean(replicaDrift);

    stepFindingsMap.set(st, {
      upstreamFault,
      replicaDrift,
      zeroThinking,
      burstUnderthinking,
      editFaultCount,
      toolFaultCount,
      amnesiaReadCount,
      thrashingEdits,
      highRepeat,
      workerFault,
      stepPoints,
      proof: proofParts[0] || '',
    });

    prevNonCompact = st;
    prevIsWorker = isWorker;
  }

  // 按轮次（Turn）聚合并计算每轮健康分与处方
  const stepsByTurn = new Map();
  let maxTurnIndex = 0;
  for (const st of steps) {
    const tIdx = st.turnIndex;
    if (!Number.isInteger(tIdx) || tIdx <= 0) {
      st.turnHealthScore = null;
      st.turnHealthLevel = 'healthy';
      continue;
    }
    if (tIdx > maxTurnIndex) maxTurnIndex = tIdx;
    if (!stepsByTurn.has(tIdx)) stepsByTurn.set(tIdx, []);
    stepsByTurn.get(tIdx).push(st);
  }

  const turnDiagnoses = [];
  const diagnosisByTurn = new Map();
  for (const [tIdx, tSteps] of stepsByTurn.entries()) {
    const diag = ihBuildTurnDiagnosis({
      turnIndex: tIdx,
      turnSteps: tSteps,
      stepFindingsMap,
      agentId,
      agentBadge,
    });
    turnDiagnoses.push(diag);
    diagnosisByTurn.set(tIdx, diag);
    for (const st of tSteps) {
      st.turnHealthScore = diag.score;
      st.turnHealthLevel = diag.level;
      if (diag.level === 'warn' || diag.level === 'critical') {
        const sf = stepFindingsMap.get(st);
        if (
          sf &&
          (sf.stepPoints >= 18 ||
            (st.healthSignals?.confirmedRollback && st.stepIndex === diag.anchorStepIndex))
        ) {
          if (st.stepHealthLevel === 'healthy' || st.stepHealthLevel === 'notice') {
            st.stepHealthLevel = 'warn';
          }
          if (!st.stepHealthBadge && st.healthSignals?.confirmedRollback) {
            st.stepHealthBadge = '回滚';
          }
        }
      }
    }
  }

  let anomalyStepCount = 0;
  for (const st of steps) {
    if (st.stepHealthLevel === 'warn' || st.stepHealthLevel === 'critical') {
      anomalyStepCount += 1;
    }
  }
  const anomalyTurns = turnDiagnoses.filter((d) => d.level === 'warn' || d.level === 'critical');
  const latestDiag = maxTurnIndex > 0 ? diagnosisByTurn.get(maxTurnIndex) : null;
  const activeAlert =
    latestDiag && (latestDiag.level === 'warn' || latestDiag.level === 'critical')
      ? latestDiag
      : null;

  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < turnDiagnoses.length; i++) {
    const w = Math.pow(0.82, turnDiagnoses.length - 1 - i);
    weightedSum += turnDiagnoses[i].score * w;
    weightTotal += w;
  }
  const sessionScore = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 100;

  return {
    sessionScore,
    anomalyStepCount,
    anomalyTurnCount: anomalyTurns.length,
    activeAlert,
    turnDiagnoses,
  };
}

/**
 * 在多子代理（`All`）视图下合并主代理与所有子代理的健康诊断状态。
 */
export function mergeAggregatedInferenceHealth(
  mainHealth,
  subAgentTelemetries = [],
  combinedSteps = []
) {
  const rootDiagByTurn = new Map();
  if (mainHealth?.turnDiagnoses) {
    for (const d of mainHealth.turnDiagnoses) {
      rootDiagByTurn.set(d.turnIndex, d);
    }
  }

  for (const st of combinedSteps) {
    const rt = st.rootTurnIndex;
    const diag = Number.isInteger(rt) && rt > 0 ? rootDiagByTurn.get(rt) : null;
    if (diag) {
      st.rootTurnHealthScore = diag.score;
      st.rootTurnHealthLevel = diag.level;
    }
  }

  let anomalyStepCount = 0;
  for (const st of combinedSteps) {
    if (st.stepHealthLevel === 'warn' || st.stepHealthLevel === 'critical') {
      anomalyStepCount += 1;
    }
  }

  let activeAlert = mainHealth?.activeAlert || null;
  if (!activeAlert) {
    const subAlerts = subAgentTelemetries
      .filter((s) => s?.inferenceHealth?.activeAlert)
      .sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0));
    if (subAlerts.length > 0) {
      const sub = subAlerts[0];
      const subAlert = sub.inferenceHealth.activeAlert;
      activeAlert = {
        ...subAlert,
        title: `[${sub.badgeText || '子'}] ${subAlert.title}`,
        agentId: sub.agentId,
        agentBadge: sub.badgeText,
      };
    }
  }

  const turnDiagnoses = mainHealth?.turnDiagnoses || [];
  const anomalyTurnCount = turnDiagnoses.filter(
    (d) => d.level === 'warn' || d.level === 'critical'
  ).length;
  const sessionScore = mainHealth?.sessionScore ?? 100;

  return {
    sessionScore,
    anomalyStepCount,
    anomalyTurnCount,
    activeAlert,
    turnDiagnoses,
  };
}
