import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { backendHarness } from './backend-harness.mjs';

function buildSampleUserStatus(extraConfigs = []) {
  const clientModelConfigs = [
    {
      label: 'Gemini 4 Argon (Medium)',
      modelId: 'gemini-4-argon-medium',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M420' },
      tagTitle: 'New',
      quotaInfo: { remainingFraction: 0.85 },
    },
    {
      label: 'Gemini 4 Carbon (High)',
      modelId: 'gemini-4-carbon-high',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M429' },
      tagTitle: 'New',
      quotaInfo: { remainingFraction: 1.0 },
    },
    {
      label: 'Gemini 4 Hydrogen (Medium)',
      modelId: 'gemini-4-hydrogen-medium',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M440' },
      tagTitle: 'New',
      quotaInfo: { remainingFraction: 0.9 },
    },
    {
      label: 'Orchestrator (Carbon)',
      modelId: 'gemini-pro-orchestrator',
      modelOrAlias: { model: 'MODEL_GOOGLE_GEMINI_PRO_ORCHESTRATOR' },
      tagTitle: 'New',
      quotaInfo: { remainingFraction: 1.0 },
    },
    {
      label: 'Orchestrator (Argon)',
      modelId: 'gemini-pro-orchestrator-argon',
      modelOrAlias: { model: 'MODEL_GOOGLE_GEMINI_PRO_ORCHESTRATOR_ARGON' },
      tagTitle: 'New',
      quotaInfo: { remainingFraction: 0.85 },
    },
    {
      label: 'Gemini 3.8 Flash (Medium)',
      modelId: 'gemini-3.8-flash-medium',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M320' },
      tagTitle: 'Fast',
      quotaInfo: { remainingFraction: 1.0 },
    },
    {
      label: 'Claude Opus 5.5 (Medium)',
      modelId: 'claude-opus-5-5-medium',
      modelOrAlias: { model: 'MODEL_CLAUDE_4_OPUS' },
      tagTitle: 'New',
      quotaInfo: { remainingFraction: 0.6 },
    },
    {
      label: 'Claude Sonnet 5.5 (Medium)',
      modelId: 'claude-sonnet-5-5-medium',
      modelOrAlias: { model: 'MODEL_CLAUDE_4_SONNET' },
      tagTitle: 'New',
      quotaInfo: { remainingFraction: 0.75 },
    },
    {
      label: 'GPT-OSS 120B (Medium)',
      modelId: 'gpt-oss-120b-medium',
      modelOrAlias: { model: 'MODEL_OPENAI_GPT_OSS_120B' },
      tagTitle: 'Notice',
      quotaInfo: { remainingFraction: 1.0 },
    },
    ...extraConfigs,
  ];

  return {
    cascadeModelConfigData: {
      clientModelConfigs,
      clientModelSorts: [
        {
          groups: [
            {
              modelLabels: [
                'Gemini 4 Carbon (High)',
                'Gemini 4 Argon (Medium)',
                'Gemini 4 Hydrogen (Medium)',
                'Orchestrator (Carbon)',
                'Orchestrator (Argon)',
                'Gemini 3.8 Flash (Medium)',
                'Claude Opus 5.5 (Medium)',
                'Claude Sonnet 5.5 (Medium)',
                'GPT-OSS 120B (Medium)',
              ],
            },
          ],
        },
      ],
      defaultOverrideModelConfig: {
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M429' },
      },
    },
  };
}

function makeSyntheticIntegerReply(seedShift = 0, count = 310) {
  const nums = [];
  let x = (1234567 + seedShift * 9973) >>> 0;
  for (let i = 0; i < count; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    // Alternate between lower and upper bands in 1..355 to emulate LLM negative lag-1 autocorrelation
    const val = i % 2 === 0 ? 12 + (x % 145) : 198 + (x % 145);
    nums.push(val);
  }
  return nums.join(', ');
}

test('Model detector loads verified seed-bank.zip and maps Antigravity model IDs accurately', () => {
  const env = backendHarness({ userStatus: buildSampleUserStatus() });
  const engine = env.ensureDetectorEngine();
  assert.ok(engine, 'Seed bank engine should initialize offline');
  assert.equal(engine.source, 'builtin');
  assert.ok(engine.modelCount >= 65);

  const choices = engine.modelChoices;
  assert.equal(
    env.suggestAntigravityReference('gemini-4-carbon-high', choices, 'Gemini 4 Carbon (High)'),
    'gemini-4-carbon'
  );
  assert.equal(
    env.suggestAntigravityReference('gemini-4-argon-medium', choices, 'Gemini 4 Argon (Medium)'),
    'gemini-4-argon'
  );
  assert.equal(
    env.suggestAntigravityReference('gemini-pro-orchestrator', choices, 'Orchestrator (Carbon)'),
    'gemini-4-carbon'
  );
  assert.equal(
    env.suggestAntigravityReference(
      'gemini-pro-orchestrator-argon',
      choices,
      'Orchestrator (Argon)'
    ),
    'gemini-4-argon'
  );
  assert.equal(
    env.suggestAntigravityReference('gemini-3.8-flash-medium', choices, 'Gemini 3.8 Flash (Medium)'),
    'gemini-3.8-flash'
  );
  assert.equal(
    env.suggestAntigravityReference('claude-opus-5-5-medium', choices, 'Claude Opus 5.5 (Medium)'),
    'claude-opus-5.5'
  );
  assert.equal(
    env.suggestAntigravityReference(
      'claude-sonnet-5-5-medium',
      choices,
      'Claude Sonnet 5.5 (Medium)'
    ),
    'claude-sonnet-5.5'
  );

  // Gemini 4 Hydrogen is enrolled in the 70-model reference bank
  assert.ok(engine.modelCount >= 70, 'Updated seed bank should contain >= 70 models including Hydrogen');
  assert.equal(
    env.suggestAntigravityReference(
      'gemini-4-hydrogen-medium',
      choices,
      'Gemini 4 Hydrogen (Medium)'
    ),
    'gemini-4-hydrogen'
  );

  // Unenrolled future models return null (and never falsely claim 同源相近), then automatically match once enrolled
  assert.equal(
    env.suggestAntigravityReference(
      'gemini-4-oxygen-medium',
      choices,
      'Gemini 4 Oxygen (Medium)'
    ),
    null
  );
  const unenrolledVerdict = env.compareForDisplay(
    { primary: ['gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash'] },
    'unknown'
  );
  assert.equal(unenrolledVerdict.state, 'unset');
  const unenrolledSummary = env.formatDiagnosisSummary({
    claimed: 'gemini-4-oxygen-medium',
    claimedLabel: 'Gemini 4 Oxygen (Medium)',
    reference: 'unknown',
    topCandidate: { model: 'gemini-4-carbon', family: 'gemini', familyName: 'Gemini' },
    displayVerdict: unenrolledVerdict,
    unresolved: ['gemini-4-carbon', 'gemini-4-argon'],
    sharedDecision: 'scored',
  });
  assert.equal(unenrolledSummary.badge, '指纹识别');
  assert.match(unenrolledSummary.detail, /暂未单独收录/);

  const futureChoices = [...choices, 'gemini-4-oxygen'];
  assert.equal(
    env.suggestAntigravityReference(
      'gemini-4-oxygen-medium',
      futureChoices,
      'Gemini 4 Oxygen (Medium)'
    ),
    'gemini-4-oxygen'
  );
});

test('Model detector catalog follows clientModelSorts, tracks current window model, syncs new host models, and blocks external IDs', async () => {
  const convId = '11111111-2222-3333-4444-555555555555';
  const env = backendHarness({
    userStatus: buildSampleUserStatus(),
    summaries: {
      [convId]: {
        summary: 'Working session',
        lastModifiedTime: '2026-11-14T12:00:00Z',
        trajectoryMetadata: { projectId: 'proj-win-1' },
      },
    },
    trajectories: {
      [convId]: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { generatorModel: 'MODEL_CLAUDE_4_OPUS' },
            },
          ],
        },
      },
    },
  });

  // 1. Active conversation priority -> Claude Opus 5.5 (Medium)
  const statusFromConv = await env.getModelDetectorStatus({ conversationId: convId, force: true });
  assert.equal(statusFromConv.availableModels[0].modelId, 'gemini-4-carbon-high');
  assert.equal(statusFromConv.availableModels.length, 9);
  assert.equal(statusFromConv.currentWindowModel.modelId, 'claude-opus-5-5-medium');
  assert.equal(statusFromConv.currentWindowModel.source, 'active_conversation');

  // 2. Live composer picker hint overrides when user switches picker before sending a message
  const statusFromHint = await env.getModelDetectorStatus({
    conversationId: convId,
    composerModelHint: 'Gemini 4 Argon Medium New',
  });
  assert.equal(statusFromHint.currentWindowModel.modelId, 'gemini-4-argon-medium');
  assert.equal(statusFromHint.currentWindowModel.source, 'window_picker');

  // 3. Fallback to account defaultOverrideModelConfig when conversation has 0 steps
  const emptyConvId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  env.state.summaries = {};
  env.state.trajectories[emptyConvId] = { trajectory: { steps: [] } };
  const statusFromDefault = await env.getModelDetectorStatus({
    conversationId: emptyConvId,
    force: true,
  });
  assert.equal(statusFromDefault.currentWindowModel.modelId, 'gemini-4-carbon-high');
  assert.equal(statusFromDefault.currentWindowModel.source, 'account_default');

  // 4. Dynamic model sync when Antigravity adds a new model
  env.state.userStatus = buildSampleUserStatus([
    {
      label: 'Gemini 4.5 Ultra (High)',
      modelId: 'gemini-4-5-ultra-high',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M499' },
      quotaInfo: { remainingFraction: 1.0 },
    },
  ]);
  const synced = await env.getModelDetectorStatus({ force: true });
  assert.equal(synced.availableModels.length, 10);
  assert.ok(synced.availableModels.some((m) => m.modelId === 'gemini-4-5-ultra-high'));

  // 5. Rejects non-Antigravity external model IDs
  const rejected = await env.dispatchBridgeApiRequest('/api/model-detector/detect', 'POST', {
    modelId: 'deepseek-v4-flash-external',
  });
  assert.equal(rejected.status, 400);
  const rejBody = JSON.parse(rejected.body);
  assert.equal(rejBody.ok, false);
  assert.match(rejBody.error, /反重力/);
});

test('Probe conversations never hijack activeConversation or conversations list in telemetry', async () => {
  const realConvId = '22222222-3333-4444-5555-666666666666';
  const probeConvId = '99999999-8888-7777-6666-555555555555';

  const env = backendHarness({
    userStatus: buildSampleUserStatus(),
    summaries: {
      [realConvId]: {
        annotations: { title: 'Real user task' },
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-14T10:00:00Z',
      },
      [probeConvId]: {
        annotations: { title: '[模型检测探针] Gemini 4 Carbon (High) #1' },
        status: 'CASCADE_RUN_STATUS_RUNNING',
        lastModifiedTime: '2026-11-14T12:30:00Z',
      },
    },
    trajectories: {
      [realConvId]: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-11-14T10:00:01Z',
                completedAt: '2026-11-14T10:00:03Z',
                generatorModel: 'MODEL_PLACEHOLDER_M429',
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M429',
                  inputTokens: '500',
                  outputTokens: '120',
                },
              },
              plannerResponse: { response: 'Real reply' },
            },
          ],
        },
      },
      [probeConvId]: {
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: '2026-11-14T12:30:01Z',
                completedAt: '2026-11-14T12:30:03Z',
                generatorModel: 'MODEL_PLACEHOLDER_M429',
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M429',
                  inputTokens: '100',
                  outputTokens: '300',
                },
              },
              plannerResponse: { response: makeSyntheticIntegerReply(1) },
            },
          ],
        },
      },
    },
  });

  const payload = await env.buildTelemetryPayloadInternal('', true, { range: 'all' });
  assert.equal(payload.activeConversation.cascadeId, realConvId);
  assert.ok(!payload.conversations.some((c) => c.cascadeId === probeConvId));
  assert.ok(!payload.runningConversations.some((c) => c.cascadeId === probeConvId));
  // Accounting still retains probe tokens in total consumption
  assert.equal(payload.consumption.account.calls, 2);

  // Even if hostRoute / requestedConvId explicitly points to a probe UUID, it falls back to realConvId
  const payloadWithProbeReq = await env.buildTelemetryPayloadInternal(probeConvId, false, {
    range: 'all',
  });
  assert.equal(payloadWithProbeReq.activeConversation.cascadeId, realConvId);
  assert.ok(!payloadWithProbeReq.conversations.some((c) => c.cascadeId === probeConvId));

  const detectorStatusWithProbeRoute = await env.getModelDetectorStatus({
    conversationId: probeConvId,
    force: true,
  });
  assert.equal(detectorStatusWithProbeRoute.currentWindowModel.modelId, 'gemini-4-carbon-high');
});

test('Fast same-weights probe routing accelerates High/XHigh via Low sibling, uses minimal profile, handles 2/3 quorum, and cleans up temporary probes', async () => {
  const trajectories = {};
  const spawnedArgs = [];
  let probeCounter = 0;

  const env = backendHarness({
    userStatus: buildSampleUserStatus([
      {
        label: 'Gemini 4 Hydrogen (XHigh)',
        modelId: 'gemini-4-hydrogen-xhigh',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' },
        quotaInfo: { remainingFraction: 0.95 },
      },
      {
        label: 'Gemini 4 Hydrogen (Low)',
        modelId: 'gemini-4-hydrogen-low',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M527' },
        quotaInfo: { remainingFraction: 0.95 },
      },
    ]),
    trajectories,
    execFileImpl: (_cmd, args, _opts, cb) => {
      spawnedArgs.push(args);
      probeCounter += 1;
      // Simulate 1st probe failing to verify 2/3 quorum resilience + CancelCascadeInvocation
      if (probeCounter === 1) {
        const failCid = '00000000-0000-4000-9000-000000000001';
        trajectories[failCid] = {
          trajectory: {
            steps: [
              {
                type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                status: 'CORTEX_STEP_STATUS_ERROR',
                error: { message: 'transient upstream rate limit' },
              },
            ],
          },
        };
        cb(null, JSON.stringify({ response: { newConversation: { conversationId: failCid } } }), '');
        return;
      }
      const cid = `00000000-0000-4000-9000-${String(probeCounter).padStart(12, '0')}`;
      trajectories[cid] = {
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { generatorModel: 'MODEL_PLACEHOLDER_M527' },
              plannerResponse: { response: makeSyntheticIntegerReply(probeCounter + 10, 312) },
            },
          ],
        },
      };
      cb(null, JSON.stringify({ response: { newConversation: { conversationId: cid } } }), '');
    },
  });

  // Verify Orchestrator never crosses model family boundaries
  const statusSnap = await env.getModelDetectorStatus({ force: true });
  const orchTarget = statusSnap.availableModels.find((m) => m.modelId === 'gemini-pro-orchestrator');
  const orchResolved = env.resolveProbeExecutionModel(
    orchTarget,
    statusSnap.availableModels,
    'fast'
  );
  assert.equal(orchResolved.fastTierRouted, false);
  assert.equal(orchResolved.executionModel.modelId, 'gemini-pro-orchestrator');

  // Run fast mode on Gemini 4 Hydrogen (XHigh) -> routes probes to gemini-4-hydrogen-low with --profile=model-detector-probe
  const startFast = await env.startAntigravityModelDetection({
    modelId: 'gemini-4-hydrogen-xhigh',
    probeMode: 'fast',
  });
  assert.equal(startFast.ok, true);

  let doneSnap = null;
  for (let i = 0; i < 40; i += 1) {
    const st = await env.getModelDetectorStatus({});
    if (!st.running && st.latestResult?.id === startFast.runId) {
      doneSnap = st;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  assert.ok(doneSnap, 'Fast 2/3 quorum run should finish');
  assert.equal(doneSnap.latestResult.ok, true);
  assert.equal(doneSnap.latestResult.fastTierRouted, true);
  assert.equal(doneSnap.latestResult.targetModelId, 'gemini-4-hydrogen-xhigh');
  assert.equal(doneSnap.latestResult.executionModelId, 'gemini-4-hydrogen-low');
  assert.equal(doneSnap.latestResult.usedOutputs, 2);
  // Must NOT falsely report hostFallback when M527 (Hydrogen Low) responds for M528 (Hydrogen XHigh)
  assert.equal(doneSnap.latestResult.hostFallback, null);

  // Verify --profile=model-detector-probe & --model=gemini-4-hydrogen-low were passed
  assert.ok(spawnedArgs.every((a) => a.includes('--profile=model-detector-probe')));
  assert.ok(spawnedArgs.every((a) => a.includes('--model=gemini-4-hydrogen-low')));

  // Verify temporary probe conversations were cleaned up via DeleteCascadeTrajectory
  const deleteCalls = env.state.calls.filter((c) => c.method === 'DeleteCascadeTrajectory');
  assert.ok(deleteCalls.length >= 3, 'All temporary probe trajectories should be deleted after archiving');
});

test('Async 3-probe detection self-heals project_id mismatch, computes diagnosis, and detects silent host fallback', async () => {
  const trajectories = {};
  let probeCounter = 0;
  let simulatedActualModelKey = 'MODEL_PLACEHOLDER_M429';
  const seenEnvProjectIds = [];

  const env = backendHarness({
    userStatus: buildSampleUserStatus(),
    trajectories,
    execFileImpl: (_cmd, args, opts, cb) => {
      const proj = opts?.env?.ANTIGRAVITY_PROJECT_ID || '';
      seenEnvProjectIds.push(proj);
      if (!proj) {
        cb(
          null,
          JSON.stringify({
            error:
              'failed to start conversation: rpc error: code = PermissionDenied desc = permission_denied: source project_id "proj-auto-heal-77" does not match target project_id ""',
          }),
          ''
        );
        return;
      }
      probeCounter += 1;
      const cid = `00000000-0000-4000-8000-${String(probeCounter).padStart(12, '0')}`;
      trajectories[cid] = {
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { generatorModel: simulatedActualModelKey },
              plannerResponse: { response: makeSyntheticIntegerReply(probeCounter, 310) },
            },
          ],
        },
      };
      cb(null, JSON.stringify({ response: { newConversation: { conversationId: cid } } }), '');
    },
  });

  // Run 1: Normal run using default current window model (__current__ -> Gemini 4 Carbon (High))
  const startRes = await env.startAntigravityModelDetection({ modelId: '__current__' });
  assert.equal(startRes.ok, true);
  assert.equal(startRes.started, true);

  let finalStatus = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const st = await env.getModelDetectorStatus({});
    if (!st.running && st.latestResult?.id === startRes.runId) {
      finalStatus = st;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  assert.ok(finalStatus, 'Async 3-probe run should complete');
  assert.ok(seenEnvProjectIds.includes('proj-auto-heal-77'), 'Should retry with healed project_id');
  assert.equal(
    finalStatus.latestResult.ok,
    true,
    `Expected ok=true, got detail: ${finalStatus.latestResult?.summary?.detail}`
  );
  assert.equal(finalStatus.latestResult.usedCurrentWindowDefault, true);
  assert.equal(finalStatus.latestResult.targetModelId, 'gemini-4-carbon-high');
  assert.equal(finalStatus.latestResult.usedOutputs, 3);
  assert.ok(finalStatus.latestResult.totalNumbers >= 900);
  assert.ok(finalStatus.latestResult.topCandidates.length >= 3);

  // Run 2: Host quota fallback (requested Carbon M429, host silently executes on Flash M320)
  simulatedActualModelKey = 'MODEL_PLACEHOLDER_M320';
  const fallbackStart = await env.startAntigravityModelDetection({
    modelId: 'gemini-4-carbon-high',
  });
  let fallbackStatus = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const st = await env.getModelDetectorStatus({});
    if (!st.running && st.latestResult?.id === fallbackStart.runId) {
      fallbackStatus = st;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  assert.ok(fallbackStatus);
  assert.equal(fallbackStatus.latestResult.verdictState, 'fallback');
  assert.equal(fallbackStatus.latestResult.summary.badge, '宿主回退');
  assert.equal(fallbackStatus.latestResult.hostFallback.occurred, true);
  assert.match(fallbackStatus.latestResult.summary.headline, /Gemini 3\.8 Flash/);
  assert.equal(fallbackStatus.history.length, 2);
});

test('syncDetectorBank verifies SHA-256 hashes on remote manifest updates and rejects tampered assets', async () => {
  let manifestDownloads = 0;
  let assetDownloads = 0;
  let tamperDetectorSha = false;

  const baseEnv = backendHarness({});
  const seedManifest = baseEnv.ensureDetectorEngine().manifest;

  const env = backendHarness({
    userStatus: buildSampleUserStatus(),
    remoteFetch: async (url) => {
      const u = String(url);
      if (u.includes('raw.githubusercontent.com')) {
        return { ok: false, status: 404 };
      }
      if (u.endsWith('/asset-manifest.json')) {
        manifestDownloads += 1;
        if (!tamperDetectorSha) {
          return { ok: true, json: async () => seedManifest };
        }
        const mutated = JSON.parse(JSON.stringify(seedManifest));
        mutated.assets['rules.json'].sha256 = 'f'.repeat(64);
        delete mutated.assets['rules.json'].gzip;
        return { ok: true, json: async () => mutated };
      }
      assetDownloads += 1;
      return {
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('{"tampered":true}').buffer,
      };
    },
  });

  // Case 1: Manifest matches local seed bank -> 0 asset downloads, marked upToDate
  const syncSame = await env.syncDetectorBank({ force: true });
  assert.equal(manifestDownloads, 1);
  assert.equal(assetDownloads, 0);
  assert.equal(syncSame.upToDate, true);
  assert.equal(syncSame.updated, false);

  // Case 2: Tampered SHA-256 is rejected and existing engine stays healthy
  tamperDetectorSha = true;
  const syncTampered = await env.syncDetectorBank({ force: true });
  assert.equal(syncTampered.updated, false);
  assert.match(syncTampered.error, /哈希不一致/);
  assert.equal(env.ensureDetectorEngine().ready ?? true, true);
});

test('Frontend bundle adheres to zero-emoji / zero-hex standards and wires SettingsView 模型检测 sub-tab', () => {
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

  // Zero hardcoded hex colors in compiled styles.css
  const hexMatches = stylesCss.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hexMatches, [], 'styles.css must contain zero hardcoded hex colors');

  // Zero emoji characters in SettingsView.js and model-detector*.mjs
  const emojiRe = /\p{Extended_Pictographic}/u;
  for (const rel of [
    '../src/views/SettingsView.js',
    '../src/icons/svgRegistry.js',
    '../backend/model-detector.mjs',
    '../backend/model-detector-core.mjs',
  ]) {
    const content = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.equal(emojiRe.test(content), false, `${rel} must contain zero emojis`);
  }

  // Verify SettingsView includes sub-tab options and model detector endpoints in compiled app.js
  assert.match(appJs, /常规偏好/);
  assert.match(appJs, /模型检测/);
  assert.match(appJs, /模型真身检测/);
  assert.match(appJs, /更新指纹库/);
  assert.match(appJs, /\/api\/model-detector\/status/);
  assert.match(appJs, /\/api\/model-detector\/detect/);
  assert.match(appJs, /\/api\/model-detector\/sync/);
});

test('Regression: archived probe ledger keeps email accountName so deleted probe tokens remain in consumption totals', async () => {
  const userStatus = buildSampleUserStatus();
  userStatus.email = 'dev@example.com';
  userStatus.name = 'Dev Display Name';

  const trajectories = {};
  let counter = 0;
  const env = backendHarness({
    userStatus,
    trajectories,
    execFileImpl: (_cmd, _args, _opts, cb) => {
      counter += 1;
      const cid = `00000000-0000-4000-9999-${String(counter).padStart(12, '0')}`;
      const nowIso = new Date().toISOString();
      trajectories[cid] = {
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: nowIso,
                finishedGeneratingAt: new Date(Date.now() + 1500).toISOString(),
                generatorModel: 'MODEL_PLACEHOLDER_M429',
                modelUsage: {
                  model: 'MODEL_PLACEHOLDER_M429',
                  inputTokens: '1200',
                  cacheReadTokens: '0',
                  outputTokens: '350',
                },
              },
              plannerResponse: { response: makeSyntheticIntegerReply(counter, 310) },
            },
          ],
        },
      };
      cb(null, JSON.stringify({ response: { newConversation: { conversationId: cid } } }), '');
    },
  });

  const startRes = await env.startAntigravityModelDetection({ modelId: 'gemini-4-carbon-high' });
  assert.equal(startRes.ok, true);

  let finalStatus = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const st = await env.getModelDetectorStatus({});
    if (!st.running && st.latestResult?.id === startRes.runId) {
      finalStatus = st;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(finalStatus?.latestResult?.ok);

  const payload = await env.buildTelemetryPayloadInternal('', false, { range: 'today' });
  assert.equal(
    payload.conversations.some((c) => String(c.title || '').includes('[模型检测探针]')),
    false,
    'Probe conversations stay hidden from visible conversation list'
  );
  assert.equal(payload.consumption.account.calls, 3, 'All 3 archived probe calls counted');
  assert.equal(
    payload.consumption.account.totalTokens,
    3 * (1200 + 350),
    'Archived probe input + output tokens preserved under matching email accountName'
  );
});

test('resolveAgentApiBinary resolves macOS app bundle, Linux install, and standalone agy CLI paths', () => {
  const macEnv = backendHarness({});
  const macLsArm = path.join('/Applications/Antigravity.app', 'Contents', 'Resources', 'bin', 'language_server_macos_arm');
  macEnv.state.virtualFiles.set(macLsArm.replace(/\\/g, '/'), Buffer.from('stub'));
  assert.deepEqual(
    JSON.parse(JSON.stringify(macEnv.resolveAgentApiBinary({ platform: 'darwin', homeDir: '/Users/dev', env: {} }))),
    { cmd: macLsArm, prefixArgs: ['agentapi'] }
  );

  const linuxEnv = backendHarness({});
  const linuxLs = path.join('/opt/Antigravity', 'resources', 'bin', 'language_server');
  linuxEnv.state.virtualFiles.set(linuxLs.replace(/\\/g, '/'), Buffer.from('stub'));
  assert.deepEqual(
    JSON.parse(JSON.stringify(linuxEnv.resolveAgentApiBinary({ platform: 'linux', homeDir: '/home/dev', env: {} }))),
    { cmd: linuxLs, prefixArgs: ['agentapi'] }
  );

  const cliFallbackEnv = backendHarness({});
  const agyCli = '/opt/homebrew/bin/agy';
  cliFallbackEnv.state.virtualFiles.set(agyCli, Buffer.from('stub'));
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        cliFallbackEnv.resolveAgentApiBinary({
          platform: 'darwin',
          homeDir: '/Users/dev',
          env: {},
          desktopAppPath: null,
          agyExecutablePath: agyCli,
        })
      )
    ),
    { cmd: agyCli, prefixArgs: ['agentapi'] }
  );
});
