import {
  DEFAULT_SNAPSHOT_CRON, ROTATED_ANNOTATION, oldestCertificates, SNAPSHOT_IMAGE, invalidS3, s3Secret, sameS3, healthCheck, healthCheckFor, healthCheckName, healthCheckSummary, lastRotation, parseLabels,
  poolBootstrapPatch, poolLabels, relabelledBootstrapTemplate, rotatePatches, rotationProgress, rotationStamp, sameLabels, schedulePatch,
  sizeText, snapshotJob, snapshotJobState, snapshotRows, snapshotSchedule, validCron, validMinutes, validRetention
} from '../manage';

describe('automatic replacement', () => {
  const check = healthCheck('demo', 'ns', 'demo-md-0', 7);

  it('names the check after the pool, within 63 characters', () => {
    expect(healthCheckName('demo-md-0')).toBe('demo-md-0-auto-replace');
    expect(healthCheckName('p'.repeat(63))).toHaveLength(63);
    expect(healthCheckName('p'.repeat(63)).endsWith('-auto-replace')).toBe(true);
  });

  it('uses the minutes for both node conditions', () => {
    expect(check.spec.checks.unhealthyNodeConditions.map((c: any) => `${ c.status }:${ c.timeoutSeconds }`)).toStrictEqual(['False:420', 'Unknown:420']);
  });

  it('accepts whole minutes from 1 to a day', () => {
    expect([1, 5, 1440].every(validMinutes)).toBe(true);
    expect([0, -1, 1.5, 1441, NaN].some(validMinutes)).toBe(false);
  });

  it('finds the check of a pool whoever wrote it, and not that of another pool or cluster', () => {
    const other = healthCheck('demo', 'ns', 'demo-md-1');
    const foreign = healthCheck('other', 'ns', 'demo-md-0');
    const byHand = { metadata: { name: 'mine' }, spec: { clusterName: 'demo', selector: { matchLabels: { 'cluster.x-k8s.io/deployment-name': 'demo-md-0' } } } };

    expect(healthCheckFor([other, foreign, check], 'demo', 'demo-md-0')).toBe(check);
    expect(healthCheckFor([other, byHand], 'demo', 'demo-md-0')).toBe(byHand);
    expect(healthCheckFor([other, foreign], 'demo', 'demo-md-0')).toBeUndefined();
    expect(healthCheckFor(null, 'demo', 'demo-md-0')).toBeUndefined();
  });

  it('summarises what the controller reports', () => {
    expect(healthCheckSummary(undefined)).toBeNull();
    expect(healthCheckSummary(check)).toStrictEqual({
      name: 'demo-md-0-auto-replace', minutes: 7, expected: undefined, healthy: undefined, remediating: true
    });
    expect(healthCheckSummary({
      ...check,
      status: {
        expectedMachines: 2, currentHealthy: 1, conditions: [{ type: 'RemediationAllowed', status: 'False' }]
      }
    })).toMatchObject({
      expected: 2, healthy: 1, remediating: false
    });
    expect(healthCheckSummary({ metadata: { name: 'x' }, spec: {} })).toMatchObject({ minutes: 0 });
  });
});

describe('node labels', () => {
  it('reads key=value separated by commas, blanks or line ends; a repeated key keeps its last value', () => {
    expect(parseLabels('tier=db, zone=a\nrack=r1  tier=web')).toStrictEqual({ labels: ['tier=web', 'zone=a', 'rack=r1'], errors: [] });
    expect(parseLabels('')).toStrictEqual({ labels: [], errors: [] });
    expect(parseLabels('example.com/role=edge,empty=').labels).toStrictEqual(['example.com/role=edge', 'empty=']);
  });

  it.each([
    ['tier', 'syntax'],
    ['=db', 'syntax'],
    ['-tier=db', 'key'],
    ['Example.com/role=x', 'key'],
    [`${ 'k'.repeat(64) }=x`, 'key'],
    ['tier=db!', 'value'],
    [`tier=${ 'v'.repeat(64) }`, 'value'],
    ['node-role.kubernetes.io/worker=true', 'reserved'],
    ['kubernetes.io/hostname=x', 'reserved'],
    ['topology.k8s.io/zone=a', 'reserved'],
  ])('refuses %s (%s)', (entry, code) => {
    const first = entry.split(' ')[0];
    const res = parseLabels(entry);

    expect(res.errors.some((e) => e.code === code)).toBe(true);
    expect(res.labels).not.toContain(first);
  });

  const current = {
    apiVersion: 'bootstrap.cluster.x-k8s.io/v1beta2',
    kind:       'RKE2ConfigTemplate',
    metadata:   {
      name: 'demo-worker', namespace: 'ns', uid: 'u', resourceVersion: '5', labels: { 'cluster.x-k8s.io/cluster-name': 'demo' }, ownerReferences: [{ kind: 'Cluster' }]
    },
    spec: { template: { metadata: {}, spec: { gzipUserData: false, agentConfig: { airGapped: true } } } },
  };

  it('reads the labels of a bootstrap template', () => {
    expect(poolLabels(current)).toStrictEqual([]);
    expect(poolLabels({ spec: { template: { spec: { agentConfig: { nodeLabels: ['a=b'] } } } } })).toStrictEqual(['a=b']);
    expect(sameLabels(['a=b', 'c=d'], ['c=d', 'a=b'])).toBe(true);
    expect(sameLabels(['a=b'], ['a=c'])).toBe(false);
  });

  it('writes a new template: same configuration, the labels, a new name, nothing the server owns', () => {
    const t = relabelledBootstrapTemplate(current, 'demo-md-0', ['tier=db'], 'abc');

    expect(t).toStrictEqual({
      apiVersion: 'bootstrap.cluster.x-k8s.io/v1beta2',
      kind:       'RKE2ConfigTemplate',
      metadata:   {
        name: 'demo-md-0-labels-abc', namespace: 'ns', labels: { 'cluster.x-k8s.io/cluster-name': 'demo' }
      },
      spec: { template: { spec: { gzipUserData: false, agentConfig: { airGapped: true, nodeLabels: ['tier=db'] } } } },
    });
    // The current template is not changed
    expect(current.spec.template.spec.agentConfig).toStrictEqual({ airGapped: true });
    expect(relabelledBootstrapTemplate(current, 'p'.repeat(63), [], 'abc').metadata.name).toHaveLength(63);
  });

  it('removes the field when the last label is removed', () => {
    const labelled = relabelledBootstrapTemplate(current, 'demo-md-0', ['tier=db'], 'a');

    expect(relabelledBootstrapTemplate(labelled, 'demo-md-0', [], 'b').spec.template.spec.agentConfig).toStrictEqual({ airGapped: true });
  });

  it('points the pool at the template with one patch that touches nothing else', () => {
    expect(poolBootstrapPatch('demo-md-0-labels-abc')).toStrictEqual({ spec: { template: { spec: { bootstrap: { configRef: { name: 'demo-md-0-labels-abc' } } } } } });
  });
});

describe('certificate rotation', () => {
  const stamp = rotationStamp(new Date('2026-11-26T06:00:00.123Z'));

  it('stamps whole seconds', () => {
    expect(stamp).toBe('2026-11-26T06:00:00Z');
  });

  it('asks the control plane first, then every worker pool, each with one patch', () => {
    expect(rotatePatches('all', 'demo-cp', ['demo-md-0', 'demo-md-1'], stamp)).toStrictEqual([
      {
        api:   expect.objectContaining({ resource: 'rke2controlplanes' }),
        name:  'demo-cp',
        patch: { spec: { agentConfig: { nodeAnnotations: { [ROTATED_ANNOTATION]: stamp } } } }
      },
      {
        api: expect.objectContaining({ resource: 'machinedeployments' }), name: 'demo-md-0', patch: { spec: { rollout: { after: stamp } } }
      },
      {
        api: expect.objectContaining({ resource: 'machinedeployments' }), name: 'demo-md-1', patch: { spec: { rollout: { after: stamp } } }
      },
    ]);
  });

  it('keeps to the scope', () => {
    expect(rotatePatches('controlPlane', 'demo-cp', ['demo-md-0'], stamp).map((p) => p.name)).toStrictEqual(['demo-cp']);
    expect(rotatePatches('workers', 'demo-cp', ['demo-md-0'], stamp).map((p) => p.name)).toStrictEqual(['demo-md-0']);
  });

  it('estimates the oldest certificates from the node that joined first', () => {
    expect(oldestCertificates(null)).toBeNull();
    expect(oldestCertificates([{ metadata: { name: 'x' } }])).toBeNull();
    expect(oldestCertificates([
      { metadata: { name: 'b', creationTimestamp: '2026-11-26T06:00:00Z' } },
      { metadata: { name: 'a', creationTimestamp: '2026-03-01T10:00:00Z' } },
    ])).toStrictEqual({
      node: 'a', issued: '2026-03-01', expires: '2027-03-01'
    });
  });

  it('reads the last request back from the objects', () => {
    expect(lastRotation(null, [])).toStrictEqual({ controlPlane: '', workers: '' });
    expect(lastRotation(
      { spec: { agentConfig: { nodeAnnotations: { [ROTATED_ANNOTATION]: stamp } } } },
      [{ spec: { rollout: { after: '2026-11-25T00:00:00Z' } } }, { spec: { rollout: { after: stamp } } }, { spec: {} }]
    )).toStrictEqual({ controlPlane: stamp, workers: stamp });
  });

  it('counts progress from the machines: created after the request and running is replaced', () => {
    const m = (role: string, created: string, phase = 'Running') => ({
      role, created, phase
    });
    const before = '2026-11-26T05:00:00Z';
    const after = '2026-11-26T06:05:00Z';

    expect(rotationProgress('', [], 'worker', 2)).toBeNull();
    expect(rotationProgress(stamp, [m('worker', before), m('worker', before), m('controlPlane', before)], 'worker', 2)).toStrictEqual({
      replaced: 0, wanted: 2, old: 2, done: false
    });
    expect(rotationProgress(stamp, [m('worker', before), m('worker', after), m('worker', after, 'Provisioning')], 'worker', 2)).toStrictEqual({
      replaced: 1, wanted: 2, old: 1, done: false
    });
    expect(rotationProgress(stamp, [m('worker', after), m('worker', stamp)], 'worker', 2)).toStrictEqual({
      replaced: 2, wanted: 2, old: 0, done: true
    });
    // New machines are up but an old one is still being drained: not done
    expect(rotationProgress(stamp, [m('controlPlane', after), m('controlPlane', before, 'Deleting')], 'controlPlane', 1)?.done).toBe(false);
  });
});

describe('etcd snapshots', () => {
  it('lists what RKE2 recorded, newest first', () => {
    const rows = snapshotRows([
      {
        metadata: { name: 'local-etcd-snapshot-cp1-1' },
        spec:     {
          snapshotName: 'etcd-snapshot-cp1-1', nodeName: 'cp1', location: 'file:///var/lib/rancher/rke2/server/db/snapshots/etcd-snapshot-cp1-1'
        },
        status: {
          size: 5242880, creationTime: '2026-11-26T00:00:00Z', readyToUse: true
        }
      },
      {
        metadata: { name: 's3-on-demand-cp1-2' },
        spec:     {
          snapshotName: 'on-demand-cp1-2', nodeName: 'cp1', location: 's3://bucket/on-demand-cp1-2', s3: { bucket: 'bucket' }
        },
        status: { creationTime: '2026-11-26T06:00:00Z', error: { message: 'no such bucket' } }
      },
    ]);

    expect(rows.map((r) => r.name)).toStrictEqual(['on-demand-cp1-2', 'etcd-snapshot-cp1-1']);
    expect(rows[0]).toMatchObject({
      s3: true, ready: false, error: 'no such bucket', size: 0
    });
    expect(rows[1]).toMatchObject({
      node: 'cp1', s3: false, ready: true, size: 5242880
    });
    expect(snapshotRows(null)).toStrictEqual([]);
    expect(sizeText(5242880)).toBe('5.0 MiB');
    expect(sizeText(2000)).toBe('2 KiB');
    expect(sizeText(0)).toBe('');
  });

  it('shows RKE2 defaults when the control plane states nothing', () => {
    expect(snapshotSchedule({ spec: { serverConfig: {} } })).toStrictEqual({
      enabled: true, cron: DEFAULT_SNAPSHOT_CRON, retention: 5, stated: false, s3: '', s3Config: null
    });
    expect(snapshotSchedule({
      spec: {
        serverConfig: {
          etcd: {
            backupConfig: {
              scheduleCron: '0 */6 * * *', retention: '10', s3: { endpoint: 's3.example.com', bucket: 'b' }
            }
          }
        }
      }
    })).toStrictEqual({
      enabled:   true,
      cron:      '0 */6 * * *',
      retention: 10,
      stated:    true,
      s3:        's3.example.com/b',
      s3Config:  {
        endpoint: 's3.example.com', bucket: 'b', folder: '', region: '', skipTlsVerify: true
      }
    });
    expect(snapshotSchedule({ spec: { serverConfig: { etcd: { backupConfig: { disableAutomaticSnapshots: true } } } } }).enabled).toBe(false);
  });

  it('checks the cron text and the retention', () => {
    expect(['0 */12 * * *', '*/30 * * * *', '15 1,13 * * 1-5', ' 0  3 * * * '].every(validCron)).toBe(true);
    expect(['', '* * * *', '0 */12 * * * *', '@daily', '0 3 * * mon', 'a b c d e'].some(validCron)).toBe(false);
    expect([1, 5, 1000].every(validRetention)).toBe(true);
    expect([0, 1.5, 1001].some(validRetention)).toBe(false);
  });

  it('patches only the two fields, retention as text (the provider declares a string)', () => {
    expect(schedulePatch(' 0  */6 * * * ', 10)).toStrictEqual({ spec: { serverConfig: { etcd: { backupConfig: { scheduleCron: '0 */6 * * *', retention: '10' } } } } });
  });

  const target = {
    endpoint: 's3.example.com:9000', bucket: 'snapshots', folder: 'demo', region: '', skipTlsVerify: true
  };

  it('checks an S3 target and compares two', () => {
    expect(invalidS3(target)).toStrictEqual([]);
    expect(invalidS3({
      ...target, endpoint: 'https://s3.example.com', bucket: 'B'
    })).toStrictEqual(['endpoint', 'bucket']);
    expect(invalidS3({
      ...target, endpoint: '', bucket: ''
    })).toStrictEqual(['endpoint', 'bucket']);
    expect(sameS3(null, null)).toBe(true);
    expect(sameS3(target, { ...target })).toBe(true);
    expect(sameS3(target, null)).toBe(false);
    expect(sameS3(target, { ...target, folder: 'other' })).toBe(false);
  });

  it('leaves, sets or removes the S3 target', () => {
    expect(schedulePatch('0 3 * * *', 5).spec.serverConfig.etcd.backupConfig).not.toHaveProperty('s3');
    expect(schedulePatch('0 3 * * *', 5, null).spec.serverConfig.etcd.backupConfig.s3).toBeNull();
    expect(schedulePatch('0 3 * * *', 5, {
      ...target, secretName: 'demo-etcd-s3-abc', secretNamespace: 'ns'
    }).spec.serverConfig.etcd.backupConfig.s3).toStrictEqual({
      endpoint: 's3.example.com:9000', bucket: 'snapshots', folder: 'demo', region: null, enforceSslVerify: false, s3CredentialSecret: { name: 'demo-etcd-s3-abc', namespace: 'ns' }
    });
  });

  it('writes the keys into a Secret the Cluster owns, under the names the RKE2 provider reads', () => {
    const secret = s3Secret('demo', 'ns', 'uid-1', 'AK', 'SK', 'abc');

    expect(secret.metadata.name).toBe('demo-etcd-s3-abc');
    expect(secret.metadata.ownerReferences).toStrictEqual([{
      apiVersion: 'cluster.x-k8s.io/v1beta2', kind: 'Cluster', name: 'demo', uid: 'uid-1'
    }]);
    expect(secret.stringData).toStrictEqual({ aws_access_key_id: 'AK', aws_secret_access_key: 'SK' });
    expect(s3Secret('c'.repeat(63), 'ns', '', 'AK', 'SK', 'abc').metadata.name).toHaveLength(63);
  });

  it('writes a Job that runs the node\'s own rke2 on a control plane node and removes itself', () => {
    const job = snapshotJob('abc', 'example/image:1');
    const pod = job.spec.template.spec;

    expect(job.metadata).toMatchObject({ name: 'elemental-etcd-snapshot-abc', namespace: 'kube-system' });
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.spec.ttlSecondsAfterFinished).toBe(3600);
    expect(pod.nodeSelector).toStrictEqual({ 'node-role.kubernetes.io/etcd': 'true' });
    expect(pod.containers[0].image).toBe('example/image:1');
    expect(pod.containers[0].command.slice(0, 3)).toStrictEqual(['nsenter', '-t', '1']);
    expect(snapshotJob('abc').spec.template.spec.containers[0].image).toBe(SNAPSHOT_IMAGE);
    expect(pod.containers[0].command[pod.containers[0].command.length - 1]).toContain('rke2 etcd-snapshot save --name on-demand');
  });

  it('reads the state of the Job', () => {
    expect(snapshotJobState({ status: {} })).toBe('running');
    expect(snapshotJobState({ status: { succeeded: 1 } })).toBe('done');
    expect(snapshotJobState({ status: { failed: 1 } })).toBe('failed');
    expect(snapshotJobState({ status: { conditions: [{ type: 'Failed', status: 'True' }] } })).toBe('failed');
  });
});
