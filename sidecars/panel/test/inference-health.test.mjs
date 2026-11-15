import assert from 'node:assert/strict';
import test from 'node:test';
import { backendHarness } from './backend-harness.mjs';
import { extractModelSteps } from '../speed-metrics.mjs';

function mkUserStep(text, createdAt, stepIndex = 0) {
  return {
    stepIndex,
    type: 'CORTEX_STEP_TYPE_USER_INPUT',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt,
      sourceTrajectoryStepInfo: { stepIndex },
    },
    userInput: { userResponse: text },
  };
}

function mkPlannerStep({
  stepIndex,
  createdAt,
  finishedGeneratingAt,
  model = 'MODEL_PLACEHOLDER_M429',
  modelDisplayName = 'Gemini 4 Carbon (High)',
  inputTokens = 1000,
  cacheReadTokens = 0,
  thinkingTokens = 400,
  responseTokens = 600,
  ttft = '2s',
  thinkingDuration = '4s',
  response = 'done',
  thinking = 'reasoning trace',
  toolCalls = [],
} = {}) {
  const out = thinkingTokens + responseTokens;
  return {
    status: 'CORTEX_STEP_STATUS_DONE',
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: {
      createdAt,
      finishedGeneratingAt,
      sourceTrajectoryStepInfo: { stepIndex },
      modelUsage: {
        model,
        inputTokens: String(inputTokens),
        cacheReadTokens: String(cacheReadTokens),
        outputTokens: String(out),
        thinkingOutputTokens: String(thinkingTokens),
        responseOutputTokens: String(responseTokens),
      },
      generatorMetadata: [
        {
          chatModel: {
            model,
            modelDisplayName,
            timeToFirstToken: ttft,
            streamingDuration: '3s',
          },
        },
      ],
    },
    plannerResponse: {
      response,
      thinking,
      thinkingDuration,
      toolCalls,
    },
  };
}

function mkToolResult(name, content = 'ok', status = 'CORTEX_STEP_STATUS_DONE', extra = {}) {
  return {
    type: 'GENERIC',
    status,
    content,
    metadata: { toolCall: { name } },
    ...extra,
  };
}

test('Inference health stays healthy across idle gaps >= 300s, compactions, post-edit reads, npm test failures, and clean worker handoff', async () => {
  const rawSteps = [
    mkUserStep('读取代码分片并跑单测', '2026-01-01T00:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T00:00:01Z',
      finishedGeneratingAt: '2026-01-01T00:00:10Z',
      cacheReadTokens: 120000,
      toolCalls: [
        { name: 'read_file', args: { Path: '/repo/src/app.js', StartLine: 1, EndLine: 200 } },
        { name: 'read_file', args: { Path: '/repo/src/app.js', StartLine: 201, EndLine: 400 } },
      ],
    }),
    mkToolResult('read_file', 'lines 1-200'),
    mkToolResult('read_file', 'lines 201-400'),

    // Edit file -> read back same range to verify edit (must NOT count as amnesia)
    mkPlannerStep({
      stepIndex: 4,
      createdAt: '2026-01-01T00:00:12Z',
      finishedGeneratingAt: '2026-01-01T00:00:22Z',
      cacheReadTokens: 124000,
      toolCalls: [
        { name: 'edit_file', args: { Path: '/repo/src/app.js', Target: 'a', Replacement: 'b' } },
      ],
    }),
    mkToolResult('edit_file', 'Made 1 replacement'),
    mkPlannerStep({
      stepIndex: 6,
      createdAt: '2026-01-01T00:00:24Z',
      finishedGeneratingAt: '2026-01-01T00:00:32Z',
      cacheReadTokens: 126000,
      toolCalls: [
        { name: 'read_file', args: { Path: '/repo/src/app.js', StartLine: 1, EndLine: 200 } },
        { name: 'run_command', args: { CommandLine: 'npm test' } },
      ],
    }),
    mkToolResult('read_file', 'verified lines 1-200'),
    mkToolResult('run_command', 'AssertionError: expected 1 to equal 2', 'CORTEX_STEP_STATUS_ERROR'),

    // Long idle gap >= 300s causing legitimate cacheReadTokens=0 TTL expiry
    mkUserStep('继续', '2026-01-01T00:06:00Z', 9),
    mkPlannerStep({
      stepIndex: 10,
      createdAt: '2026-01-01T00:06:01Z',
      finishedGeneratingAt: '2026-01-01T00:06:10Z',
      inputTokens: 130000,
      cacheReadTokens: 0,
      toolCalls: [{ name: 'exit_plan_mode', args: { reason: 'execute' } }],
    }),
    mkToolResult('exit_plan_mode', 'Plan mode is off'),

    // Clean execution worker step after compaction must not trigger alert
    {
      stepIndex: 12,
      type: 'CORTEX_STEP_TYPE_CHECKPOINT',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        createdAt: '2026-01-01T00:06:12Z',
        finishedGeneratingAt: '2026-01-01T00:06:16Z',
        sourceTrajectoryStepInfo: { stepIndex: 12 },
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M429',
          inputTokens: '40000',
          cacheReadTokens: '0',
          outputTokens: '300',
        },
      },
    },
    {
      stepIndex: 13,
      type: 'SYSTEM_MESSAGE',
      content: 'Plan mode is off: this turn runs on the execution model.',
    },
    mkPlannerStep({
      stepIndex: 14,
      createdAt: '2026-01-01T00:06:20Z',
      finishedGeneratingAt: '2026-01-01T00:06:26Z',
      inputTokens: 42000,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      thinking: '',
      responseTokens: 500,
      toolCalls: [
        { name: 'read_file', args: { Path: '/repo/src/app.js', StartLine: 1, EndLine: 200 } },
      ],
    }),
    mkToolResult('read_file', 'lines 1-200 post compaction'),
  ];

  const h = backendHarness({
    trajectories: { clean1: { trajectory: { steps: rawSteps }, numTotalSteps: rawSteps.length } },
    summaries: { clean1: { stepCount: rawSteps.length, lastModifiedTime: '2026-01-01T00:06:26Z', status: 'IDLE', annotations: { title: 'Clean Session' } } },
  });
  const payload = await h.buildTelemetryPayloadInternal('clean1');
  const health = payload.activeConversation.inferenceHealth;
  assert.equal(health.activeAlert, null, 'Confounder events must produce zero false alerts');
  assert.equal(health.anomalyStepCount, 0);
  assert.equal(health.anomalyTurnCount, 0);
  for (const st of payload.activeConversation.recentSteps) {
    assert.equal(st.isCacheAnomaly, false);
    assert.equal(st.turnHealthLevel, 'healthy');
  }
});

test('Inference health detects upstream HTTP2 timeout + short-interval prefix rewind + burst underthinking', async () => {
  const rawSteps = [
    mkUserStep('常规规划修改', '2026-01-01T01:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T01:00:01Z',
      finishedGeneratingAt: '2026-01-01T01:00:12Z',
      inputTokens: 3000,
      cacheReadTokens: 274533,
      thinkingTokens: 800,
      responseTokens: 500,
    }),
    mkUserStep('开始修改视图与样式', '2026-01-01T01:00:18Z', 2),
    // Upstream timeout event before retry succeeds
    {
      stepIndex: 3,
      type: 'ERROR_MESSAGE',
      status: 'DONE',
      error: 'API error (attempt 1): Post "https://daily-cloudcode-pa.googleapis.com": http2: timeout awaiting response headers',
    },
    // Short-interval prefix rewind + burst output with zero/collapsed thinking
    mkPlannerStep({
      stepIndex: 4,
      createdAt: '2026-01-01T01:00:35Z',
      finishedGeneratingAt: '2026-01-01T01:00:55Z',
      inputTokens: 14764,
      cacheReadTokens: 264595,
      thinkingTokens: 0,
      responseTokens: 6227,
      thinkingDuration: '0.1s',
      thinking: '',
      toolCalls: [
        { name: 'edit_file', args: { Path: '/repo/src/StepsDetailView.js', Target: 'a', Replacement: 'b' } },
      ],
    }),
    mkToolResult('edit_file', 'ok'),
  ];

  const h = backendHarness({
    trajectories: { drift1: { trajectory: { steps: rawSteps }, numTotalSteps: rawSteps.length } },
    summaries: { drift1: { stepCount: rawSteps.length, lastModifiedTime: '2026-01-01T01:00:55Z', status: 'IDLE', annotations: { title: 'Drift Session' } } },
  });
  const payload = await h.buildTelemetryPayloadInternal('drift1');
  const health = payload.activeConversation.inferenceHealth;
  assert.ok(health.activeAlert, 'Compound drift + timeout + zero-thinking should raise activeAlert');
  assert.equal(health.activeAlert.category, 'replica_drift');
  assert.equal(health.activeAlert.anchorStepIndex, 4);
  assert.ok(health.activeAlert.primaryAction.copyText.includes('#4'));
  const step4 = payload.activeConversation.recentSteps.find((s) => s.stepIndex === 4);
  assert.equal(step4.isCacheAnomaly, true);
  assert.equal(step4.stepHealthBadge, '切流');
  assert.ok(step4.turnHealthLevel === 'warn' || step4.turnHealthLevel === 'critical');
});

test('Inference health attributes long-context amnesia + edit failure to context_rot with /compact action', async () => {
  const rawSteps = [
    mkUserStep('在超大上下文里定位修改', '2026-01-01T02:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T02:00:01Z',
      finishedGeneratingAt: '2026-01-01T02:00:10Z',
      inputTokens: 5000,
      cacheReadTokens: 215000,
      thinkingTokens: 500,
      responseTokens: 400,
      toolCalls: [
        { name: 'read_file', args: { Path: '/repo/src/core.js', StartLine: 1, EndLine: 180 } },
      ],
    }),
    mkToolResult('read_file', 'lines 1-180'),
    // Re-read exact same unchanged file + fail edit_file match under 220k context
    mkPlannerStep({
      stepIndex: 3,
      createdAt: '2026-01-01T02:00:14Z',
      finishedGeneratingAt: '2026-01-01T02:00:25Z',
      inputTokens: 6000,
      cacheReadTokens: 218000,
      thinkingTokens: 450,
      responseTokens: 500,
      toolCalls: [
        { name: 'read_file', args: { Path: '/repo/src/core.js', StartLine: 1, EndLine: 180 } },
        { name: 'edit_file', args: { Path: '/repo/src/core.js', Target: 'missing snippet', Replacement: 'fixed' } },
      ],
    }),
    mkToolResult('read_file', 'lines 1-180 again'),
    mkToolResult('edit_file', 'Encountered error in tool execution: Target not found', 'CORTEX_STEP_STATUS_ERROR'),
  ];

  const h = backendHarness({
    trajectories: { rot1: { trajectory: { steps: rawSteps }, numTotalSteps: rawSteps.length } },
    summaries: { rot1: { stepCount: rawSteps.length, lastModifiedTime: '2026-01-01T02:00:25Z', status: 'IDLE', annotations: { title: 'Context Rot' } } },
  });
  const payload = await h.buildTelemetryPayloadInternal('rot1');
  const health = payload.activeConversation.inferenceHealth;
  assert.ok(health.activeAlert);
  assert.equal(health.activeAlert.category, 'context_rot');
  assert.equal(health.activeAlert.primaryAction.copyText, '/compact');
  assert.equal(health.activeAlert.secondaryAction.kind, 'copy');
});

test('Inference health identifies execution-worker handoff faults and confirms git rollback turns', () => {
  const rawSteps = [
    mkUserStep('设计并执行修改', '2026-01-01T03:00:00Z', 0),
    mkPlannerStep({
      stepIndex: 1,
      createdAt: '2026-01-01T03:00:01Z',
      finishedGeneratingAt: '2026-01-01T03:00:10Z',
      inputTokens: 1000,
      cacheReadTokens: 40000,
      thinkingTokens: 500,
      responseTokens: 400,
      toolCalls: [{ name: 'exit_plan_mode', args: {} }],
    }),
    mkToolResult('exit_plan_mode', 'ok'),
    {
      stepIndex: 3,
      type: 'SYSTEM_MESSAGE',
      content: 'Plan mode is off: this turn runs on the execution model.',
    },
    mkPlannerStep({
      stepIndex: 4,
      createdAt: '2026-01-01T03:00:15Z',
      finishedGeneratingAt: '2026-01-01T03:00:25Z',
      inputTokens: 42000,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      responseTokens: 600,
      thinking: '',
      toolCalls: [
        { name: 'edit_file', args: { Path: '/repo/src/ui.js', Target: 'wrong', Replacement: 'x' } },
        { name: 'run_command', args: { CommandLine: 'python -c "import json; json.loads(\'bad)"' } },
      ],
    }),
    mkToolResult('edit_file', 'Target not found', 'CORTEX_STEP_STATUS_ERROR'),
    mkToolResult('run_command', 'SyntaxError: unterminated string literal', 'CORTEX_STEP_STATUS_ERROR'),
  ];

  const h = backendHarness();
  const steps = extractModelSteps(rawSteps, []);
  const diagBeforeRollback = h.evaluateAgentInferenceHealth(steps);
  assert.ok(diagBeforeRollback.activeAlert);
  assert.equal(diagBeforeRollback.activeAlert.category, 'worker_handoff');

  // Now append explicit user interruption + git checkout rollback in next turn
  const withRollback = [
    ...rawSteps,
    mkUserStep('做法很糟糕，打断并基于此前重新调整', '2026-01-01T03:01:00Z', 7),
    mkPlannerStep({
      stepIndex: 8,
      createdAt: '2026-01-01T03:01:02Z',
      finishedGeneratingAt: '2026-01-01T03:01:08Z',
      inputTokens: 2000,
      cacheReadTokens: 42000,
      thinkingTokens: 300,
      responseTokens: 250,
      toolCalls: [
        { name: 'run_command', args: { CommandLine: 'git checkout HEAD -- src/ui.js' } },
      ],
    }),
    mkToolResult('run_command', 'Updated 1 path from index'),
  ];
  const stepsWithRollback = extractModelSteps(withRollback, []);
  const diagAfterRollback = h.evaluateAgentInferenceHealth(stepsWithRollback);
  const rolledTurnDiag = diagAfterRollback.turnDiagnoses.find((d) => d.turnIndex === 1);
  assert.ok(rolledTurnDiag);
  assert.equal(rolledTurnDiag.level, 'critical');
  assert.ok(rolledTurnDiag.score <= 25);
  assert.equal(diagAfterRollback.activeAlert, null, 'Healthy recovery turn clears active topbar alert');
});
