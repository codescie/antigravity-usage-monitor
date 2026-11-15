/**
 * @fileoverview View 3: StepsDetailView (步骤明细与按模型汇总视图).
 * 提供“单步测速”与“按模型汇总”双子表切换：
 * - 采用 `patchKeyedList` 实现行级 DOM 增量对账与就地复用，彻底避免全表 `innerHTML` 重建引发的闪烁；
 * - 两个表格各自包裹在独立的 `CustomScrollbar` 容器中，兼具粘性表头与零原生滚动条体验；
 * - 支持在内部代号 (`modelShort`) 与实际响应模型名 (`modelUpstream`) 之间无缝切换显示。
 */

import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../core/domPatch.js';
import {
  buildModelTtftBaselines,
  classifyStepTtft,
  copyWithTimedFeedback,
  formatMetric,
  formatStepDuration,
  formatStepDurationDetail,
  formatStepTtftDetail,
  formatTokens,
  formatUsd,
  normalizeOrchestratorIdDisplayMode,
  resolveModelDisplayInfo,
  sampleSummary,
  speedReasonText,
  splitModelHeadTail,
} from '../core/formatters.js';
import { createSvgIcon, patchSvgIcon } from '../icons/SvgIcon.js';
import {
  formatAgentLabel,
  getAgentBadgeClass,
  resolveScopedConversation,
  telemetryStore,
} from '../store/telemetryStore.js';
import { uiStore } from '../store/uiStore.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { CustomSelect } from '../components/ui/CustomSelect.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';

export const StepsDetailView = defineComponent({
  name: 'StepsDetailView',
  setup({ onCleanup }) {
    // 方案 B：明细面板标题栏内嵌代理筛选下拉框（与顶栏代理切换条双向同步）
    const inlineScopeSelect = CustomSelect({
      modelValue: uiStore.getState().selectedAgentScope,
      icon: 'layers',
      placeholder: '全部代理',
      className: 'steps-inline-scope-select',
      options: [{ value: 'all', label: '全部代理' }],
      onUpdateModelValue: (nextScope) => {
        if (nextScope) {
          uiStore.setState({
            selectedAgentScope: nextScope,
            ...(nextScope === 'all' ? { ctxInspectorAgentId: 'auto' } : {}),
          });
        }
      },
    });
    inlineScopeSelect.el.setAttribute('hidden', '');

    // 顶部子表分段切换器：在“按步查看”与“按模型汇总”之间切换
    const subTabSwitch = SegmentedControl({
      ariaLabel: '明细表视图切换',
      modelValue: uiStore.getState().stepsSubTab,
      options: [
        { value: 'steps', label: '按步查看 (0)' },
        { value: 'models', label: '按模型汇总' },
      ],
      onUpdateModelValue: (nextTab) => {
        uiStore.setState({ stepsSubTab: nextTab });
      },
    });

    // --- 子表 1：单步明细表（列定义：步序、模型、吞吐速度、首字延迟、单步耗时、上下文/输出、缓存命中率、单步费用） ---
    const stepsTbody = h('tbody');
    const stepsTableEl = h('table', { className: 'data-table steps-data-table' }, [
      h('thead', {}, [
        h('tr', {}, [
          h('th', { className: 'step-col-head', text: '步序' }),
          h('th', { className: 'col-model', text: '模型' }),
          h('th', { className: 'col-speed', text: '速度' }),
          h('th', { className: 'col-ttft', title: '首 Token 耗时 (TTFT)', text: '首字' }),
          h('th', { className: 'col-dur', title: '单步总耗时', text: '耗时' }),
          h('th', { className: 'col-ctx', text: '上下文 / 输出' }),
          h('th', { className: 'col-cache', text: '缓存' }),
          h('th', { className: 'col-cost', text: '费用' }),
        ]),
      ]),
      stepsTbody,
    ]);
    const stepsTablePane = h('div', { className: 'table-viewport' }, [stepsTableEl]);
    const stepsScroll = CustomScrollbar({
      contentEl: stepsTablePane,
      className: 'table-scroll-host',
    });

    const tipBadgeEl = h('span', { className: 'turn-tip-badge', text: '' });
    const tipScoreEl = h('span', { className: 'turn-tip-score text-mono', text: '' });
    const tipHeadEl = h('div', { className: 'turn-tip-head', hidden: true }, [
      tipBadgeEl,
      tipScoreEl,
    ]);
    const tipPromptEl = h('div', { className: 'turn-tip-prompt', text: '' });
    const tipReasonEl = h('div', { className: 'turn-tip-reason text-mono', hidden: true, text: '' });
    const tipCopyIcon = createSvgIcon('copy', { size: 11 });
    const tipCopyLabel = h('span', { text: '' });
    let activeTipCopyAction = null;
    const tipCopyBtn = h(
      'button',
      {
        type: 'button',
        className: 'turn-tip-copy-btn',
        onClick: async (e) => {
          e?.stopPropagation?.();
          if (!activeTipCopyAction) return;
          const act = activeTipCopyAction;
          await copyWithTimedFeedback(act.copyText, tipCopyTimer, (copied) => {
            patchSvgIcon(tipCopyIcon, copied ? 'check' : 'copy');
            patchText(tipCopyLabel, copied ? act.toast || '已复制' : act.label);
            patchClasses(tipCopyBtn, { 'is-copied': copied });
          });
        },
      },
      [tipCopyIcon, tipCopyLabel]
    );
    const tipActionRowEl = h('div', { className: 'turn-tip-actions', hidden: true }, [tipCopyBtn]);

    const turnTipEl = h(
      'div',
      {
        className: 'turn-prompt-tip',
        role: 'tooltip',
        hidden: true,
      },
      [tipHeadEl, tipPromptEl, tipReasonEl, tipActionRowEl]
    );

    let tipHideTimer = null;
    let tipSwitchTimer = null;
    const tipCopyTimer = { id: null };
    let flashRowTimer = null;
    let lastHandledTargetSeq = 0;
    let lastObservedCascadeId = '';
    let isPointerInsideTip = false;
    let currentTipRowKey = '';
    let pinnedTipRowKey = '';

    const cancelHideTurnTip = () => {
      if (tipHideTimer) {
        clearTimeout(tipHideTimer);
        tipHideTimer = null;
      }
    };
    const cancelSwitchTurnTip = () => {
      if (tipSwitchTimer) {
        clearTimeout(tipSwitchTimer);
        tipSwitchTimer = null;
      }
    };
    const hideTurnTip = (force = false) => {
      if (!force && (isPointerInsideTip || pinnedTipRowKey)) return;
      cancelHideTurnTip();
      cancelSwitchTurnTip();
      currentTipRowKey = '';
      pinnedTipRowKey = '';
      isPointerInsideTip = false;
      patchAttr(turnTipEl, 'hidden', true);
    };
    const scheduleHideTurnTip = () => {
      cancelHideTurnTip();
      tipHideTimer = setTimeout(() => {
        tipHideTimer = null;
        if (!isPointerInsideTip && !pinnedTipRowKey) {
          hideTurnTip(true);
        }
      }, 260);
    };

    turnTipEl.onmouseenter = () => {
      isPointerInsideTip = true;
      cancelHideTurnTip();
      cancelSwitchTurnTip();
    };
    turnTipEl.onmouseleave = () => {
      isPointerInsideTip = false;
      if (!pinnedTipRowKey) {
        scheduleHideTurnTip();
      }
    };

    function requestShowTurnTip(anchorCell, item, { pin = false } = {}) {
      cancelHideTurnTip();
      cancelSwitchTurnTip();
      if (!item) return;
      if (pin) {
        const tipVisible = !turnTipEl.hasAttribute('hidden');
        if (pinnedTipRowKey === item.rowKey && tipVisible) {
          pinnedTipRowKey = '';
          hideTurnTip(true);
          return;
        }
        pinnedTipRowKey = item.rowKey;
        showTurnTip(anchorCell, item);
        return;
      }
      if (pinnedTipRowKey) return;
      const tipVisible = !turnTipEl.hasAttribute('hidden');
      if (tipVisible && currentTipRowKey && currentTipRowKey !== item.rowKey) {
        tipSwitchTimer = setTimeout(() => {
          tipSwitchTimer = null;
          if (!isPointerInsideTip && !pinnedTipRowKey) {
            showTurnTip(anchorCell, item);
          }
        }, 150);
        return;
      }
      showTurnTip(anchorCell, item);
    }

    function showTurnTip(anchorCell, item) {
      cancelHideTurnTip();
      const promptText = String(item?.prompt || '').trim();
      const st = item?.st || {};
      const diag = item?.turnDiag || null;
      const isAnomalousStep =
        st.stepHealthLevel === 'warn' ||
        st.stepHealthLevel === 'critical' ||
        Boolean(st.isCacheAnomaly);
      const isAnomalousTurn =
        diag && (diag.level === 'warn' || diag.level === 'critical');
      const reasonText =
        st.stepHealthDetail || (isAnomalousTurn && diag.reasons?.join(' · ')) || '';

      if (!anchorCell || (!promptText && !isAnomalousStep && !isAnomalousTurn && !reasonText)) {
        hideTurnTip(true);
        return;
      }

      const showHead = Boolean(isAnomalousStep || isAnomalousTurn);
      patchAttr(tipHeadEl, 'hidden', !showHead);
      if (showHead) {
        const badgeTxt =
          st.stepHealthBadge || diag?.badge || (isAnomalousTurn ? '异常轮次' : '异常步骤');
        const scoreVal = item?.turnScore ?? diag?.score;
        const isCritical = st.stepHealthLevel === 'critical' || diag?.level === 'critical';
        patchClasses(tipHeadEl, { 'is-critical': isCritical });
        patchText(tipBadgeEl, badgeTxt);
        patchText(tipScoreEl, scoreVal != null ? `健康 ${scoreVal}` : '');
      }

      patchAttr(tipPromptEl, 'hidden', !promptText);
      patchText(tipPromptEl, promptText);

      patchAttr(tipReasonEl, 'hidden', !reasonText);
      patchText(tipReasonEl, reasonText);

      let copyAction = null;
      if (isAnomalousStep) {
        if (diag?.category === 'context_rot' && diag?.primaryAction?.kind === 'copy') {
          copyAction = diag.primaryAction;
        } else if (
          diag?.primaryAction?.kind === 'copy' &&
          Number(diag.anchorStepIndex) === Number(st.stepIndex)
        ) {
          copyAction = diag.primaryAction;
        } else if (
          (st.stepHealthBadge === '清零' || st.stepHealthBadge === '切流') &&
          st.stepHealthLevel !== 'critical'
        ) {
          copyAction = {
            kind: 'copy',
            label: '复制稳态续写提示',
            copyText:
              '请继续当前任务，修改同一文件时尽量合并相邻块以降低重复预填充开销。',
            toast: '已复制提示',
          };
        } else if (st.stepHealthBadge === '缩水' && st.stepHealthLevel !== 'critical') {
          copyAction = {
            kind: 'copy',
            label: `复制 #${st.stepIndex} 核验指令`,
            copyText: `请复核 #${st.stepIndex} 步的修改边界与潜在遗漏，运行测试确认无误后再继续。`,
            toast: '已复制核验指令',
          };
        } else {
          copyAction = {
            kind: 'copy',
            label: `复制 #${st.stepIndex} 回退指令`,
            copyText: `我需要打断当前做法：从 #${st.stepIndex} 步开始出现异常（${reasonText || st.stepHealthBadge}），请先回退或核对 #${st.stepIndex} 之前的正确状态，再按原目标重新执行。`,
            toast: '已复制回退指令',
          };
        }
      } else if (isAnomalousTurn) {
        if (diag?.primaryAction?.kind === 'copy') {
          copyAction = diag.primaryAction;
        } else if (diag?.secondaryAction?.kind === 'copy') {
          copyAction = diag.secondaryAction;
        }
      }

      patchAttr(tipActionRowEl, 'hidden', !copyAction);
      activeTipCopyAction = copyAction || null;
      if (copyAction) {
        patchSvgIcon(tipCopyIcon, 'copy');
        patchText(tipCopyLabel, copyAction.label);
        patchClasses(tipCopyBtn, { 'is-copied': false });
      }

      currentTipRowKey = item?.rowKey || '';
      patchAttr(turnTipEl, 'hidden', false);
      if (
        typeof panelEl.getBoundingClientRect === 'function' &&
        typeof anchorCell.getBoundingClientRect === 'function'
      ) {
        const panelRect = panelEl.getBoundingClientRect();
        const cellRect = anchorCell.getBoundingClientRect();
        if (panelRect.width > 0 && panelRect.height > 0) {
          const tipH = turnTipEl.offsetHeight || 56;
          const placeAbove =
            panelRect.bottom - cellRect.bottom < tipH + 12 &&
            cellRect.top - panelRect.top > tipH + 6;
          const rawTopPx = placeAbove
            ? Math.round(cellRect.top - panelRect.top - tipH + 1)
            : Math.round(cellRect.bottom - panelRect.top - 1);
          const maxTopPx = Math.max(4, Math.round(panelRect.height - tipH - 6));
          const topPx = Math.min(Math.max(4, rawTopPx), maxTopPx);
          const leftPx = Math.max(6, Math.round(cellRect.left - panelRect.left + 4));
          turnTipEl.style.top = `${topPx}px`;
          turnTipEl.style.left = `${leftPx}px`;
        }
      }
    }

    const anomalyFilterLabel = h('span', { text: '异常 (0)' });
    const anomalyFilterBtn = h(
      'button',
      {
        type: 'button',
        className: 'steps-anomaly-filter-btn',
        hidden: true,
        title: '只看存在推理或执行异常的步骤',
        onClick: () => {
          uiStore.setState({ stepsOnlyAnomalies: !uiStore.getState().stepsOnlyAnomalies });
        },
      },
      [createSvgIcon('warning', { size: 11 }), anomalyFilterLabel]
    );

    // --- 子表 2：按模型汇总表（列定义：模型名称、调用次数、有效均速、总 Token、费用） ---
    const modelsTbody = h('tbody');
    const modelsTablePane = h('div', { className: 'table-viewport' }, [
      h('table', { className: 'data-table models-data-table' }, [
        h('thead', {}, [
          h('tr', {}, [
            h('th', { className: 'col-model', text: '模型' }),
            h('th', { text: '次数' }),
            h('th', { text: '均速' }),
            h('th', { text: '总 Token' }),
            h('th', { text: '费用' }),
          ]),
        ]),
        modelsTbody,
      ]),
    ]);
    const modelsScroll = CustomScrollbar({
      contentEl: modelsTablePane,
      className: 'table-scroll-host',
    });
    modelsScroll.el.setAttribute('hidden', '');

    const panelEl = h(
      'section',
      {
        className: 'panel',
        style: 'flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative;',
      },
      [
        h('div', { className: 'panel-header steps-panel-header' }, [
          h('span', { className: 'panel-title steps-panel-title' }, [
            createSvgIcon('table', { size: 13 }),
            h('span', { text: '调用记录' }),
            anomalyFilterBtn,
          ]),
          h('div', { className: 'steps-header-controls' }, [
            inlineScopeSelect.el,
            subTabSwitch.el,
          ]),
        ]),
        stepsScroll.el,
        modelsScroll.el,
        turnTipEl,
      ]
    );
    const onStepsPaneScroll = () => hideTurnTip(true);
    const onPanelClick = (ev) => {
      if (!pinnedTipRowKey) return;
      if (turnTipEl.contains?.(ev?.target)) return;
      hideTurnTip(true);
    };
    stepsTablePane.addEventListener('scroll', onStepsPaneScroll);
    stepsTbody.addEventListener('mouseleave', scheduleHideTurnTip);
    panelEl.addEventListener('click', onPanelClick);

    const rootEl = h('div', { className: 'view-pane' }, [panelEl]);

    const unsubUi = uiStore.subscribe(
      (st) => st.stepsSubTab,
      (tab) => {
        hideTurnTip(true);
        subTabSwitch.setValue(tab);
        patchAttr(stepsScroll.el, 'hidden', tab !== 'steps');
        patchAttr(modelsScroll.el, 'hidden', tab !== 'models');
        if (tab === 'steps') stepsScroll.refresh();
        else modelsScroll.refresh();
      }
    );

    let latestSlice = null;
    let isDirty = false;

    /**
     * 对单步测速表和按模型汇总表执行基于 `patchKeyedList` 的键值增量对账与行更新。
     */
    function renderStepsData(slice) {
      if (!slice) return;
      const uiSt = uiStore.getState();
      const {
        hasSubagents,
        effectiveScope,
        subagents,
        mainAgent,
        aggregated,
        scopedConv,
      } = resolveScopedConversation(
        { activeConversation: slice.activeConversation },
        uiSt.selectedAgentScope,
        uiSt.ctxInspectorAgentId
      );

      patchAttr(inlineScopeSelect.el, 'hidden', !hasSubagents);
      if (hasSubagents) {
        const scopeOpts = [
          {
            value: 'all',
            label: '全部汇总',
            meta: `${aggregated?.stepCount ?? 0}步`,
          },
          {
            value: 'main',
            label: '主代理',
            meta: `${mainAgent?.stepCount ?? 0}步`,
          },
          ...subagents.map((s) => ({
            value: s.agentId,
            label: formatAgentLabel(s),
            meta: `${s.stepCount || 0}步`,
          })),
        ];
        inlineScopeSelect.setProps({
          modelValue: effectiveScope,
          options: scopeOpts,
        });
      } else {
        inlineScopeSelect.close();
      }

      const rawSteps =
        (hasSubagents ? scopedConv?.recentSteps : slice.recentSteps) ||
        slice.recentSteps ||
        [];
      const curCid = slice.cascadeId || '';
      if (curCid && curCid !== lastObservedCascadeId) {
        if (lastObservedCascadeId && uiSt.stepsOnlyAnomalies) {
          uiStore.setState({ stepsOnlyAnomalies: false });
        }
        lastObservedCascadeId = curCid;
      }

      const healthDiagList =
        (hasSubagents && effectiveScope === 'all'
          ? aggregated?.inferenceHealth?.turnDiagnoses
          : scopedConv?.inferenceHealth?.turnDiagnoses) ||
        slice.activeConversation?.inferenceHealth?.turnDiagnoses ||
        [];
      const diagByTurnMap = new Map(healthDiagList.map((d) => [d.turnIndex, d]));

      const isStepAnomalous = (st) =>
        Boolean(
          st?.stepHealthLevel === 'warn' ||
            st?.stepHealthLevel === 'critical' ||
            st?.isCacheAnomaly
        );
      const anomalyCount = rawSteps.filter(isStepAnomalous).length;
      const onlyAnomalies = Boolean(uiStore.getState().stepsOnlyAnomalies);
      if (anomalyCount === 0 && onlyAnomalies) {
        uiStore.setState({ stepsOnlyAnomalies: false });
      }
      const effectiveOnlyAnomalies = Boolean(uiStore.getState().stepsOnlyAnomalies && anomalyCount > 0);
      patchAttr(anomalyFilterBtn, 'hidden', anomalyCount === 0 && !effectiveOnlyAnomalies);
      patchClasses(anomalyFilterBtn, { 'is-active': effectiveOnlyAnomalies });
      patchText(anomalyFilterLabel, `异常 (${anomalyCount})`);

      const steps = effectiveOnlyAnomalies ? rawSteps.filter(isStepAnomalous) : rawSteps;
      const ttftBaselines = buildModelTtftBaselines(rawSteps);

      const models =
        (Array.isArray(scopedConv?.modelBreakdown) && scopedConv.modelBreakdown.length > 0
          ? scopedConv.modelBreakdown
          : slice.sessionModelBreakdown || slice.modelBreakdown) || [];
      const displaySettings = {
        showUpstreamModel: Boolean(slice.showUpstreamModel),
        orchestratorIdMode: slice.orchestratorIdMode,
      };
      const modelsTabBadge = hasSubagents
        ? effectiveScope === 'all'
          ? '本会话汇总'
          : scopedConv?.shortLabel || '当前代理'
        : '本会话';

      subTabSwitch.setProps({
        options: [
          {
            value: 'steps',
            label: effectiveOnlyAnomalies
              ? `异常步骤 (${steps.length}/${rawSteps.length})`
              : `按步查看 (${rawSteps.length})`,
          },
          { value: 'models', label: '按模型汇总' },
        ],
      });

      const useRootTurn = Boolean(hasSubagents && effectiveScope === 'all');
      const getStepTurnIdx = (st) =>
        useRootTurn ? (st?.rootTurnIndex ?? st?.turnIndex) : st?.turnIndex;
      const getStepIsStart = (st) =>
        Boolean(useRootTurn ? (st?.isRootTurnStart ?? st?.isTurnStart) : st?.isTurnStart);
      const getStepIsLatest = (st) =>
        Boolean(useRootTurn ? (st?.isRootLatestTurn ?? st?.isLatestTurn) : st?.isLatestTurn);
      const getStepPrompt = (st) =>
        (useRootTurn ? (st?.rootTurnPrompt ?? st?.turnPrompt) : st?.turnPrompt) || '';
      const turnKeyOf = (st) => {
        const tIdx = getStepTurnIdx(st);
        if (!Number.isInteger(tIdx) || tIdx <= 0) return '';
        return useRootTurn ? `root:${tIdx}` : `${st.agentId || 'main'}:${tIdx}`;
      };
      const decoratedSteps = steps.map((st, idx) => {
        const tKey = turnKeyOf(st);
        const tIdx = getStepTurnIdx(st);
        const hasUp = Boolean(tKey && idx > 0 && turnKeyOf(steps[idx - 1]) === tKey);
        const hasDown = Boolean(
          tKey && idx + 1 < steps.length && turnKeyOf(steps[idx + 1]) === tKey
        );
        const turnDiag = Number.isInteger(tIdx) && tIdx > 0 ? diagByTurnMap.get(tIdx) || null : null;
        const turnLevel = useRootTurn
          ? st?.rootTurnHealthLevel || turnDiag?.level || st?.turnHealthLevel || 'healthy'
          : st?.turnHealthLevel || turnDiag?.level || 'healthy';
        const turnScore = useRootTurn
          ? st?.rootTurnHealthScore ?? turnDiag?.score ?? st?.turnHealthScore ?? null
          : st?.turnHealthScore ?? turnDiag?.score ?? null;
        const ttftInfo = classifyStepTtft(st, ttftBaselines);
        return {
          st,
          rowKey: `${st.agentCascadeId || slice.cascadeId || 'conv'}-${st.stepIndex}`,
          hasTurn: Boolean(tKey),
          hasUp,
          hasDown,
          isStart: getStepIsStart(st),
          isLatest: getStepIsLatest(st),
          prompt: getStepPrompt(st),
          turnDiag,
          turnLevel,
          turnScore,
          ttftInfo,
        };
      });

      patchClasses(stepsTableEl, { 'has-subagents': hasSubagents });

      // 1. 单步测速表增量对账：以 `<agentCascadeId>-<stepIndex>` 为稳定行键，仅在签名变化时刷新单元格
      patchKeyedList(stepsTbody, decoratedSteps, {
        keyFn: (item) => item.rowKey,
        sigFn: (item) => {
          const { st, ttftInfo } = item;
          const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: '—' });
          const medSig = ttftInfo?.medianSec != null ? Math.round(ttftInfo.medianSec * 10) : -1;
          return `${hasSubagents}:${effectiveScope}:${st.agentId || 'main'}:${st.stepIndex}:${disp.text}:${disp.title}:${st.tokPerSec}:${st.ttftSec}:${ttftInfo?.isSlow ? 1 : 0}:${ttftInfo?.isStall ? 1 : 0}:${medSig}:${st.totalDurationSec}:${st.thinkingDurationSec}:${st.nativeStreamSec}:${st.isComplete}:${st.contextTokens}:${st.outputTokens}:${st.cacheHitPct}:${st.costUsd}:${st.selectedSpeedReason}:${st.stepHealthLevel || ''}:${st.stepHealthBadge || ''}:${st.isCacheAnomaly ? 1 : 0}:${item.turnLevel}:${item.turnScore ?? ''}:${item.hasTurn}:${item.hasUp}:${item.hasDown}:${item.isStart}:${item.isLatest}:${item.prompt}`;
        },
        createRow: () => {
          const railLineEl = h('span', { className: 'turn-rail-line', hidden: true });
          const railDotEl = h('span', { className: 'turn-rail-dot', hidden: true });
          const railEl = h(
            'span',
            { className: 'turn-rail', 'aria-hidden': 'true', hidden: true },
            [railLineEl, railDotEl]
          );
          const agentBadgeEl = h('span', {
            className: 'agent-badge is-clickable',
            hidden: true,
            style: 'margin-right: 3px;',
          });
          const stepNumText = h('span', { className: 'step-num-text' });
          const tdStep = h('td', { className: 'step-cell' }, [
            railEl,
            agentBadgeEl,
            stepNumText,
          ]);

          const stepHealthTagEl = h('span', { className: 'step-health-tag', hidden: true });
          const modelHeadEl = h('span', { className: 'model-name-head' });
          const modelTailEl = h('span', { className: 'model-name-tail' });
          const modelNameEl = h('span', { className: 'model-cell-name' }, [
            modelHeadEl,
            modelTailEl,
          ]);
          const modelInnerEl = h('div', { className: 'model-cell-inner' }, [
            stepHealthTagEl,
            modelNameEl,
          ]);
          const tdModel = h('td', { className: 'col-model model-cell' }, [modelInnerEl]);
          const speedMain = h('strong', {
            className: 'cell-value accent-speed',
            style: 'font-size: 11px;',
          });
          const speedReason = h('div', { className: 'text-muted', style: 'font-size: 9.5px;' });
          const tdSpeed = h('td', { className: 'col-speed' }, [speedMain, speedReason]);

          const ttftValEl = h('span', { className: 'ttft-val' });
          const tdTtft = h('td', { className: 'col-ttft' }, [ttftValEl]);
          const durMain = h('span', { className: 'dur-main cell-value' });
          const tdDur = h('td', { className: 'col-dur' }, [durMain]);
          const tdCtx = h('td', { className: 'col-ctx' });
          const tdCache = h('td', {
            className: 'col-cache cell-value accent-ok',
            style: 'font-size: 11px;',
          });
          const tdCost = h('td', { className: 'col-cost', style: 'font-weight: 600;' });

          const tr = h('tr', {}, [tdStep, tdModel, tdSpeed, tdTtft, tdDur, tdCtx, tdCache, tdCost]);
          return {
            el: tr,
            refs: {
              tr,
              tdStep,
              railEl,
              railLineEl,
              railDotEl,
              agentBadgeEl,
              stepNumText,
              stepHealthTagEl,
              tdModel,
              modelNameEl,
              modelHeadEl,
              modelTailEl,
              tdSpeed,
              speedMain,
              speedReason,
              tdTtft,
              ttftValEl,
              tdDur,
              durMain,
              tdCtx,
              tdCache,
              tdCost,
            },
          };
        },
        updateRow: (refs, item) => {
          const { st, hasTurn, hasUp, hasDown, isStart, isLatest, prompt, turnLevel } = item;
          patchAttr(refs.tr, 'data-step-index', String(Number(st.stepIndex)));
          patchAttr(refs.tr, 'data-agent-id', st.agentId || 'main');
          patchClasses(refs.tr, {
            'is-row-warn': st.stepHealthLevel === 'warn',
            'is-row-critical': st.stepHealthLevel === 'critical',
          });

          const isStepAnom = st.stepHealthLevel === 'warn' || st.stepHealthLevel === 'critical';
          const stepAnomalyDot = !isStart && isStepAnom;

          patchAttr(refs.railEl, 'hidden', !hasTurn);
          if (hasTurn) {
            patchClasses(refs.railEl, {
              'is-latest': isLatest,
              'has-up': hasUp,
              'has-down': hasDown,
            });
            patchAttr(refs.railLineEl, 'hidden', !hasUp && !hasDown);
            const showOrigin = isStart;
            const showCap = !showOrigin && !hasUp && hasDown && !stepAnomalyDot;
            const dotCrit =
              (stepAnomalyDot && st.stepHealthLevel === 'critical') ||
              (showOrigin && (st.stepHealthLevel === 'critical' || turnLevel === 'critical'));
            const dotWarn =
              !dotCrit &&
              ((stepAnomalyDot && st.stepHealthLevel === 'warn') ||
                (showOrigin && (st.stepHealthLevel === 'warn' || turnLevel === 'warn')));
            patchAttr(refs.railDotEl, 'hidden', !showOrigin && !showCap && !stepAnomalyDot);
            patchClasses(refs.railDotEl, {
              'is-origin': showOrigin,
              'is-cap': showCap,
              'is-anomaly-dot': stepAnomalyDot,
              'is-warn': dotWarn,
              'is-critical': dotCrit,
            });
          }

          refs.tdStep.onmouseenter = (ev) => {
            if (ev?.target === refs.agentBadgeEl) {
              hideTurnTip(true);
              return;
            }
            requestShowTurnTip(refs.tdStep, item);
          };
          refs.tdStep.onmouseleave = scheduleHideTurnTip;
          refs.tdStep.onclick = (ev) => {
            if (ev?.target === refs.agentBadgeEl) return;
            ev?.stopPropagation?.();
            requestShowTurnTip(refs.tdStep, item, { pin: true });
          };

          patchAttr(refs.agentBadgeEl, 'hidden', !hasSubagents);
          if (hasSubagents) {
            const badgeCls = getAgentBadgeClass(st.agentIndex || 0, !st.isSubagent);
            patchAttr(refs.agentBadgeEl, 'class', `agent-badge is-clickable ${badgeCls}`);
            patchText(refs.agentBadgeEl, st.agentBadge || (st.isSubagent ? '子' : '主'));
            patchAttr(
              refs.agentBadgeEl,
              'title',
              effectiveScope === 'all'
                ? `点击仅过滤查看 ${st.agentLabel || '该代理'}`
                : '点击切回全部汇总'
            );
            refs.agentBadgeEl.onclick = () => {
              const targetScope = st.agentId || 'main';
              const nextScope = effectiveScope === targetScope ? 'all' : targetScope;
              uiStore.setState({
                selectedAgentScope: nextScope,
                ...(nextScope === 'all' ? { ctxInspectorAgentId: 'auto' } : {}),
              });
            };
          }
          patchText(refs.stepNumText, `#${Number(st.stepIndex)}`);
          patchClasses(refs.stepNumText, {
            'is-warn': st.stepHealthLevel === 'warn',
            'is-critical': st.stepHealthLevel === 'critical',
          });
          const showBadgeTag =
            Boolean(st.stepHealthBadge) &&
            (st.stepHealthLevel === 'warn' ||
              st.stepHealthLevel === 'critical' ||
              Boolean(st.isCacheAnomaly));
          patchAttr(refs.stepHealthTagEl, 'hidden', !showBadgeTag);
          if (showBadgeTag) {
            patchText(refs.stepHealthTagEl, st.stepHealthBadge);
            patchClasses(refs.stepHealthTagEl, {
              'is-critical': st.stepHealthLevel === 'critical',
            });
          }

          const modelDisplay = resolveModelDisplayInfo(st, displaySettings, { fallback: '—' });
          const { head: modelHead, tail: modelTail } = splitModelHeadTail(modelDisplay.text);
          patchText(refs.modelHeadEl, modelHead);
          patchText(refs.modelTailEl, modelTail);
          patchAttr(
            refs.tdModel,
            'title',
            st.stepHealthDetail
              ? `${modelDisplay.title} · ${st.stepHealthDetail}`
              : modelDisplay.title
          );
          if (showBadgeTag) {
            refs.tdModel.onmouseenter = () => requestShowTurnTip(refs.tdStep, item);
            refs.tdModel.onmouseleave = scheduleHideTurnTip;
            refs.tdModel.onclick = (ev) => {
              ev?.stopPropagation?.();
              requestShowTurnTip(refs.tdStep, item, { pin: true });
            };
          } else {
            refs.tdModel.onmouseenter = null;
            refs.tdModel.onmouseleave = null;
            refs.tdModel.onclick = null;
          }

          patchText(refs.speedMain, formatMetric(st.tokPerSec, ' t/s'));
          patchAttr(
            refs.tdSpeed,
            'title',
            Number.isFinite(st.tokPerSec) ? `输出吞吐 ${st.tokPerSec.toFixed(1)} tokens/s` : false
          );
          const reason = speedReasonText(st.selectedSpeedReason);
          patchText(refs.speedReason, reason);
          patchAttr(refs.speedReason, 'hidden', !reason);

          const ttftInfo = item.ttftInfo || classifyStepTtft(st);
          const hasTtft = ttftInfo.hasTtft;
          const isTtftSlow = ttftInfo.isSlow;
          const isTtftStall = ttftInfo.isStall;
          patchText(refs.ttftValEl, formatMetric(st.ttftSec, 's'));
          patchClasses(refs.ttftValEl, {
            'text-muted': !hasTtft,
            'is-ttft-slow': isTtftSlow,
            'is-ttft-stall': isTtftStall,
          });
          patchClasses(refs.tdTtft, {
            'is-ttft-slow': isTtftSlow,
            'is-ttft-stall': isTtftStall,
          });
          patchAttr(refs.tdTtft, 'title', formatStepTtftDetail(st, ttftInfo));
          patchText(refs.durMain, formatStepDuration(st.totalDurationSec));
          patchAttr(refs.tdDur, 'title', formatStepDurationDetail(st));
          const outNum = Number(st.outputTokens || 0);
          const outCompact = outNum >= 10000 ? formatTokens(outNum) : String(outNum);
          const ctxStr = `${formatTokens(st.contextTokens)}/+${outCompact}`;
          patchText(refs.tdCtx, ctxStr);
          patchAttr(
            refs.tdCtx,
            'title',
            `上下文 ${formatTokens(st.contextTokens)} · 输出 +${Number(st.outputTokens || 0)} · 缓存 ${Number(st.cacheHitPct ?? 0)}%${st.stepHealthDetail ? ` · ${st.stepHealthDetail}` : ''}`
          );
          const cachePctNum = Number(st.cacheHitPct ?? 0);
          const isZeroCacheAnom = Boolean(st.isCacheAnomaly && cachePctNum === 0);
          patchText(refs.tdCache, `${cachePctNum}%`);
          patchClasses(refs.tdCache, {
            'accent-ok': !st.isCacheAnomaly && cachePctNum > 0,
            'text-muted': !st.isCacheAnomaly && cachePctNum === 0,
            'tone-warn': Boolean(st.isCacheAnomaly && !isZeroCacheAnom),
            'tone-danger': isZeroCacheAnom,
          });
          if (st.isCacheAnomaly && st.stepHealthDetail) {
            patchAttr(refs.tdCache, 'title', st.stepHealthDetail);
          } else if (cachePctNum === 0) {
            const benignTip =
              st.cacheZeroReason === 'ttl_expired'
                ? '距上步闲置 ≥5m，前缀缓存自然过期重建（正常不扣分）'
                : st.isCompactionStep
                  ? '上下文压缩检查点（正常重建缓存）'
                  : '冷启动或切换模型/执行阶段（正常不扣分）';
            patchAttr(refs.tdCache, 'title', benignTip);
          } else {
            patchAttr(refs.tdCache, 'title', false);
          }

          const costVal = st.costUsd;
          patchText(refs.tdCost, formatUsd(costVal, { precise: true }));
          patchClasses(refs.tdCost, { 'accent-speed': costVal >= 0.15 });
        },
      });

      // 2. 按模型汇总表增量对账：以模型标识为稳定行键，展示调用次数、加权均速、有效样本比与总费用
      patchKeyedList(modelsTbody, models, {
        keyFn: (m) => m.label || m.shortName,
        sigFn: (m) => {
          const disp = resolveModelDisplayInfo(m, displaySettings, { fallback: '—' });
          return `${disp.text}:${disp.title}:${m.calls}:${m.avgTokPerSec}:${m.totalTokens}:${m.costUsd}:${m.unpricedCalls}:${m.speedSummary?.sampleCount}`;
        },
        createRow: () => {
          const modelHeadEl = h('span', { className: 'model-name-head' });
          const modelTailEl = h('span', { className: 'model-name-tail' });
          const modelNameEl = h('span', { className: 'model-cell-name' }, [
            modelHeadEl,
            modelTailEl,
          ]);
          const tdName = h('td', {
            className: 'col-model model-cell',
            style: 'font-weight: 600;',
          }, [modelNameEl]);
          const tdCalls = h('td');
          const speedMain = h('div');
          const speedSub = h('div', { className: 'text-muted', style: 'font-size: 9.5px;' });
          const tdSpeed = h('td', {}, [speedMain, speedSub]);
          const tdTokens = h('td');
          const tdCost = h('td', { style: 'font-weight: 600;' });
          const tr = h('tr', {}, [tdName, tdCalls, tdSpeed, tdTokens, tdCost]);
          return {
            el: tr,
            refs: { tdName, modelHeadEl, modelTailEl, tdCalls, speedMain, speedSub, tdTokens, tdCost },
          };
        },
        updateRow: (refs, m) => {
          const modelDisplay = resolveModelDisplayInfo(m, displaySettings, { fallback: '—' });
          const { head: modelHead, tail: modelTail } = splitModelHeadTail(modelDisplay.text);
          patchText(refs.modelHeadEl, modelHead);
          patchText(refs.modelTailEl, modelTail);
          patchAttr(refs.tdName, 'title', modelDisplay.title);
          patchText(refs.tdCalls, String(Number(m.calls || 0)));
          patchText(refs.speedMain, formatMetric(m.avgTokPerSec, ' t/s'));
          patchText(refs.speedSub, `有效 ${sampleSummary(m.speedSummary)}`);
          patchText(refs.tdTokens, formatTokens(m.totalTokens || 0));
          patchText(refs.tdCost, formatUsd(m.costUsd || 0));
        },
      });

      if (uiSt.stepsSubTab === 'models') {
        modelsScroll.refresh();
      } else {
        stepsScroll.refresh();
      }
    }

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({
        activeConversation: st.telemetry?.activeConversation,
        cascadeId: st.telemetry?.activeConversation?.cascadeId,
        recentSteps: st.telemetry?.activeConversation?.recentSteps,
        sessionModelBreakdown: st.telemetry?.activeConversation?.modelBreakdown,
        modelBreakdown: st.telemetry?.modelBreakdown,
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        orchestratorIdMode: normalizeOrchestratorIdDisplayMode(
          st.telemetry?.settings?.orchestratorIdMode
        ),
      }),
      (slice) => {
        latestSlice = slice;
        if (uiStore.getState().activeView !== 'steps') {
          isDirty = true;
          return;
        }
        isDirty = false;
        renderStepsData(slice);
      }
    );

    function focusTargetStepIfRequested(target) {
      if (!target || !target.seq || target.seq === lastHandledTargetSeq) return;
      lastHandledTargetSeq = target.seq;
      const rows = Array.from(stepsTbody.children || []);
      for (const r of rows) {
        patchClasses(r, { 'is-step-flash': false });
      }
      const match = rows.find(
        (r) =>
          Number(r.getAttribute?.('data-step-index')) === Number(target.stepIndex) &&
          (!target.agentId ||
            target.agentId === 'all' ||
            r.getAttribute?.('data-agent-id') === target.agentId)
      );
      if (!match) return;
      patchClasses(match, { 'is-step-flash': true });
      if (typeof match.offsetTop === 'number' && typeof stepsTablePane.clientHeight === 'number') {
        stepsTablePane.scrollTop = Math.max(
          0,
          match.offsetTop - Math.round(stepsTablePane.clientHeight / 2) + 16
        );
      } else if (typeof match.scrollIntoView === 'function') {
        match.scrollIntoView({ block: 'center' });
      }
      if (flashRowTimer) clearTimeout(flashRowTimer);
      flashRowTimer = setTimeout(() => {
        flashRowTimer = null;
        patchClasses(match, { 'is-step-flash': false });
      }, 1800);
    }

    let prevScope = uiStore.getState().selectedAgentScope;
    let prevOnlyAnomalies = uiStore.getState().stepsOnlyAnomalies;

    const unsubView = uiStore.subscribe(
      (st) => ({
        activeView: st.activeView,
        selectedAgentScope: st.selectedAgentScope,
        stepsOnlyAnomalies: st.stepsOnlyAnomalies,
        highlightedStepTarget: st.highlightedStepTarget,
      }),
      (uiSlice) => {
        const scopeChanged = uiSlice.selectedAgentScope !== prevScope;
        const filterChanged = uiSlice.stepsOnlyAnomalies !== prevOnlyAnomalies;
        prevScope = uiSlice.selectedAgentScope;
        prevOnlyAnomalies = uiSlice.stepsOnlyAnomalies;
        if (uiSlice.activeView !== 'steps') {
          if (scopeChanged || filterChanged) isDirty = true;
          return;
        }
        if ((isDirty || scopeChanged || filterChanged) && latestSlice) {
          isDirty = false;
          renderStepsData(latestSlice);
        }
        if (uiSlice.highlightedStepTarget) {
          focusTargetStepIfRequested(uiSlice.highlightedStepTarget);
        }
      }
    );

    onCleanup(() => {
      cancelHideTurnTip();
      cancelSwitchTurnTip();
      if (tipCopyTimer.id) clearTimeout(tipCopyTimer.id);
      if (flashRowTimer) clearTimeout(flashRowTimer);
      stepsTablePane.removeEventListener('scroll', onStepsPaneScroll);
      stepsTbody.removeEventListener('mouseleave', scheduleHideTurnTip);
      panelEl.removeEventListener('click', onPanelClick);
      unsubUi();
      unsubTelemetry();
      unsubView();
      inlineScopeSelect.destroy();
      subTabSwitch.destroy();
      stepsScroll.destroy();
      modelsScroll.destroy();
    });

    return {
      el: rootEl,
      refs: {
        stepsTbody,
        modelsTbody,
        inlineScopeSelect,
        subTabSwitch,
        stepsScroll,
        modelsScroll,
      },
    };
  },
});
