import {
  clusterEvents, clusterState, conditionRows, currentPhase, isFailure, isProvisioned, machineRows, poolRows, problems, progressPhases
} from '../status';

const T = (type: string, extra: any = {}) => ({
  type, status: 'True', reason: 'Ok', message: '', ...extra
});
const F = (type: string, reason: string, message = '') => ({
  type, status: 'False', reason, message
});

function cluster(conditions: any[] = [], extra: any = {}) {
  return {
    metadata: {
      name: 'demo', namespace: 'ns1', creationTimestamp: '2026-11-18T00:00:00Z'
    },
    spec:   { controlPlaneRef: { name: 'demo-cp' }, infrastructureRef: { name: 'demo' } },
    status: { conditions },
    ...extra,
  };
}
const cp = (replicas: number, ready: number, conditions: any[] = [], extra: any = {}) => ({
  metadata: { name: 'demo-cp' },
  spec:     {
    replicas, version: 'v1.37.1+rke2r1', machineTemplate: { spec: { infrastructureRef: { name: 'demo-cp' } } }
  },
  status: {
    replicas: ready, readyReplicas: ready, conditions, ...extra
  }
});
const md = (replicas: number, ready: number, conditions: any[] = []) => ({
  metadata: { name: 'demo-md-0' },
  spec:     { replicas, template: { spec: { version: 'v1.37.1+rke2r1', infrastructureRef: { name: 'demo-worker' } } } },
  status:   {
    replicas: ready, readyReplicas: ready, conditions
  }
});
const infra = (conditions: any[] = [], host = '192.0.2.10') => ({
  metadata: { name: 'demo' }, spec: { controlPlaneEndpoint: { host, port: 6443 } }, status: { conditions }
});
const states = (o: any) => progressPhases(o).map((p) => `${ p.key }:${ p.state }`);

describe('progressPhases', () => {
  it('right after Create: objects written, waiting for the infrastructure, the rest queued', () => {
    const o = {
      cluster: cluster([F('InfrastructureReady', 'NotReady')]), infra: infra([F('HarvesterConnectionReady', 'HarvesterConnectionInProgress', 'Attempting to connect to Harvester')]), controlPlane: cp(1, 0), machineDeployments: [md(1, 0)], machines: null, rancherCluster: null
    };

    expect(states(o)).toStrictEqual(['written:done', 'infrastructure:active', 'controlPlane:waiting', 'workers:waiting', 'rancher:unknown']);
    expect(currentPhase(progressPhases(o))?.key).toBe('infrastructure');
    expect(currentPhase(progressPhases(o))?.message).toBe('Attempting to connect to Harvester');
    expect(isProvisioned(progressPhases(o))).toBe(false);
    expect(clusterState(o)).toBe('provisioning');
  });

  it('shows the Harvester provider\'s own words when it cannot go on', () => {
    const o = {
      cluster: cluster([F('InfrastructureReady', 'NotReady')]), infra: infra([F('HarvesterConnectionReady', 'HarvesterConnectionFailed', 'deployments.apps "harvester" is forbidden')]), controlPlane: cp(1, 0), machineDeployments: [], machines: null
    };
    const phases = progressPhases(o);

    expect(phases[1].state).toBe('error');
    expect(phases[1].message).toBe('deployments.apps "harvester" is forbidden');
    expect(clusterState(o)).toBe('error');
    expect(problems(o)).toStrictEqual([{
      kind: 'HarvesterCluster', name: 'demo', type: 'HarvesterConnectionReady', reason: 'HarvesterConnectionFailed', message: 'deployments.apps "harvester" is forbidden'
    }]);
  });

  it('infrastructure ready, first control plane machine not up yet', () => {
    const o = {
      cluster: cluster([T('InfrastructureReady'), F('ControlPlaneInitialized', 'NotInitialized')]), infra: infra([T('InfrastructureReady')]), controlPlane: cp(1, 0, [F('MachinesReady', 'WaitingForBootstrapData', 'Waiting for the machine to boot')]), machineDeployments: [md(1, 0)], machines: null
    };

    expect(states(o)).toStrictEqual(['written:done', 'infrastructure:done', 'controlPlane:active', 'workers:waiting', 'rancher:unknown']);
    expect(progressPhases(o)[1].params.endpoint).toBe('192.0.2.10');
    expect(progressPhases(o)[2].code).toBe('controlPlaneWaiting');
    expect(progressPhases(o)[2].message).toBe('Waiting for the machine to boot');
  });

  it('control plane up, workers joining, Rancher importing', () => {
    const o = {
      cluster:            cluster([T('InfrastructureReady'), T('ControlPlaneInitialized')]),
      infra:              infra(),
      controlPlane:       cp(1, 1),
      machineDeployments: [md(2, 1)],
      machines:           [],
      rancherCluster:     { id: 'c-abcde', status: { conditions: [F('Ready', 'Waiting', 'Cluster agent is not connected')] } },
    };

    expect(states(o)).toStrictEqual(['written:done', 'infrastructure:done', 'controlPlane:done', 'workers:active', 'rancher:waiting']);
    expect(progressPhases(o)[3].params).toStrictEqual({ ready: 1, desired: 2 });
  });

  it('everything done and visible', () => {
    const o = {
      cluster: cluster([T('InfrastructureReady'), T('ControlPlaneInitialized')]), infra: infra(), controlPlane: cp(1, 1), machineDeployments: [md(1, 1)], machines: [], rancherCluster: { id: 'c-abcde', status: { conditions: [T('Ready')] } }
    };

    expect(states(o)).toStrictEqual(['written:done', 'infrastructure:done', 'controlPlane:done', 'workers:done', 'rancher:done']);
    expect(currentPhase(progressPhases(o))).toBeUndefined();
    expect(clusterState(o)).toBe('ready');
  });

  it('a user who cannot see the imported cluster is told so and is not left waiting for it', () => {
    const o = {
      cluster: cluster([T('InfrastructureReady'), T('ControlPlaneInitialized')]), infra: infra(), controlPlane: cp(1, 1), machineDeployments: [md(1, 1)], machines: null, rancherCluster: null
    };
    const phases = progressPhases(o);

    expect(phases[4]).toMatchObject({ state: 'unknown', code: 'rancherNotVisible' });
    expect(isProvisioned(phases)).toBe(true);
    expect(currentPhase(phases)).toBeUndefined();
  });

  it('no workers requested: the worker phase is skipped', () => {
    const o = {
      cluster: cluster([T('InfrastructureReady'), T('ControlPlaneInitialized')]), infra: infra(), controlPlane: cp(1, 1), machineDeployments: [md(0, 0)], machines: null
    };

    expect(progressPhases(o)[3]).toMatchObject({ state: 'skipped', code: 'workersNone' });
  });

  it('reads the initialization fields when the conditions are not there', () => {
    const o = {
      cluster: cluster([], { status: { initialization: { infrastructureProvisioned: true, controlPlaneInitialized: true } } }), infra: infra(), controlPlane: cp(1, 1), machineDeployments: []
    };

    expect(states(o).slice(0, 3)).toStrictEqual(['written:done', 'infrastructure:done', 'controlPlane:done']);
  });

  it('reports a cluster that is being deleted', () => {
    expect(clusterState({ cluster: cluster([], { metadata: { name: 'demo', deletionTimestamp: '2026-11-18T01:00:00Z' } }) })).toBe('deleting');
  });
});

describe('isFailure', () => {
  it('tells "failed" from "not yet"', () => {
    expect(isFailure(F('Ready', 'WaitingForBootstrapData'))).toBe(false);
    expect(isFailure(F('Ready', 'ProvisioningFailed'))).toBe(true);
    expect(isFailure(F('Ready', 'NotReady', 'admission webhook denied the request'))).toBe(true);
    expect(isFailure(T('Ready'))).toBe(false);
  });

  it('does not read "not rolling out" as a failure', () => {
    expect(isFailure(F('RollingOut', 'NotRollingOut'))).toBe(false);
    expect(isFailure(F('Remediating', 'NotRemediating'))).toBe(false);
  });
});

describe('poolRows and machineRows', () => {
  const o = {
    cluster: cluster(), controlPlane: cp(3, 2), machineDeployments: [md(2, 1)], machines: null
  };

  it('lists the control plane and every worker pool with desired and ready counts', () => {
    expect(poolRows(o)).toStrictEqual([
      {
        key: 'cp/demo-cp', role: 'controlPlane', kind: 'RKE2ControlPlane', name: 'demo-cp', desired: 3, ready: 2, current: 2, version: 'v1.37.1+rke2r1', templateName: 'demo-cp', min: 1
      },
      {
        key: 'md/demo-md-0', role: 'worker', kind: 'MachineDeployment', name: 'demo-md-0', desired: 2, ready: 1, current: 1, version: 'v1.37.1+rke2r1', templateName: 'demo-worker', min: 0
      },
    ]);
  });

  it('lists machines, control plane first, with what each one waits for', () => {
    const rows = machineRows([
      {
        metadata: { name: 'demo-md-0-x', labels: { 'cluster.x-k8s.io/deployment-name': 'demo-md-0' } }, spec: { version: 'v1.37.1+rke2r1' }, status: { phase: 'Provisioning', conditions: [F('InfrastructureReady', 'WaitingForInfrastructure', 'VM is starting')] }
      },
      {
        metadata: { name: 'demo-cp-y', labels: { 'cluster.x-k8s.io/control-plane': '', 'cluster.x-k8s.io/control-plane-name': 'demo-cp' } },
        spec:     {},
        status:   {
          phase: 'Running', nodeRef: { name: 'demo-cp-y' }, conditions: [T('Ready')]
        }
      },
    ]);

    expect(rows.map((r) => [r.name, r.role, r.phase, r.node, r.message])).toStrictEqual([
      ['demo-cp-y', 'controlPlane', 'Running', 'demo-cp-y', ''],
      ['demo-md-0-x', 'worker', 'Provisioning', '', 'VM is starting'],
    ]);
  });

  it('is empty, not broken, when machines may not be listed', () => {
    expect(machineRows(null)).toStrictEqual([]);
  });
});

describe('conditionRows and clusterEvents', () => {
  it('flattens the conditions of all objects', () => {
    const rows = conditionRows({
      cluster: cluster([T('Available')]), infra: infra([T('InfrastructureReady')]), controlPlane: cp(1, 1, [T('Ready')]), machineDeployments: [md(1, 1, [T('Available')])], machines: null
    });

    expect(rows.map((r) => `${ r.kind }/${ r.type }`)).toStrictEqual(['Cluster/Available', 'HarvesterCluster/InfrastructureReady', 'RKE2ControlPlane/Ready', 'MachineDeployment/Available']);
  });

  it('keeps the events of this cluster only, newest first', () => {
    const events = [
      {
        involvedObject: { kind: 'Machine', name: 'demo-cp-abc' }, lastTimestamp: '2026-11-18T00:05:00Z', type: 'Normal', reason: 'Created', message: 'm1'
      },
      {
        involvedObject: { kind: 'Cluster', name: 'demo' }, lastTimestamp: '2026-11-18T00:06:00Z', type: 'Warning', reason: 'Failed', message: 'm2'
      },
      {
        involvedObject: { kind: 'Cluster', name: 'demolition' }, lastTimestamp: '2026-11-18T00:07:00Z', message: 'other cluster'
      },
    ];

    expect(clusterEvents(events, 'demo').map((e) => e.message)).toStrictEqual(['m2', 'm1']);
  });
});
