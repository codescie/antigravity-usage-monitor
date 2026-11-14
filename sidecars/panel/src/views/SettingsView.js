/**
 * @fileoverview View 4: SettingsView (偏好设置与模型检测视图).
 * 顶部通过二级分段切换器在「常规偏好」与「模型检测」之间无缝切换：
 * - 「常规偏好」包含三个细线设置面板：常规设置、顶部栏定制、版本更新；
 * - 「模型检测」专为反重力环境定制：仅允许选择反重力当前可用模型（默认跟随当前窗口模型），
 *   支持自动与手动同步宿主最新模型目录及 ModelDial 数字指纹库，异步并发执行 3 路无语义整数探针比对模型真身。
 */

import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../core/domPatch.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import {
  CURRENT_WINDOW_MODEL_VALUE,
  DEFAULT_CLIENT_TOPBAR_SLOTS,
  cancelModelDetection,
  fetchModelDetectorStatus,
  fetchTelemetry,
  normalizeClientOrchestratorIdMode,
  normalizeClientTopbarSlots,
  normalizeClientUpdateMode,
  saveSettingsPatch,
  syncModelDetector,
  telemetryStore,
  triggerCloudSync,
  triggerModelDetection,
  triggerPluginUpdate,
} from '../store/telemetryStore.js';
import { uiStore } from '../store/uiStore.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { CustomSelect } from '../components/ui/CustomSelect.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';

/** 偏好设置顶部二级分区选项 */
const SETTINGS_SUBTAB_OPTIONS = [
  { value: 'general', label: '常规偏好' },
  { value: 'detector', label: '模型检测' },
];

/** 模型真身探针采样通道选项（默认极速同权轻思考，避免高阶推理思维链阻塞） */
const DETECTOR_PROBE_MODE_OPTIONS = [
  { value: 'fast', label: '极速同权' },
  { value: 'exact', label: '原档直测' },
];

/** 步骤明细表中的模型名称显示方式可选项 */
const STEP_MODEL_DISPLAY_OPTIONS = [
  { value: 'short', label: '精简代号 (如 argon-4-high)' },
  { value: 'upstream', label: '原始模型 ID (如 gemini-3.8-flash-n)' },
];

/** Orchestrator 系列模型 ID 显示方式可选项（独立于普通模型名称格式） */
const ORCHESTRATOR_ID_DISPLAY_OPTIONS = [
  { value: 'compact', label: '精简代号 (如 orchestrator-argon)' },
  { value: 'full', label: '原始完整 ID (如 gemini-pro-orchestrator)' },
];

/** 面板挂载模式可选项（顶部栏 + 侧边栏 vs 仅侧边栏） */
const WINDOW_MOUNT_OPTIONS = [
  { value: 'dual', label: '双栖挂载 (顶部栏 + 侧边栏)' },
  { value: 'sidebar', label: '仅侧边栏' },
];

/** 顶栏左侧实时运行会话入口显隐选项 */
const TOPBAR_MULTI_TOGGLE_OPTIONS = [
  { value: 'show', label: '显示' },
  { value: 'hide', label: '隐藏' },
];

/** 顶栏右侧精简胶囊三槽位可选指标项 */
const TOPBAR_SLOT_OPTIONS = [
  { value: 'context', label: '上下文占用 (%)' },
  { value: 'tps', label: '输出速度 (TPS)' },
  { value: 'ttft', label: '首字延迟 (TTFT)' },
  { value: 'cost', label: '本次费用 ($)' },
  { value: 'quota_auto', label: '自动紧俏额度' },
  { value: 'gemini_5h', label: 'Gemini 5h 额度' },
  { value: 'gemini_weekly', label: 'Gemini 周额度' },
  { value: 'claude_5h', label: 'Claude 5h 额度' },
  { value: 'claude_weekly', label: 'Claude 周额度' },
  { value: 'none', label: '不显示' },
];

/** 插件版本更新策略可选项（默认仅提示新版本、手动更新） */
const AUTO_UPDATE_OPTIONS = [
  { value: 'manual', label: '仅提示新版本，手动更新' },
  { value: 'auto', label: '自动更新' },
  { value: 'off', label: '关闭更新' },
];

/**
 * 格式化云端价格目录的最近同步时间或版本日期文本。
 */
function formatSyncTimeText(tsMs, updatedAt) {
  if (Number(tsMs) > 0) {
    const d = new Date(Number(tsMs));
    const pad = (n) => String(n).padStart(2, '0');
    return `更新于 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (updatedAt) {
    return `发布于 ${String(updatedAt).slice(0, 10)}`;
  }
  return '默认价格';
}

function formatDetectorBankSubtext(bank) {
  if (!bank || !bank.ready) {
    return bank?.lastSyncError ? '指纹库异常' : '正在加载指纹库…';
  }
  const srcText = bank.source === 'remote' ? '云端热更新' : '内置最新包';
  const datePart = bank.builtAt ? String(bank.builtAt).slice(0, 10) : '';
  if (Number(bank.lastCheckedAtMs) > 0) {
    const d = new Date(Number(bank.lastCheckedAtMs));
    const pad = (n) => String(n).padStart(2, '0');
    return `${srcText} · 核验 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return datePart ? `${srcText} · ${datePart}` : srcText;
}

function formatDetectorOptionMeta(model) {
  if (!model) return '';
  if (model.isQuotaExhausted) return '无额度';
  if (Number.isFinite(model.remainingPct)) {
    return `余 ${model.remainingPct}%`;
  }
  return model.tagTitle || '';
}

function formatDetectorHistoryClock(isoStr) {
  const ms = Date.parse(String(isoStr || ''));
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const SettingsView = defineComponent({
  name: 'SettingsView',
  setup({ onCleanup }) {
    let draftShowUpstreamModel = false;
    let draftOrchestratorIdMode = 'compact';
    let draftPluginUpdateMode = 'manual';
    let draftEnableWindowOverlay = true;
    let draftShowTopbarMulti = true;
    let draftTopbarSlots = [...DEFAULT_CLIENT_TOPBAR_SLOTS];
    let statusTimer = null;
    let topbarTimer = null;
    let cloudTimer = null;
    let detectorFeedbackTimer = null;
    let detectorPollTimer = null;

    const saveStatusText = h('span', { className: 'text-muted', style: 'font-size: 11px;', text: '' });
    const topbarStatusText = h('span', { className: 'text-muted', style: 'font-size: 11px;', text: '' });
    const cloudStatusMsg = h('span', { className: 'text-muted', style: 'font-size: 11px;', text: '' });
    const detectorStatusMsg = h('span', { className: 'text-muted', style: 'font-size: 11px;', text: '' });

    /** 在常规设置面板右上角展示短暂的保存状态提示 */
    function showSaveFeedback(text) {
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      patchText(saveStatusText, text);
      if (text === '已保存' || text === '保存失败') {
        statusTimer = setTimeout(() => {
          statusTimer = null;
          patchText(saveStatusText, '');
        }, text === '保存失败' ? 2500 : 1500);
      }
    }

    /** 在顶部栏定制面板右上角展示短暂的状态提示 */
    function showTopbarFeedback(text, autoClearMs = 1500) {
      if (topbarTimer) {
        clearTimeout(topbarTimer);
        topbarTimer = null;
      }
      patchText(topbarStatusText, text);
      if (autoClearMs > 0) {
        topbarTimer = setTimeout(() => {
          topbarTimer = null;
          patchText(topbarStatusText, '');
        }, autoClearMs);
      }
    }

    /** 在云端同步面板右上角展示同步或更新进度提示 */
    function showCloudFeedback(text, autoClearMs = 3500) {
      if (cloudTimer) {
        clearTimeout(cloudTimer);
        cloudTimer = null;
      }
      patchText(cloudStatusMsg, text);
      if (autoClearMs > 0) {
        cloudTimer = setTimeout(() => {
          cloudTimer = null;
          patchText(cloudStatusMsg, '');
        }, autoClearMs);
      }
    }

    /** 在模型检测面板右上角展示同步或检测状态提示 */
    function showDetectorFeedback(text, autoClearMs = 3500) {
      if (detectorFeedbackTimer) {
        clearTimeout(detectorFeedbackTimer);
        detectorFeedbackTimer = null;
      }
      patchText(detectorStatusMsg, text);
      if (autoClearMs > 0) {
        detectorFeedbackTimer = setTimeout(() => {
          detectorFeedbackTimer = null;
          patchText(detectorStatusMsg, '');
        }, autoClearMs);
      }
    }

    // --- 顶部二级分区切换条：常规偏好 | 模型检测 ---
    const settingsSubTabSwitch = SegmentedControl({
      ariaLabel: '偏好设置分区切换',
      modelValue: uiStore.getState().settingsSubTab || 'general',
      options: SETTINGS_SUBTAB_OPTIONS,
      onUpdateModelValue: (nextSubTab) => {
        uiStore.setState({ settingsSubTab: nextSubTab === 'detector' ? 'detector' : 'general' });
      },
    });
    const settingsSubNavBar = h('div', { className: 'settings-subnav' }, [settingsSubTabSwitch.el]);

    // --- 面板 1：常规设置 ---
    const windowMountSelect = CustomSelect({
      modelValue: 'dual',
      icon: 'dock',
      options: WINDOW_MOUNT_OPTIONS,
      onUpdateModelValue: async (val) => {
        const nextEnable = val !== 'sidebar';
        draftEnableWindowOverlay = nextEnable;
        windowMountSelect.setValue(nextEnable ? 'dual' : 'sidebar');
        showSaveFeedback('保存中…');
        try {
          await saveSettingsPatch({
            enableWindowOverlay: nextEnable,
          });
          showSaveFeedback('已保存');
        } catch {
          if (latestSettings) {
            renderSettings(latestSettings);
          }
          showSaveFeedback('保存失败');
        }
      },
    });

    const stepModelSelect = CustomSelect({
      modelValue: 'short',
      icon: 'table',
      options: STEP_MODEL_DISPLAY_OPTIONS,
      onUpdateModelValue: async (val) => {
        const nextUpstream = val === 'upstream';
        draftShowUpstreamModel = nextUpstream;
        stepModelSelect.setValue(nextUpstream ? 'upstream' : 'short');
        showSaveFeedback('保存中…');
        try {
          await saveSettingsPatch({
            showUpstreamModel: nextUpstream,
          });
          showSaveFeedback('已保存');
        } catch {
          if (latestSettings) {
            renderSettings(latestSettings);
          }
          showSaveFeedback('保存失败');
        }
      },
    });

    const orchestratorIdSelect = CustomSelect({
      modelValue: 'compact',
      icon: 'layers',
      options: ORCHESTRATOR_ID_DISPLAY_OPTIONS,
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientOrchestratorIdMode(val);
        draftOrchestratorIdMode = nextMode;
        orchestratorIdSelect.setValue(nextMode);
        showSaveFeedback('保存中…');
        try {
          await saveSettingsPatch({
            orchestratorIdMode: nextMode,
          });
          showSaveFeedback('已保存');
        } catch {
          if (latestSettings) {
            renderSettings(latestSettings);
          }
          showSaveFeedback('保存失败');
        }
      },
    });

    const generalPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          h('span', { text: '常规设置' }),
        ]),
        saveStatusText,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: '面板挂载方式' }),
        windowMountSelect.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: '模型名称格式' }),
        stepModelSelect.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: 'Orchestrator 系列 ID' }),
        orchestratorIdSelect.el,
      ]),
    ]);

    // --- 面板 2：顶部栏定制（实时运行会话开关 + 右侧三槽位指标与顺序自定义） ---
    const multiSessionToggle = SegmentedControl({
      ariaLabel: '实时运行会话开关',
      modelValue: 'show',
      options: TOPBAR_MULTI_TOGGLE_OPTIONS,
      onUpdateModelValue: async (val) => {
        const nextShow = val !== 'hide';
        draftShowTopbarMulti = nextShow;
        syncTopbarControls();
        showTopbarFeedback('保存中…', 0);
        try {
          await saveSettingsPatch({
            showTopbarMultiSession: nextShow,
          });
          showTopbarFeedback('已保存', 1500);
        } catch {
          if (latestSettings) {
            renderSettings(latestSettings);
          }
          showTopbarFeedback('保存失败', 2500);
        }
      },
    });

    async function persistTopbarSlots(nextRawSlots, noticeText = '') {
      const normalized = normalizeClientTopbarSlots(nextRawSlots);
      draftTopbarSlots = normalized;
      syncTopbarControls();
      showTopbarFeedback(noticeText || '保存中…', 0);
      try {
        await saveSettingsPatch({
          topbarCapsuleSlots: normalized,
        });
        showTopbarFeedback(noticeText || '已保存', noticeText ? 2000 : 1500);
      } catch {
        if (latestSettings) {
          renderSettings(latestSettings);
        }
        showTopbarFeedback('保存失败', 2500);
      }
    }

    function handleSlotMetricChange(slotIndex, nextVal) {
      const candidate = [...draftTopbarSlots];
      candidate[slotIndex] = nextVal;
      const wouldAllBeHidden = candidate.every((item) => item === 'none');
      void persistTopbarSlots(
        candidate,
        wouldAllBeHidden ? '至少保留 1 项显示' : ''
      );
    }

    function swapTopbarSlots(idxA, idxB) {
      if (idxA < 0 || idxA > 2 || idxB < 0 || idxB > 2 || idxA === idxB) return;
      const candidate = [...draftTopbarSlots];
      const temp = candidate[idxA];
      candidate[idxA] = candidate[idxB];
      candidate[idxB] = temp;
      void persistTopbarSlots(candidate);
    }

    const slotSelects = [0, 1, 2].map((idx) =>
      CustomSelect({
        modelValue: draftTopbarSlots[idx],
        options: TOPBAR_SLOT_OPTIONS,
        onUpdateModelValue: (val) => handleSlotMetricChange(idx, val),
      })
    );

    const slotRows = [0, 1, 2].map((idx) => {
      const upBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn',
          disabled: idx === 0,
          'aria-label': `槽位 ${idx + 1} 左移`,
          title: idx === 0 ? '已在最左' : '上移 (在顶栏靠左)',
          onClick: (e) => {
            e.stopPropagation();
            swapTopbarSlots(idx, idx - 1);
          },
        },
        [createSvgIcon('chevron-up', { size: 12 })]
      );

      const downBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn',
          disabled: idx === 2,
          'aria-label': `槽位 ${idx + 1} 右移`,
          title: idx === 2 ? '已在最右' : '下移 (在顶栏靠右)',
          onClick: (e) => {
            e.stopPropagation();
            swapTopbarSlots(idx, idx + 1);
          },
        },
        [createSvgIcon('chevron-down', { size: 12 })]
      );

      return h('div', { className: 'topbar-slot-row', 'data-slot-row': String(idx) }, [
        h('span', { className: 'slot-index-badge', text: String(idx + 1) }),
        slotSelects[idx].el,
        h('span', { className: 'slot-order-btns' }, [upBtn, downBtn]),
      ]);
    });

    const resetTopbarBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-ghost-sm',
        disabled: true,
        onClick: async () => {
          draftShowTopbarMulti = true;
          draftTopbarSlots = [...DEFAULT_CLIENT_TOPBAR_SLOTS];
          syncTopbarControls();
          showTopbarFeedback('保存中…', 0);
          try {
            await saveSettingsPatch({
              showTopbarMultiSession: true,
              topbarCapsuleSlots: [...DEFAULT_CLIENT_TOPBAR_SLOTS],
            });
            showTopbarFeedback('已恢复默认', 1600);
          } catch {
            if (latestSettings) {
              renderSettings(latestSettings);
            }
            showTopbarFeedback('保存失败', 2500);
          }
        },
      },
      [h('span', { text: '恢复默认' })]
    );

    function syncTopbarControls() {
      multiSessionToggle.setValue(draftShowTopbarMulti ? 'show' : 'hide');
      for (let i = 0; i < 3; i += 1) {
        slotSelects[i].setValue(draftTopbarSlots[i]);
      }
      const isDefault =
        draftShowTopbarMulti === true &&
        draftTopbarSlots[0] === DEFAULT_CLIENT_TOPBAR_SLOTS[0] &&
        draftTopbarSlots[1] === DEFAULT_CLIENT_TOPBAR_SLOTS[1] &&
        draftTopbarSlots[2] === DEFAULT_CLIENT_TOPBAR_SLOTS[2];
      patchAttr(resetTopbarBtn, 'disabled', isDefault);
    }

    const topbarPanel = h('section', { className: 'panel topbar-config-panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('dock', { size: 13 }),
          h('span', { text: '顶部栏定制' }),
        ]),
        h('span', { className: 'topbar-header-right' }, [topbarStatusText, resetTopbarBtn]),
      ]),
      h('div', { className: 'settings-inline-row' }, [
        h('span', { className: 'form-label', text: '实时运行会话' }),
        multiSessionToggle.el,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: '胶囊数值与顺序 (左 → 右)' }),
        h('div', { className: 'topbar-slot-list' }, slotRows),
      ]),
    ]);

    // --- 面板 3：版本更新面板 ---
    const autoUpdateSelect = CustomSelect({
      modelValue: 'manual',
      icon: 'refresh',
      options: AUTO_UPDATE_OPTIONS,
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientUpdateMode(val);
        draftPluginUpdateMode = nextMode;
        autoUpdateSelect.setValue(nextMode);
        if (latestCloudStatus) {
          renderCloudStatus(latestCloudStatus);
        }
        showCloudFeedback('保存中…', 0);
        try {
          await saveSettingsPatch({
            pluginUpdateMode: nextMode,
            autoUpdatePlugin: nextMode === 'auto',
          });
          showCloudFeedback('已保存', 1800);
        } catch {
          if (latestSettings) {
            renderSettings(latestSettings);
          }
          if (latestCloudStatus) {
            renderCloudStatus(latestCloudStatus);
          }
          showCloudFeedback('保存失败', 2500);
        }
      },
    });

    const pricingCountVal = h('strong', { className: 'cell-value', text: '—' });
    const pricingSyncSub = h('span', { className: 'cell-sub', text: '读取中…' });
    const versionVal = h('strong', { className: 'cell-value', text: 'v1.4.4' });
    const versionSub = h('span', { className: 'cell-sub', text: '检查中…' });

    const syncPricingBtnText = h('span', { text: '更新价格表' });
    const syncPricingBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          patchAttr(syncPricingBtn, 'disabled', true);
          patchText(syncPricingBtnText, '更新中…');
          showCloudFeedback('正在同步价格表…', 0);
          try {
            const res = await triggerCloudSync();
            const cs = res?.cloudStatus;
            if (res?.ok && cs) {
              showCloudFeedback(`价格表已更新 (${cs.modelCount} 个模型)`, 3500);
            } else {
              showCloudFeedback(cs?.lastSyncError || '连接超时，使用本地价格表', 4500);
            }
          } catch (err) {
            showCloudFeedback(err?.message || '同步失败，使用本地价格表', 4500);
          } finally {
            patchAttr(syncPricingBtn, 'disabled', false);
            patchText(syncPricingBtnText, '更新价格表');
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), syncPricingBtnText]
    );

    const updatePluginBtnText = h('span', { text: '检查更新' });
    const updatePluginBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          patchAttr(updatePluginBtn, 'disabled', true);
          try {
            if (!latestCloudStatus?.updateAvailable) {
              patchText(updatePluginBtnText, '检查中…');
              showCloudFeedback('正在检查新版本…', 0);
              const syncRes = await triggerCloudSync();
              const cs = syncRes?.cloudStatus || latestCloudStatus;
              if (cs) {
                latestCloudStatus = cs;
                renderCloudStatus(cs);
              }
              if (!syncRes?.ok && cs?.lastSyncError) {
                showCloudFeedback(`检查失败：${cs.lastSyncError}`, 5000);
                return;
              }
              if (!cs?.updateAvailable) {
                const curVer = cs?.currentPluginVersion || '1.4.4';
                showCloudFeedback(`当前已是最新版本 (v${curVer})`, 4500);
                return;
              }
            }
            patchText(updatePluginBtnText, '更新中…');
            showCloudFeedback('正在下载更新…', 0);
            const res = await triggerPluginUpdate();
            if (res?.cloudStatus) {
              latestCloudStatus = res.cloudStatus;
            }
            if (res?.ok) {
              showCloudFeedback(res.message || '更新完成，正在重启面板…', 5000);
            } else {
              showCloudFeedback(res?.message || '未执行更新', 5500);
            }
          } catch (err) {
            showCloudFeedback(err?.message || '更新失败', 5000);
          } finally {
            patchAttr(updatePluginBtn, 'disabled', false);
            renderCloudStatus(latestCloudStatus);
          }
        },
      },
      [createSvgIcon('arrow-down', { size: 12 }), updatePluginBtnText]
    );

    const cloudPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('bolt', { size: 13 }),
          h('span', { text: '版本更新' }),
        ]),
        cloudStatusMsg,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: '更新方式' }),
        autoUpdateSelect.el,
      ]),
      h('div', { className: 'dual-grid' }, [
        h('div', { className: 'matrix-cell' }, [
          h('span', { className: 'cell-label', text: '价格表' }),
          pricingCountVal,
          pricingSyncSub,
        ]),
        h('div', { className: 'matrix-cell' }, [
          h('span', { className: 'cell-label', text: '当前版本' }),
          versionVal,
          versionSub,
        ]),
      ]),
      h('div', { className: 'cloud-actions-row' }, [syncPricingBtn, updatePluginBtn]),
    ]);

    const generalGroup = h('div', { className: 'settings-tab-group' }, [
      generalPanel,
      topbarPanel,
      cloudPanel,
    ]);

    // =========================================================================
    // 分区 2：模型真身检测（仅限反重力可用模型，默认跟随当前窗口模型）
    // =========================================================================
    let selectedDetectorModelId = CURRENT_WINDOW_MODEL_VALUE;
    let detectorSnapshot = null;
    let inspectedHistoryId = '';
    let wasDetectorRunning = false;

    const detectorModelSelect = CustomSelect({
      modelValue: CURRENT_WINDOW_MODEL_VALUE,
      icon: 'fingerprint',
      options: [{ value: CURRENT_WINDOW_MODEL_VALUE, label: '当前窗口模型 (自动识别)', meta: '默认' }],
      onUpdateModelValue: (val) => {
        selectedDetectorModelId = val || CURRENT_WINDOW_MODEL_VALUE;
        renderDetectorSnapshot(detectorSnapshot);
      },
    });

    const detectorProbeModeSwitch = SegmentedControl({
      ariaLabel: '探针采样通道选择',
      modelValue: uiStore.getState().detectorProbeMode || 'fast',
      options: DETECTOR_PROBE_MODE_OPTIONS,
      onUpdateModelValue: (nextMode) => {
        const mode = nextMode === 'exact' ? 'exact' : 'fast';
        uiStore.setState({ detectorProbeMode: mode });
        detectorProbeModeSwitch.setValue(mode);
      },
    });

    const agModelCountVal = h('strong', { className: 'cell-value', text: '—' });
    const agModelRefSub = h('span', { className: 'cell-sub', text: '同步反重力模型中…' });
    const bankCountVal = h('strong', { className: 'cell-value', text: '—' });
    const bankSyncSub = h('span', { className: 'cell-sub', text: '读取指纹库…' });

    const syncDetectorBtnText = h('span', { text: '更新指纹库' });
    const syncDetectorBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          patchAttr(syncDetectorBtn, 'disabled', true);
          patchAttr(startDetectBtn, 'disabled', true);
          patchText(syncDetectorBtnText, '同步中…');
          showDetectorFeedback('正在同步指纹库与宿主模型…', 0);
          try {
            const res = await syncModelDetector({
              knownModels: detectorSnapshot?.availableModels || [],
            });
            if (res) {
              detectorSnapshot = res;
              renderDetectorSnapshot(res);
            }
            const sr = res?.syncResult;
            const agCount = Array.isArray(res?.availableModels) ? res.availableModels.length : 0;
            if (sr?.error) {
              showDetectorFeedback(`已同步 ${agCount} 个模型 · 指纹库离线可用`, 4500);
            } else if (sr?.updated) {
              showDetectorFeedback(
                `指纹库已更新 (${res?.bank?.modelCount || 0} 参考) · ${agCount} 个宿主模型`,
                4000
              );
            } else {
              showDetectorFeedback(`指纹库已是最新 · 已同步 ${agCount} 个反重力模型`, 3500);
            }
          } catch (err) {
            showDetectorFeedback(err?.message || '同步失败，使用本地指纹库', 4500);
          } finally {
            patchText(syncDetectorBtnText, '更新指纹库');
            renderDetectorSnapshot(detectorSnapshot);
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), syncDetectorBtnText]
    );

    const startDetectBtnText = h('span', { text: '开始检测' });
    const startDetectBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        onClick: async () => {
          patchAttr(startDetectBtn, 'disabled', true);
          patchAttr(syncDetectorBtn, 'disabled', true);
          showDetectorFeedback('正在启动探针…', 0);
          try {
            const res = await triggerModelDetection({
              modelId: selectedDetectorModelId,
              probeMode: uiStore.getState().detectorProbeMode || 'fast',
              knownModels: detectorSnapshot?.availableModels || [],
            });
            inspectedHistoryId = '';
            if (res?.status) {
              wasDetectorRunning = Boolean(res.status.running?.active);
              detectorSnapshot = res.status;
              renderDetectorSnapshot(res.status);
              ensureDetectorPollLoop();
            }
            showDetectorFeedback('', 0);
          } catch (err) {
            showDetectorFeedback(err?.message || '启动检测失败', 4500);
            patchAttr(startDetectBtn, 'disabled', false);
            patchAttr(syncDetectorBtn, 'disabled', false);
          }
        },
      },
      [createSvgIcon('bolt', { size: 12 }), startDetectBtnText]
    );

    const detectorIdleActionsRow = h('div', { className: 'cloud-actions-row' }, [
      syncDetectorBtn,
      startDetectBtn,
    ]);

    const detectorProgressPhase = h('span', {
      className: 'detector-progress-phase',
      text: '正在并发启动 3 路无语义整数探针…',
    });
    const detectorProgressElapsed = h('span', {
      className: 'detector-progress-elapsed',
      text: '0.0s',
    });
    const detectorProgressFill = h('div', { className: 'progress-fill' });
    patchStyleVar(detectorProgressFill, '--fill-w', '12%');

    const cancelDetectBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          patchAttr(cancelDetectBtn, 'disabled', true);
          try {
            const res = await cancelModelDetection({
              knownModels: detectorSnapshot?.availableModels || [],
            });
            stopDetectorPollLoop();
            wasDetectorRunning = false;
            if (res?.status) {
              detectorSnapshot = res.status;
              renderDetectorSnapshot(res.status);
            }
            showDetectorFeedback('已取消检测', 2200);
          } catch (err) {
            showDetectorFeedback(err?.message || '取消失败', 3000);
          } finally {
            patchAttr(cancelDetectBtn, 'disabled', false);
          }
        },
      },
      [createSvgIcon('close', { size: 12 }), h('span', { text: '取消检测' })]
    );

    const detectorProgressBox = h(
      'div',
      { className: 'detector-progress-box', hidden: true },
      [
        h('div', { className: 'detector-progress-head' }, [
          detectorProgressPhase,
          detectorProgressElapsed,
        ]),
        h('div', { className: 'progress-track' }, [detectorProgressFill]),
        h('div', { className: 'cloud-actions-row' }, [cancelDetectBtn]),
      ]
    );

    const detectorControlPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('fingerprint', { size: 13 }),
          h('span', { text: '模型真身检测' }),
        ]),
        detectorStatusMsg,
      ]),
      h('div', { className: 'form-row' }, [
        h('span', { className: 'form-label', text: '测试模型 (仅限反重力可用模型)' }),
        h('div', { className: 'detector-select-box' }, [detectorModelSelect.el]),
      ]),
      h('div', { className: 'settings-inline-row detector-mode-row' }, [
        h('span', { className: 'form-label', text: '采样通道' }),
        detectorProbeModeSwitch.el,
      ]),
      h('div', { className: 'dual-grid' }, [
        h('div', { className: 'matrix-cell' }, [
          h('span', { className: 'cell-label', text: '反重力模型' }),
          agModelCountVal,
          agModelRefSub,
        ]),
        h('div', { className: 'matrix-cell' }, [
          h('span', { className: 'cell-label', text: '数字指纹库' }),
          bankCountVal,
          bankSyncSub,
        ]),
      ]),
      detectorIdleActionsRow,
      detectorProgressBox,
    ]);

    // --- 检测结论与候选排名面板 ---
    const verdictMetaText = h('span', { className: 'panel-meta', text: '' });
    const detectorEmptyNote = h('div', {
      className: 'detector-empty-note',
      text: '默认检测当前窗口模型。通过 3 路多语种无语义整数分布数学比对模型底层权重，不污染当前对话上下文。',
    });

    const verdictStatusTag = h('span', { className: 'status-tag', text: '真身一致' });
    const verdictTargetText = h('span', { className: 'detector-verdict-target', text: '' });
    const verdictHeadline = h('div', { className: 'detector-headline', text: '' });
    const verdictDetail = h('div', { className: 'detector-detail', text: '' });

    const candidateListEl = h('div', { className: 'detector-candidates', hidden: true });
    const historyListEl = h('div', { className: 'detector-history-list' });
    const historySectionEl = h(
      'div',
      { className: 'detector-history-section', hidden: true },
      [
        h('span', { className: 'detector-history-label', text: '最近记录' }),
        historyListEl,
      ]
    );

    const detectorVerdictBody = h(
      'div',
      { className: 'detector-verdict-body', hidden: true },
      [
        h('div', { className: 'detector-verdict-box' }, [
          h('div', { className: 'detector-verdict-top' }, [
            h('div', { className: 'detector-verdict-left' }, [
              verdictStatusTag,
              verdictTargetText,
            ]),
          ]),
          verdictHeadline,
          verdictDetail,
        ]),
        candidateListEl,
        historySectionEl,
      ]
    );

    const detectorResultPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('pulse', { size: 13 }),
          h('span', { text: '检测结论' }),
        ]),
        verdictMetaText,
      ]),
      detectorEmptyNote,
      detectorVerdictBody,
    ]);

    const detectorGroup = h(
      'div',
      { className: 'settings-tab-group', hidden: true },
      [detectorControlPanel, detectorResultPanel]
    );

    function renderDetectorSnapshot(snap) {
      if (!snap) return;
      const models = Array.isArray(snap.availableModels) ? snap.availableModels : [];
      const curWin = snap.currentWindowModel || null;
      const bank = snap.bank || null;
      const running = snap.running?.active ? snap.running : null;

      if (
        selectedDetectorModelId !== CURRENT_WINDOW_MODEL_VALUE &&
        models.length > 0 &&
        !models.some((m) => m.modelId === selectedDetectorModelId)
      ) {
        selectedDetectorModelId = CURRENT_WINDOW_MODEL_VALUE;
      }

      const curLabel = curWin?.label
        ? `当前窗口 · ${curWin.label}`
        : '当前窗口模型 (自动识别)';
      const curMeta = curWin ? formatDetectorOptionMeta(curWin) || '默认' : '默认';

      const selectOptions = [
        {
          value: CURRENT_WINDOW_MODEL_VALUE,
          label: curLabel,
          meta: curMeta,
        },
        ...models.map((m) => ({
          value: m.modelId,
          label: m.label,
          meta: formatDetectorOptionMeta(m),
        })),
      ];
      detectorModelSelect.setProps({
        modelValue: selectedDetectorModelId,
        options: selectOptions,
      });

      const activeTarget =
        selectedDetectorModelId === CURRENT_WINDOW_MODEL_VALUE
          ? curWin || models[0] || null
          : models.find((m) => m.modelId === selectedDetectorModelId) || null;

      patchText(agModelCountVal, models.length > 0 ? `${models.length} 个可选` : '读取中…');
      if (activeTarget) {
        const refText =
          activeTarget.reference && activeTarget.reference !== 'unknown'
            ? `对标 ${activeTarget.reference}`
            : '开放识别 · 自动同步';
        patchText(agModelRefSub, refText);
      } else {
        patchText(agModelRefSub, '自动同步宿主模型');
      }

      patchText(
        bankCountVal,
        bank?.ready ? `${bank.modelCount || 0} 个参考` : '未就绪'
      );
      patchText(bankSyncSub, formatDetectorBankSubtext(bank));

      const isBusy = Boolean(running);
      patchAttr(detectorIdleActionsRow, 'hidden', isBusy);
      patchAttr(detectorProgressBox, 'hidden', !isBusy);
      patchAttr(syncDetectorBtn, 'disabled', isBusy || Boolean(bank?.isSyncing));
      patchAttr(startDetectBtn, 'disabled', isBusy || !bank?.ready || models.length === 0);

      if (running) {
        patchText(
          detectorProgressPhase,
          running.phaseText || `正在检测 ${running.targetLabel || ''}…`
        );
        const sec = ((running.elapsedMs || 0) / 1000).toFixed(1);
        patchText(detectorProgressElapsed, `${sec}s`);
        const completed = Number(running.completedProbes || 0);
        const total = Math.max(1, Number(running.totalProbes || 3));
        const liveNums = Number(running.liveParsedNumbers || 0);
        const expectedNums = Math.max(300, Number(running.expectedTotalNumbers || 900));
        const activeThinking = Number(running.activeThinkingProbes || 0);
        let pct = 14;
        if (completed >= total) {
          pct = 94;
        } else {
          const donePct = (completed / total) * 74;
          const streamPct = Math.min(0.95, liveNums / expectedNums) * 74;
          const thinkBoost = activeThinking > 0 ? Math.min(18, activeThinking * 5) : 0;
          pct = Math.round(14 + Math.max(donePct, streamPct, thinkBoost));
        }
        patchStyleVar(detectorProgressFill, '--fill-w', `${Math.max(12, Math.min(95, pct))}%`);
      }

      const history = Array.isArray(snap.history) ? snap.history : [];
      const activeRecord =
        (inspectedHistoryId && history.find((item) => item?.id === inspectedHistoryId)) ||
        snap.latestResult ||
        history[0] ||
        null;

      if (!activeRecord) {
        patchAttr(detectorEmptyNote, 'hidden', false);
        patchAttr(detectorVerdictBody, 'hidden', true);
        patchText(verdictMetaText, '');
      } else {
        patchAttr(detectorEmptyNote, 'hidden', true);
        patchAttr(detectorVerdictBody, 'hidden', false);

        const tone = activeRecord.summary?.tone || 'neutral';
        patchText(verdictStatusTag, activeRecord.summary?.badge || '已完成');
        patchClasses(verdictStatusTag, {
          'state-synced': tone === 'ok' || tone === 'good' || tone === 'info',
          'state-warn': tone === 'warn',
          'state-danger': tone === 'bad',
          'state-neutral': tone === 'neutral',
        });

        const targetSuffix = activeRecord.usedCurrentWindowDefault ? ' · 当前窗口' : '';
        patchText(verdictTargetText, `${activeRecord.targetLabel || activeRecord.targetModelId || ''}${targetSuffix}`);
        patchText(verdictHeadline, activeRecord.summary?.headline || '');
        patchText(verdictDetail, activeRecord.summary?.detail || '');

        const durSec = Number.isFinite(activeRecord.elapsedMs)
          ? `${(activeRecord.elapsedMs / 1000).toFixed(1)}s`
          : '';
        const sampleMeta =
          activeRecord.usedOutputs > 0
            ? `${activeRecord.usedOutputs}/3 采样 · ${activeRecord.totalNumbers || 0} 整数`
            : '';
        const modeMeta = activeRecord.ok
          ? activeRecord.fastTierRouted
            ? '极速同权'
            : activeRecord.probeMode === 'exact'
              ? '原档直测'
              : ''
          : '';
        patchText(
          verdictMetaText,
          [durSec, sampleMeta, modeMeta].filter(Boolean).join(' · ')
        );

        const topCands = Array.isArray(activeRecord.topCandidates)
          ? activeRecord.topCandidates.slice(0, 3)
          : [];
        patchAttr(candidateListEl, 'hidden', topCands.length === 0);

        if (topCands.length > 0) {
          const maxRaw = Math.max(
            ...topCands.map((c) => Number(c.rawScore ?? c.score ?? 0)),
            1e-6
          );
          const minRaw = Math.min(
            ...topCands.map((c) => Number(c.rawScore ?? c.score ?? 0)),
            0
          );
          const spanRaw = Math.max(maxRaw - minRaw, 1e-6);

          patchKeyedList(candidateListEl, topCands, {
            keyFn: (cand) => cand.model || cand.label,
            sigFn: (cand, idx) =>
              `${idx}::${cand.label}::${cand.probability ?? ''}::${cand.score ?? ''}`,
            createRow: () => {
              const rankEl = h('span', { className: 'detector-cand-rank' });
              const nameEl = h('span', { className: 'detector-cand-name' });
              const fillEl = h('div', { className: 'detector-cand-fill' });
              const trackEl = h('div', { className: 'detector-cand-track' }, [fillEl]);
              const pctEl = h('span', { className: 'detector-cand-pct' });
              const rowEl = h('div', { className: 'detector-cand-row' }, [
                rankEl,
                nameEl,
                trackEl,
                pctEl,
              ]);
              return { el: rowEl, refs: { rankEl, nameEl, fillEl, pctEl } };
            },
            updateRow: (refs, cand, idx, rowEl) => {
              patchClasses(rowEl, { 'is-top': idx === 0 });
              patchText(refs.rankEl, `#${idx + 1}`);
              patchText(refs.nameEl, cand.label || cand.model || '');
              patchAttr(refs.nameEl, 'title', cand.familyName ? `${cand.label} (${cand.familyName})` : cand.label || '');
              if (Number.isFinite(cand.probability)) {
                const pct = Math.max(0, Math.min(100, cand.probability * 100));
                patchStyleVar(refs.fillEl, '--cand-w', `${Math.max(4, Math.round(pct))}%`);
                patchText(refs.pctEl, `${pct >= 10 ? pct.toFixed(1) : pct.toFixed(1)}%`);
              } else {
                const rel = Math.round(
                  25 + ((Number(cand.rawScore ?? cand.score ?? 0) - minRaw) / spanRaw) * 75
                );
                patchStyleVar(refs.fillEl, '--cand-w', `${Math.max(8, Math.min(100, rel))}%`);
                patchText(refs.pctEl, Number(cand.score ?? 0).toFixed(2));
              }
            },
          });
        }

        const showHistory = history.length > 1;
        patchAttr(historySectionEl, 'hidden', !showHistory);
        if (showHistory) {
          const histSlice = history.slice(0, 4);
          patchKeyedList(historyListEl, histSlice, {
            keyFn: (item) => item.id,
            sigFn: (item) =>
              `${item.id}::${item.id === activeRecord.id}::${item.summary?.badge || ''}::${item.targetLabel || ''}`,
            createRow: (item) => {
              const badgeEl = h('span', { className: 'detector-history-badge' });
              const modelEl = h('span', { className: 'detector-history-model' });
              const timeEl = h('span', { className: 'detector-history-time' });
              const btnEl = h(
                'button',
                {
                  type: 'button',
                  className: 'detector-history-item',
                  onClick: () => {
                    inspectedHistoryId = item.id;
                    renderDetectorSnapshot(detectorSnapshot);
                  },
                },
                [
                  h('span', { className: 'detector-history-item-left' }, [badgeEl, modelEl]),
                  timeEl,
                ]
              );
              return { el: btnEl, refs: { badgeEl, modelEl, timeEl } };
            },
            updateRow: (refs, item, _idx, btnEl) => {
              const selected = item.id === activeRecord.id;
              const hTone = item.summary?.tone || 'neutral';
              patchClasses(btnEl, { 'is-selected': selected });
              patchText(refs.badgeEl, item.summary?.badge || '完成');
              patchClasses(refs.badgeEl, {
                'tone-good': hTone === 'ok' || hTone === 'good',
                'tone-info': hTone === 'info',
                'tone-warn': hTone === 'warn',
                'tone-bad': hTone === 'bad',
              });
              patchText(refs.modelEl, item.targetLabel || item.targetModelId || '');
              patchText(refs.timeEl, formatDetectorHistoryClock(item.createdAt));
            },
          });
        }
      }

      viewScrollbar.refresh();
    }

    function stopDetectorPollLoop() {
      if (detectorPollTimer) {
        clearTimeout(detectorPollTimer);
        detectorPollTimer = null;
      }
    }

    async function refreshDetectorStatus({ force = false } = {}) {
      try {
        const snap = await fetchModelDetectorStatus({
          force,
          knownModels: detectorSnapshot?.availableModels || [],
        });
        if (!snap) return;
        const nowRunning = Boolean(snap.running?.active);
        if (wasDetectorRunning && !nowRunning) {
          inspectedHistoryId = '';
          void fetchTelemetry({ force: true });
        }
        wasDetectorRunning = nowRunning;
        detectorSnapshot = snap;
        renderDetectorSnapshot(snap);
        if (nowRunning) {
          ensureDetectorPollLoop();
        } else {
          stopDetectorPollLoop();
        }
      } catch {
        // 静默忽略单次轮询网络抖动
      }
    }

    function ensureDetectorPollLoop() {
      if (detectorPollTimer) return;
      const tick = async () => {
        detectorPollTimer = null;
        if (!detectorSnapshot?.running?.active) return;
        await refreshDetectorStatus({ force: false });
        if (detectorSnapshot?.running?.active && !detectorPollTimer) {
          detectorPollTimer = setTimeout(tick, 850);
        }
      };
      detectorPollTimer = setTimeout(tick, 850);
    }

    const settingsInner = h(
      'div',
      {
        style: 'display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: 2px;',
      },
      [settingsSubNavBar, generalGroup, detectorGroup]
    );
    const viewScrollbar = CustomScrollbar({
      contentEl: settingsInner,
      className: 'view-pane',
    });

    let latestSettings = null;
    let latestCloudStatus = null;

    /** 将后端返回的最新设置同步至表单控件 */
    function renderSettings(settings) {
      if (!settings) return;
      draftShowUpstreamModel = Boolean(settings.showUpstreamModel);
      draftOrchestratorIdMode = normalizeClientOrchestratorIdMode(settings.orchestratorIdMode);
      draftPluginUpdateMode = normalizeClientUpdateMode(
        settings.pluginUpdateMode,
        settings.autoUpdatePlugin
      );
      draftEnableWindowOverlay = settings.enableWindowOverlay !== false;
      draftShowTopbarMulti = settings.showTopbarMultiSession !== false;
      draftTopbarSlots = normalizeClientTopbarSlots(settings.topbarCapsuleSlots);

      windowMountSelect.setValue(draftEnableWindowOverlay ? 'dual' : 'sidebar');
      stepModelSelect.setValue(draftShowUpstreamModel ? 'upstream' : 'short');
      orchestratorIdSelect.setValue(draftOrchestratorIdMode);
      autoUpdateSelect.setValue(draftPluginUpdateMode);
      syncTopbarControls();
      viewScrollbar.refresh();
    }

    /** 将云端价格表统计与插件版本对比状态同步至云端面板 */
    function renderCloudStatus(cs) {
      if (!cs) return;
      const srcLabel =
        cs.source === 'remote'
          ? '云端同步'
          : cs.source === 'local'
            ? '本地文件'
            : '内置默认';
      patchText(pricingCountVal, `${cs.modelCount || 0} 个模型`);
      patchText(
        pricingSyncSub,
        `${srcLabel} · ${formatSyncTimeText(cs.lastSyncedAtMs, cs.catalogUpdatedAt)}`
      );

      const curVer = cs.currentPluginVersion || '1.4.4';
      const latVer = cs.latestPluginVersion || curVer;
      const modeTag = cs.installMode === 'git' ? 'Git' : 'ZIP';
      patchText(versionVal, `v${curVer}`);
      if (cs.updateAvailable && draftPluginUpdateMode !== 'off') {
        patchText(versionSub, `可升级至 v${latVer} (${modeTag})`);
        patchClasses(versionSub, { 'accent-ok': true });
        patchText(updatePluginBtnText, `升级至 v${latVer}`);
        patchClasses(updatePluginBtn, { 'btn-primary': true, 'btn-secondary': false });
      } else if (draftPluginUpdateMode === 'off') {
        patchText(versionSub, `已关闭更新提醒 (${modeTag})`);
        patchClasses(versionSub, { 'accent-ok': false });
        patchText(updatePluginBtnText, cs.updateAvailable ? `手动升级 v${latVer}` : '检查更新');
        patchClasses(updatePluginBtn, { 'btn-primary': false, 'btn-secondary': true });
      } else {
        patchText(versionSub, `已是最新 (${modeTag})`);
        patchClasses(versionSub, { 'accent-ok': false });
        patchText(updatePluginBtnText, '检查更新');
        patchClasses(updatePluginBtn, { 'btn-primary': false, 'btn-secondary': true });
      }

      if (!cloudTimer && (cs.lastUpdateError || (cs.lastUpdateResult?.ok === false && cs.lastUpdateResult?.message))) {
        showCloudFeedback(cs.lastUpdateError || cs.lastUpdateResult.message, 5500);
      }
      viewScrollbar.refresh();
    }

    function applySubTabVisibility(subTab) {
      const isDetector = subTab === 'detector';
      settingsSubTabSwitch.setValue(isDetector ? 'detector' : 'general');
      patchAttr(generalGroup, 'hidden', isDetector);
      patchAttr(detectorGroup, 'hidden', !isDetector);
      if (isDetector && uiStore.getState().activeView === 'settings') {
        void refreshDetectorStatus({ force: false });
      }
      viewScrollbar.refresh();
    }

    applySubTabVisibility(uiStore.getState().settingsSubTab || 'general');

    const unsub = telemetryStore.subscribe(
      (st) => ({
        settings: st.telemetry?.settings,
        cloudStatus: st.telemetry?.cloudStatus,
        activeCascadeId: st.telemetry?.activeConversation?.cascadeId || '',
        activeModelShort: st.telemetry?.activeConversation?.activeModelShort || '',
        selectedConversationId: st.selectedConversationId || '',
        hostRouteConversationId: st.hostRouteConversationId || '',
      }),
      (slice, prevSlice) => {
        latestSettings = slice.settings;
        latestCloudStatus = slice.cloudStatus;
        renderSettings(slice.settings);
        const uiSt = uiStore.getState();
        if (uiSt.activeView === 'settings') {
          renderCloudStatus(slice.cloudStatus);
          const windowContextChanged =
            !prevSlice ||
            slice.activeCascadeId !== prevSlice.activeCascadeId ||
            slice.activeModelShort !== prevSlice.activeModelShort ||
            slice.selectedConversationId !== prevSlice.selectedConversationId ||
            slice.hostRouteConversationId !== prevSlice.hostRouteConversationId;
          if (uiSt.settingsSubTab === 'detector' && windowContextChanged && !detectorSnapshot?.running?.active) {
            void refreshDetectorStatus({ force: false });
          }
        }
      }
    );

    const unsubView = uiStore.subscribe(
      (st) => ({
        activeView: st.activeView,
        settingsSubTab: st.settingsSubTab || 'general',
      }),
      (nav, prevNav) => {
        if (!prevNav || nav.settingsSubTab !== prevNav.settingsSubTab) {
          applySubTabVisibility(nav.settingsSubTab);
        }
        if (nav.activeView === 'settings') {
          if (latestSettings) renderSettings(latestSettings);
          if (latestCloudStatus) renderCloudStatus(latestCloudStatus);
          if (nav.settingsSubTab === 'detector') {
            void refreshDetectorStatus({ force: false });
          }
          viewScrollbar.refresh();
        }
      }
    );

    onCleanup(() => {
      if (statusTimer) clearTimeout(statusTimer);
      if (topbarTimer) clearTimeout(topbarTimer);
      if (cloudTimer) clearTimeout(cloudTimer);
      if (detectorFeedbackTimer) clearTimeout(detectorFeedbackTimer);
      stopDetectorPollLoop();
      unsub();
      unsubView();
      settingsSubTabSwitch.destroy();
      windowMountSelect.destroy();
      stepModelSelect.destroy();
      orchestratorIdSelect.destroy();
      multiSessionToggle.destroy();
      for (const sel of slotSelects) {
        sel.destroy();
      }
      autoUpdateSelect.destroy();
      detectorModelSelect.destroy();
      detectorProbeModeSwitch.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: viewScrollbar.el,
      refs: {
        settingsSubTabSwitch,
        windowMountSelect,
        stepModelSelect,
        orchestratorIdSelect,
        multiSessionToggle,
        slotSelects,
        resetTopbarBtn,
        autoUpdateSelect,
        detectorModelSelect,
        detectorProbeModeSwitch,
        syncDetectorBtn,
        startDetectBtn,
        cancelDetectBtn,
        viewScrollbar,
      },
    };
  },
});
