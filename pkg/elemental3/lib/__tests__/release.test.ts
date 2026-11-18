import {
  appliedVersion, buildRelease, compareVersions, nodeFacts, offeredReleases, parseManifestRef, preflight, preflightPassed, upgradePhases, upgradeState
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
