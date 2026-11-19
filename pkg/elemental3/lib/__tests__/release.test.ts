import {
  appliedVersion, buildRelease, compareVersions, nodeFacts, offeredReleases, parseManifestRef, pickedText, preflight, preflightPassed, planPendingNodes, runningByPool, runningKubernetes, selects,
  upgradePhases, upgradeReadiness, upgradeState
} from '../release';

const c = (type: string, status: string, reason: string, message = '') => ({
  type, status, reason, message, lastTransitionTime: '2026-11-17T03:00:00Z'
});

/** The Release of lab run H after it finished (lab/t33-validation/results/run-h/release-final.yaml). */
const applied = {
  metadata: {
    name: 'demo-release', namespace: 'elemental-system', generation: 2
  },
  spec:   { registry: '192.0.2.5:5000/t33/rke2-manifest', version: '1.37.2-20.6-t33' },
  status: {
    observedGeneration: 2,
    version:            '1.37.2-20.6-t33',
    conditions:         [
      c('LCMUpgraded', 'True', 'Succeeded'), c('ManifestResolved', 'True', 'Succeeded'), c('PriorityHelmChartsUpgraded', 'True', 'Succeeded'), c('OSUpgraded', 'True', 'Succeeded', 'All nodes upgraded successfully'),
      c('KubernetesUpgraded', 'True', 'Succeeded'), c('HelmChartsUpgraded', 'True', 'Succeeded'), c('Applied', 'True', 'Succeeded'),
    ],
  },
};
const running = {
  metadata: {
    name: 'demo-release', namespace: 'elemental-system', generation: 2
  },
  spec:   { registry: '192.0.2.5:5000/t33/rke2-manifest', version: '1.37.2-20.6-t33' },
  status: {
    observedGeneration: 2,
    version:            '1.37.1-17.1-t33',
    conditions:         [
      c('LCMUpgraded', 'True', 'Succeeded'), c('ManifestResolved', 'True', 'Succeeded'), c('PriorityHelmChartsUpgraded', 'False', 'Skipped'), c('OSUpgraded', 'False', 'InProgress', 'currently applying on demo-cp-1'),
      c('KubernetesUpgraded', 'False', 'Pending'), c('HelmChartsUpgraded', 'False', 'Pending'), c('Applied', 'False', 'InProgress'),
    ],
  },
};

describe('parseManifestRef', () => {
  it('splits repository and version, also with a registry port', () => {
    expect(parseManifestRef('192.0.2.5:5000/t33/rke2-manifest:1.37.1-17.1-t33')).toStrictEqual({ registry: '192.0.2.5:5000/t33/rke2-manifest', version: '1.37.1-17.1-t33' });
    expect(parseManifestRef('oci://registry.suse.com/beta/uc/rke2/rke2-manifest:1.37.2-20.3')).toStrictEqual({ registry: 'registry.suse.com/beta/uc/rke2/rke2-manifest', version: '1.37.2-20.3' });
  });

  it('returns null without a version', () => {
    expect(parseManifestRef('192.0.2.5:5000/t33/rke2-manifest')).toBeNull();
    expect(parseManifestRef('')).toBeNull();
    expect(parseManifestRef('1.37.2-20.3')).toBeNull();
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.37.2-20.3', '1.37.1-17.1', 1],
    ['1.37.1-17.1', '1.37.2-20.3', -1],
    ['1.37.2-20.6-t33', '1.37.2-20.3-t33', 1],
    ['1.37.2-20.3', '1.37.2-20.3', 0],
    ['1.37.2-20.10', '1.37.2-20.9', 1],
    ['1.38.0-1.1', '1.37.9-99.9', 1],
    ['1.37.2', '1.37.2-20.3', 1],
    ['v1.37.2-20.3', '1.37.2-20.3', 0],
  ])('%s against %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  it('does not guess for something that is not a version', () => {
    expect(compareVersions('latest', '1.37.2-20.3')).toBeNaN();
  });
});

describe('upgradeState and upgradePhases', () => {
  it('no Release: nothing was ever applied', () => {
    expect(upgradeState(null)).toBe('none');
    expect(appliedVersion(null)).toBe('');
  });

  it('applied', () => {
    expect(upgradeState(applied)).toBe('applied');
    expect(upgradePhases(applied).map((p) => p.state)).toStrictEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(appliedVersion(applied)).toBe('1.37.2-20.6-t33');
  });

  it('running: phases in the order the Lifecycle Manager runs them, with its messages', () => {
    expect(upgradeState(running)).toBe('inProgress');
    expect(upgradePhases(running).map((p) => `${ p.type }:${ p.state }`)).toStrictEqual([
      'ManifestResolved:done', 'LCMUpgraded:done', 'PriorityHelmChartsUpgraded:skipped', 'OSUpgraded:active', 'KubernetesUpgraded:waiting', 'HelmChartsUpgraded:waiting',
    ]);
    expect(upgradePhases(running)[3].message).toBe('currently applying on demo-cp-1');
    expect(appliedVersion(running)).toBe('1.37.1-17.1-t33');
  });

  it('failed: the failing phase and its message (run G: deadline exceeded, giving up)', () => {
    const failed = JSON.parse(JSON.stringify(running));

    failed.status.conditions[3] = c('OSUpgraded', 'False', 'Failed', 'Plan failed: DeadlineExceeded. Giving up after 3 retries');
    failed.status.conditions[6] = c('Applied', 'False', 'Failed', 'OSUpgraded failed');
    expect(upgradeState(failed)).toBe('failed');
    expect(upgradePhases(failed)[3]).toMatchObject({ state: 'error', message: 'Plan failed: DeadlineExceeded. Giving up after 3 retries' });
  });

  it('just edited: the old conditions are not shown as the new upgrade\'s progress', () => {
    const edited = JSON.parse(JSON.stringify(applied));

    edited.metadata.generation = 3;
    edited.spec.version = '1.38.0-1.1';
    expect(upgradeState(edited)).toBe('pending');
    expect(upgradePhases(edited).every((p) => p.state === 'waiting')).toBe(true);
  });

  it('Applied True for an older version is not "applied" for the new one', () => {
    const stale = JSON.parse(JSON.stringify(applied));

    stale.status.version = '1.37.1-17.1-t33';
    expect(upgradeState(stale)).toBe('inProgress');
  });
});

describe('offeredReleases', () => {
  const current = { registry: '192.0.2.5:5000/t33/rke2-manifest', version: '1.37.1-17.1-t33' };
  const known = [
    {
      registry: '192.0.2.5:5000/t33/rke2-manifest', version: '1.37.1-17.1-t33', source: 'image' as const
    },
    {
      registry: '192.0.2.5:5000/t33/rke2-manifest', version: '1.37.2-20.6-t33', source: 'image' as const
    },
    {
      registry: '192.0.2.5:5000/t33/rke2-manifest', version: '1.37.2-20.6-t33', source: 'cluster' as const
    },
    {
      registry: '192.0.2.5:5000/t33/rke2-manifest', version: '1.36.9-1.1', source: 'cluster' as const
    },
    {
      registry: 'registry.example/solutions/harvester-manifest', version: '1.38.0-1.1', source: 'nodeImage' as const
    },
    {
      registry: '192.0.2.5:5000/t33/rke2-manifest', version: 'latest', source: 'cluster' as const
    },
  ];

  it('offers only newer releases of the same line, newest first, each once, and says why the others are not offered', () => {
    const out = offeredReleases(known, current);

    expect(out.filter((o) => !o.blocked).map((o) => o.version)).toStrictEqual(['1.37.2-20.6-t33']);
    expect(Object.fromEntries(out.filter((o) => o.blocked).map((o) => [o.version, o.blocked]))).toStrictEqual({
      '1.37.1-17.1-t33': 'notNewer', '1.36.9-1.1': 'notNewer', '1.38.0-1.1': 'otherLineage', latest: 'notComparable'
    });
  });

  it('offers everything when the current release is not known', () => {
    expect(offeredReleases(known, null).every((o) => !o.blocked)).toBe(true);
  });
});

describe('buildRelease', () => {
  const target = { registry: '192.0.2.5:5000/t33/rke2-manifest', version: '1.37.2-20.6-t33' };

  it('is one object with two fields', () => {
    expect(buildRelease('demo', target)).toStrictEqual({
      apiVersion: 'lifecycle.suse.com/v1alpha1',
      kind:       'Release',
      metadata:   { name: 'demo-release', namespace: 'elemental-system' },
      spec:       { version: '1.37.2-20.6-t33', registry: '192.0.2.5:5000/t33/rke2-manifest' },
    });
  });

  it('edits the cluster\'s existing Release instead of adding a second one', () => {
    expect(buildRelease('demo', target, { metadata: { name: 'first', namespace: 'elsewhere' } }).metadata).toStrictEqual({ name: 'first', namespace: 'elsewhere' });
  });
});

describe('preflight', () => {
  const node = (name: string, ready = true, unschedulable = false) => ({
    metadata: { name, labels: { 'node-role.kubernetes.io/control-plane': 'true', 'node-role.kubernetes.io/etcd': 'true' } },
    spec:     { unschedulable },
    status:   {
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      nodeInfo:   {
        kubeletVersion: 'v1.37.1+rke2r1', osImage: 'SUSE Linux Enterprise Server 16.1', kernelVersion: '6.12.0-160100.8-default'
      }
    },
  });
  const target = { registry: '192.0.2.5:5000/t33/rke2-manifest', version: '1.37.2-20.6-t33' };
  const result = (checks: any[]) => Object.fromEntries(checks.map((x) => [x.key, x.passed]));

  it('passes for a healthy cluster once the dry run was accepted', () => {
    const checks = preflight(nodeFacts([node('a'), node('b')]), null, target, '');

    expect(result(checks)).toStrictEqual({
      nodesReady: true, noneCordoned: true, noUpgradeRunning: true, newer: true, accepted: true
    });
    expect(preflightPassed(checks)).toBe(true);
  });

  it('compares with the release the cluster was created from while no Release exists', () => {
    const checks = preflight(nodeFacts([node('a')]), null, { ...target, version: '1.37.1-17.1-t33' }, '', '1.37.1-17.1-t33');

    expect(checks.find((x) => x.key === 'newer')).toMatchObject({ passed: false, params: { current: '1.37.1-17.1-t33' } });
    expect(preflightPassed(checks)).toBe(false);
  });

  it('does not pass before the dry run answered', () => {
    expect(preflightPassed(preflight(nodeFacts([node('a')]), null, target, undefined))).toBe(false);
  });

  it('shows the cluster\'s refusal', () => {
    const checks = preflight(nodeFacts([node('a')]), applied, { ...target, version: '1.37.1-17.1-t33' }, 'new version must be greater than the currently applied one ("1.37.2-20.6-t33")');

    expect(result(checks)).toMatchObject({ newer: false, accepted: false });
    expect(checks.find((x) => x.key === 'accepted')?.params.error).toContain('must be greater');
    expect(preflightPassed(checks)).toBe(false);
  });

  it('fails for a node that is not Ready or is cordoned, and names it', () => {
    const checks = preflight(nodeFacts([node('a', false), node('b', true, true)]), null, target, '');

    expect(checks[0]).toMatchObject({ passed: false, params: { nodes: 'a' } });
    expect(checks[1]).toMatchObject({ passed: false, params: { nodes: 'b' } });
    expect(preflightPassed(checks)).toBe(false);
  });

  it('fails while another upgrade is running', () => {
    expect(result(preflight(nodeFacts([node('a')]), running, { ...target, version: '1.38.0-1.1' }, '')).noUpgradeRunning).toBe(false);
  });

  it('a check that could not be made is shown as unknown and does not block', () => {
    const checks = preflight(null, null, target, '');

    expect(result(checks)).toMatchObject({ nodesReady: null, noneCordoned: null });
    expect(preflightPassed(checks)).toBe(true);
  });

  it('reads node facts', () => {
    expect(nodeFacts([node('a', true, true)])[0]).toStrictEqual({
      name: 'a', ready: true, cordoned: true, kubelet: 'v1.37.1+rke2r1', osImage: 'SUSE Linux Enterprise Server 16.1', kernel: '6.12.0-160100.8-default', roles: 'control-plane, etcd'
    });
  });
});

describe('running Kubernetes versions', () => {
  it('counts nodes per version, newest first, and ignores nodes that reported nothing', () => {
    expect(runningKubernetes(['v1.37.1+rke2r1', 'v1.37.2+rke2r1', '', 'v1.37.1+rke2r1'])).toEqual([{ version: 'v1.37.2+rke2r1', nodes: 1 }, { version: 'v1.37.1+rke2r1', nodes: 2 }]);
    expect(runningKubernetes([])).toEqual([]);
  });

  const machines = [
    {
      pool: 'c1-cp', node: 'c1-cp-a', kubelet: 'v1.37.1+rke2r1'
    },
    {
      pool: 'c1-md-0', node: 'c1-md-0-a', kubelet: 'v1.37.1+rke2r1'
    },
    {
      pool: 'c1-md-0', node: '', kubelet: ''
    },
  ];

  it('uses the version Cluster API copied from the node when the workload cluster cannot be read', () => {
    const r = runningByPool(machines, null);

    expect(r.all).toEqual([{ version: 'v1.37.1+rke2r1', nodes: 2 }]);
    expect(r.pools['c1-md-0']).toEqual([{ version: 'v1.37.1+rke2r1', nodes: 1 }]);
  });

  it('prefers what the node itself reports: after an upgrade in place the header follows the nodes, not Cluster API', () => {
    const r = runningByPool(machines, { 'c1-cp-a': 'v1.37.2+rke2r1', 'c1-md-0-a': 'v1.37.1+rke2r1' });

    expect(r.all).toEqual([{ version: 'v1.37.2+rke2r1', nodes: 1 }, { version: 'v1.37.1+rke2r1', nodes: 1 }]);
    expect(r.pools['c1-cp']).toEqual([{ version: 'v1.37.2+rke2r1', nodes: 1 }]);
  });

  it('falls back to the nodes alone when the user cannot list machines, and to nothing when neither is known', () => {
    expect(runningByPool([], { a: 'v1.37.2+rke2r1', b: 'v1.37.2+rke2r1' }).all).toEqual([{ version: 'v1.37.2+rke2r1', nodes: 2 }]);
    expect(runningByPool([], null)).toEqual({ all: [], pools: {} });
  });
});

/**
 * Ready for an upgrade. The objects are cut down from what the tenant read on the lab cluster e3p-uic-c0 on
 * 2026-11-19 (lab/ui-carry/evidence/recon/takeover.jsonl in the parity repository): before and after Rancher
 * replaced the upgrade controller the release had installed.
 */
describe('upgradeReadiness', () => {
  // Rancher's catalog labels the release it installed with its chart repository; the release's own chart has no such label
  const app = (version: string, state = 'deployed', repo = version === '110.0.0' ? 'rancher-charts' : '') => ({
    metadata: { labels: repo ? { 'catalog.cattle.io/cluster-repo-name': repo } : {} },
    spec:     { chart: { metadata: { name: 'system-upgrade-controller', version } }, info: { status: state } },
    status:   { summary: { state } },
  });
  const deployment = (image: string, generation: number, st: any) => ({
    metadata: { generation }, spec: { replicas: 1, template: { spec: { containers: [{ image }] } } }, status: st
  });
  const up = {
    observedGeneration: 2, replicas: 1, updatedReplicas: 1, availableReplicas: 1
  };
  const plan = (name: string, complete: string, applying?: string[]) => ({ metadata: { name }, status: { applying, conditions: [{ type: 'Complete', status: complete }, { type: 'Validated', status: 'True' }] } });
  const settled = {
    wantedChart: '110.0.0',
    app:         app('110.0.0'),
    deployment:  deployment('rancher/system-upgrade-controller:v0.20.1', 2, up),
    plans:       [plan('system-agent-upgrader', 'True'), plan('system-agent-upgrader-windows', 'True')],
  };
  const byKey = (r: any, key: string) => r.checks.find((c: any) => c.key === key);

  it('is ready when the chart is the one of Rancher\'s setting, the controller is rolled out and no plan is being applied', () => {
    const r = upgradeReadiness(settled);

    expect(r.state).toBe('ready');
    expect(r.checks.map((c) => c.passed)).toEqual([true, true, true]);
  });

  it('waits while the controller is still the one the release installed (the state right after the import)', () => {
    const r = upgradeReadiness({
      ...settled, app: app('109.0.2'), deployment: deployment('rancher/system-upgrade-controller:v0.19.1', 1, { ...up, observedGeneration: 1 })
    });

    expect(r.state).toBe('waiting');
    expect(byKey(r, 'chart')).toMatchObject({
      passed: false, code: 'other', params: { have: '109.0.2', want: '110.0.0' }
    });
    expect(byKey(r, 'controller').passed).toBe(true);
  });

  it('waits while no controller is installed at all, and while Helm is still installing Rancher\'s chart', () => {
    expect(upgradeReadiness({
      ...settled, app: null, deployment: null, plans: []
    }).checks.map((c) => `${ c.key }:${ c.code }`)).toEqual(['chart:missing', 'controller:missing', 'plans:ok']);
    expect(byKey(upgradeReadiness({ ...settled, app: app('110.0.0', 'pending-upgrade') }), 'chart')).toMatchObject({ passed: false, code: 'notDeployed' });
  });

  it('waits while the new controller is being rolled out', () => {
    const r = upgradeReadiness({
      ...settled,
      deployment: deployment('rancher/system-upgrade-controller:v0.20.1', 2, {
        observedGeneration: 2, replicas: 2, updatedReplicas: 1, availableReplicas: 1
      })
    });

    expect(r.state).toBe('waiting');
    expect(byKey(r, 'controller')).toMatchObject({ passed: false, code: 'rollingOut' });
    expect(byKey(upgradeReadiness({ ...settled, deployment: deployment('x', 3, up) }), 'controller').passed).toBe(false);
  });

  it('waits while Rancher\'s node agent plan is being applied, and names the plan and its nodes', () => {
    const r = upgradeReadiness({ ...settled, plans: [plan('system-agent-upgrader', 'False', ['c0-cp-a', 'c0-md-0-b']), plan('system-agent-upgrader-windows', 'True')] });

    expect(r.state).toBe('waiting');
    expect(byKey(r, 'plans')).toMatchObject({ passed: false, params: { plans: 'system-agent-upgrader (c0-cp-a, c0-md-0-b)' } });
  });

  // As read on e3p-uic-c1 at 16:19Z: the Plan, and the node label the controller sets when it is done with a node
  const agentPlan = {
    metadata: { name: 'system-agent-upgrader' },
    spec:     {
      nodeSelector: {
        matchExpressions: [{
          key: 'kubernetes.io/os', operator: 'In', values: ['linux']
        }]
      }
    },
    status: { latestHash: '1b4a1b', conditions: [{ type: 'Complete', status: 'True' }] },
  };
  const node = (name: string, labels: any) => ({ metadata: { name, labels: { 'kubernetes.io/os': 'linux', ...labels } } });

  it('waits for a node that has just joined: the Plan says Complete, the node does not carry its label yet', () => {
    const done = node('c1-cp-a', { 'plan.upgrade.cattle.io/system-agent-upgrader': '1b4a1b' });
    const joined = node('c1-md-0-new', {});
    const old = node('c1-md-0-old', { 'plan.upgrade.cattle.io/system-agent-upgrader': 'an-older-hash' });

    expect(planPendingNodes(agentPlan, [done, joined, old])).toEqual(['c1-md-0-new', 'c1-md-0-old']);
    const r = upgradeReadiness({
      ...settled, plans: [agentPlan], nodes: [done, joined]
    });

    expect(r.state).toBe('waiting');
    expect(byKey(r, 'plans')).toMatchObject({ passed: false, params: { plans: 'system-agent-upgrader (c1-md-0-new)' } });
    expect(upgradeReadiness({
      ...settled, plans: [agentPlan], nodes: [done]
    }).state).toBe('ready');
  });

  it('asks only the nodes a Plan selects, and nothing when the nodes or the hash are not known', () => {
    const windows = {
      ...agentPlan,
      metadata: { name: 'system-agent-upgrader-windows' },
      spec:     {
        nodeSelector: {
          matchExpressions: [{
            key: 'kubernetes.io/os', operator: 'In', values: ['windows']
          }]
        }
      }
    };

    expect(planPendingNodes(windows, [node('a', {})])).toEqual([]);
    expect(planPendingNodes(agentPlan, null)).toEqual([]);
    expect(planPendingNodes({ ...agentPlan, status: {} }, [node('a', {})])).toEqual([]);
    expect(selects({
      matchLabels:      { x: '1' },
      matchExpressions: [{ key: 'y', operator: 'Exists' }, { key: 'z', operator: 'DoesNotExist' }, {
        key: 'x', operator: 'NotIn', values: ['2']
      }]
    }, { x: '1', y: '' })).toBe(true);
    expect(selects({
      matchExpressions: [{
        key: 'y', operator: 'Gt', values: ['1']
      }]
    }, { y: '2' })).toBeNull();
    expect(selects(undefined, {})).toBeNull();
  });

  it('does not wait for a plan the controller has not evaluated yet when nothing else is open (a plan without conditions matches no rule)', () => {
    expect(byKey(upgradeReadiness({ ...settled, plans: [{ metadata: { name: 'new' } }] }), 'plans').passed).toBe(true);
  });

  it('is unknown, not waiting, when something could not be read; a failed check still wins', () => {
    expect(upgradeReadiness({ ...settled, wantedChart: undefined }).state).toBe('unknown');
    expect(upgradeReadiness({ ...settled, plans: undefined }).state).toBe('unknown');
    expect(upgradeReadiness({
      ...settled, deployment: undefined, app: app('109.0.2')
    }).state).toBe('waiting');
  });

  it('is unknown when the chart has the right version but Rancher did not install it (cluster created from a release that ships the same chart)', () => {
    const r = upgradeReadiness({ ...settled, app: app('110.0.0', 'deployed', '') });

    expect(byKey(r, 'chart')).toMatchObject({ passed: null, code: 'notByRancher' });
    expect(r.state).toBe('unknown');
  });

  it('waits for the Lifecycle Manager when the caller says the cluster does not serve the Release API yet', () => {
    const r = upgradeReadiness({ ...settled, releaseApi: false });

    expect(r.state).toBe('waiting');
    expect(r.checks[0]).toMatchObject({
      key: 'lifecycleManager', passed: false, code: 'missing'
    });
    expect(upgradeReadiness({ ...settled, releaseApi: true }).checks.map((c) => c.passed)).toEqual([true, true, true, true]);
    expect(upgradeReadiness(settled).checks.map((c) => c.key)).toEqual(['chart', 'controller', 'plans']);
  });

  it('passes the chart check when Rancher installs no controller of its own (empty setting)', () => {
    expect(byKey(upgradeReadiness({
      ...settled, wantedChart: '', app: app('109.0.2')
    }), 'chart')).toMatchObject({ passed: true, code: 'notManaged' });
  });

  it('blocks the pre-flight while waiting, and only warns when unknown', () => {
    const nodes = nodeFacts([{ metadata: { name: 'a' }, status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: {} } }]);
    const target = { registry: 'r/rke2-manifest', version: '1.37.2-20.3' };
    const checks = (state: any) => preflight(nodes, null, target, '', '1.37.1-17.1', state);

    expect(checks('waiting')[0]).toMatchObject({ key: 'settled', passed: false });
    expect(preflightPassed(checks('waiting'))).toBe(false);
    expect(preflightPassed(checks('ready'))).toBe(true);
    expect(checks('unknown')[0].passed).toBeNull();
    expect(preflightPassed(checks('unknown'))).toBe(true);
    expect(preflight(nodes, null, target, '', '1.37.1-17.1').map((c) => c.key)).not.toContain('settled');
  });
});

describe('pickedText', () => {
  it('reads a chosen reference, typed text, and the option object the select builds from typed text when the list has entries', () => {
    expect(pickedText('192.0.2.5:5000/e3p/rke2-manifest:1.37.2-20.3-e3p.1')).toBe('192.0.2.5:5000/e3p/rke2-manifest:1.37.2-20.3-e3p.1');
    expect(pickedText(' 1.37.2-20.3 ')).toBe('1.37.2-20.3');
    expect(pickedText({ label: '192.0.2.5:5000/e3p/rke2-manifest:1.37.2-20.3-e3p.1' })).toBe('192.0.2.5:5000/e3p/rke2-manifest:1.37.2-20.3-e3p.1');
    expect(pickedText({ value: 'r/m:1.0.0', label: '1.0.0 (node image)' })).toBe('r/m:1.0.0');
    expect(pickedText(null)).toBe('');
    expect(pickedText(undefined)).toBe('');
  });
});
