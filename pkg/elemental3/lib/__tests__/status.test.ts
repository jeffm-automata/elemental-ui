import {
  FAILURE_GRACE_SECONDS, NOT_YET_TIMEOUT_SECONDS, clusterEvents, clusterState, conditionRows, currentPhase, isFailure, isProvisioned, machineRows, poolRows, problems, progressPhases, severity
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
      kind: 'HarvesterCluster', name: 'demo', type: 'HarvesterConnectionReady', reason: 'HarvesterConnectionFailed', message: 'deployments.apps "harvester" is forbidden', blocking: true, stalledMinutes: 0
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

  it('reads the providers\' "not yet" messages as waiting although their reason says failed (seen in the lab)', () => {
    expect(isFailure(F('RemoteConnectionProbe', 'ProbeFailed', 'Remote connection not established yet'))).toBe(false);
    expect(isFailure(F('EtcdClusterHealthy', 'InspectionFailed', 'Waiting for Cluster status.infrastructureReady to be true'))).toBe(false);
    expect(isFailure(F('NodeHealthy', 'NodeNotReady', '* Node.Ready: container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized'))).toBe(false);
    expect(isFailure(F('HarvesterConnectionReady', 'HarvesterConnectionFailed', 'Harvester deployment not found: deployments.apps "harvester" is forbidden'))).toBe(true);
  });

  it('does not read "not rolling out" as a failure', () => {
    expect(isFailure(F('RollingOut', 'NotRollingOut'))).toBe(false);
    expect(isFailure(F('Remediating', 'NotRemediating'))).toBe(false);
  });
});

describe('severity over time', () => {
  const NOW = Date.parse('2026-11-18T12:00:00Z');
  const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
  const at = (c: any, seconds: number) => ({ ...c, lastTransitionTime: ago(seconds) });
  const booting = F('NodeHealthy', 'NodeNotReady', '* Node.Ready: container runtime network not ready: NetworkReady=false reason:NetworkPluginNotReady message:Network plugin returns error: cni plugin not initialized');
  const probe = F('RemoteConnectionProbe', 'ProbeFailed', 'Get "https://192.0.2.10:6443/": dial tcp: connect: connection refused');
  const forbidden = F('HarvesterConnectionReady', 'HarvesterConnectionFailed', 'deployments.apps "harvester" is forbidden');

  it('shows a booting node as in progress, for as long as a boot can take', () => {
    expect(severity(at(booting, 30), NOW)).toBe('progress');
    expect(severity(at(booting, 9 * 60), NOW)).toBe('progress');
    expect(severity(at(booting, NOT_YET_TIMEOUT_SECONDS - 1), NOW)).toBe('progress');
  });

  it('turns "not yet" into an error when nothing has changed for the timeout', () => {
    expect(severity(at(booting, NOT_YET_TIMEOUT_SECONDS + 1), NOW)).toBe('error');
    expect(isFailure(at(booting, NOT_YET_TIMEOUT_SECONDS + 1), NOW)).toBe(true);
  });

  it('gives a failed probe or step a grace period before calling it an error', () => {
    expect(severity(at(probe, 20), NOW)).toBe('progress');
    expect(severity(at(probe, FAILURE_GRACE_SECONDS + 1), NOW)).toBe('error');
    expect(severity(probe, NOW)).toBe('error');
  });

  it('shows a refusal at once: waiting does not grant a right', () => {
    expect(severity(at(forbidden, 1), NOW)).toBe('error');
    expect(severity(at(F('Ready', 'InvalidConfiguration', 'spec.replicas: Invalid value'), 1), NOW)).toBe('error');
  });

  it('is ok for true conditions and for "not rolling out"', () => {
    expect(severity(T('Ready'), NOW)).toBe('ok');
    expect(severity(F('RollingOut', 'NotRollingOut'), NOW)).toBe('ok');
  });

  it('does not call the connection probe of a cluster whose control plane is still booting an error (seen in the lab at 5 minutes)', () => {
    const o = (seconds: number) => ({
      cluster:            cluster([], { status: { initialization: { infrastructureProvisioned: true }, conditions: [at(F('RemoteConnectionProbe', 'ProbeFailed', 'Remote connection probe failed'), seconds), at(F('Available', 'NotAvailable', '* RemoteConnectionProbe: Remote connection probe failed'), seconds)] } }),
      infra:              infra(),
      controlPlane:       cp(1, 0),
      machineDeployments: [md(1, 0)],
    });

    expect(problems(o(6 * 60), NOW)).toStrictEqual([]);
    expect(clusterState(o(6 * 60), NOW)).toBe('provisioning');
    expect(problems(o(NOT_YET_TIMEOUT_SECONDS + 60), NOW).map((p) => p.type)).toStrictEqual(['RemoteConnectionProbe', 'Available']);
  });

  it('calls the same probe failure an error after the short grace once the cluster is up', () => {
    const up = {
      cluster:            cluster([], { status: { initialization: { infrastructureProvisioned: true, controlPlaneInitialized: true }, conditions: [at(F('RemoteConnectionProbe', 'ProbeFailed', 'Remote connection probe failed'), 6 * 60)] } }),
      infra:              infra(),
      controlPlane:       cp(1, 1),
      machineDeployments: [md(1, 1)],
    };

    expect(problems(up, NOW).map((p) => p.type)).toStrictEqual(['RemoteConnectionProbe']);
  });

  it('keeps a cluster "provisioning" while its first worker boots, and "error" only after the timeout', () => {
    const o = (seconds: number) => ({
      cluster:            cluster([], { status: { initialization: { infrastructureProvisioned: true, controlPlaneInitialized: true } } }),
      infra:              infra(),
      controlPlane:       cp(1, 1),
      machineDeployments: [{
        metadata: { name: 'demo-md-0' }, spec: { replicas: 1 }, status: { readyReplicas: 0, conditions: [at(booting, seconds)] }
      }],
    });

    expect(clusterState(o(8 * 60), NOW)).toBe('provisioning');
    expect(problems(o(8 * 60), NOW)).toStrictEqual([]);
    expect(progressPhases(o(8 * 60), NOW).find((p) => p.key === 'workers')?.state).toBe('active');
    expect(clusterState(o(NOT_YET_TIMEOUT_SECONDS + 60), NOW)).toBe('error');
    expect(problems(o(NOT_YET_TIMEOUT_SECONDS + 60), NOW).map((p) => p.type)).toStrictEqual(['NodeHealthy']);
  });
});

describe('problems', () => {
  const forbidden = F('HarvesterConnectionReady', 'HarvesterConnectionFailed', 'deployments.apps "harvester" is forbidden');

  it('a failure an object keeps after its part became ready is listed, not blocking, and the cluster is not in error', () => {
    const o = {
      cluster: cluster([T('InfrastructureReady'), T('ControlPlaneInitialized')]), infra: infra([forbidden]), controlPlane: cp(1, 1), machineDeployments: [md(1, 1)], machines: null
    };

    expect(problems(o).map((p) => [p.kind, p.blocking])).toStrictEqual([['HarvesterCluster', false]]);
    expect(clusterState(o)).toBe('ready');
    expect(progressPhases(o)[1].state).toBe('done');
  });

  it('while the control plane waits for the infrastructure, only the infrastructure is in error', () => {
    const o = {
      cluster:            cluster([F('InfrastructureReady', 'NotReady'), F('RemoteConnectionProbe', 'ProbeFailed', 'Remote connection not established yet')]),
      infra:              infra([forbidden]),
      controlPlane:       cp(1, 0, [F('EtcdClusterHealthy', 'InspectionFailed', 'Waiting for Cluster status.infrastructureReady to be true')]),
      machineDeployments: [md(1, 0)],
      machines:           null,
    };

    expect(states(o)).toStrictEqual(['written:done', 'infrastructure:error', 'controlPlane:waiting', 'workers:waiting', 'rancher:unknown']);
    expect(problems(o).map((p) => p.kind)).toStrictEqual(['HarvesterCluster']);
  });

  it('a machine failure is blocking until the machine runs', () => {
    const machines = [{ metadata: { name: 'demo-md-0-x' }, status: { phase: 'Failed', failureMessage: 'VM could not be created' } }];
    const o = {
      cluster: cluster([T('InfrastructureReady'), T('ControlPlaneInitialized')]), infra: infra(), controlPlane: cp(1, 1), machineDeployments: [md(1, 0)], machines
    };

    expect(problems(o)).toStrictEqual([{
      kind: 'Machine', name: 'demo-md-0-x', type: 'Failure', reason: '', message: 'VM could not be created', blocking: true, stalledMinutes: 0
    }]);
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
