import {
  API, IMPORT_LABEL, READ_API, accessReview, buildObjects, collectionPath, defaultValues, isIPv4, names, objectPath, rightText, validate, WizardValues,
  poolTemplatePatch, resizedMachineTemplate, templateSize, validSize
} from '../objects';

function values(over: Partial<WizardValues> = {}): WizardValues {
  return {
    ...defaultValues(),
    name:              'demo',
    vmNamespace:       'tenant',
    image:             'tenant/elemental-1372',
    kubernetesVersion: 'v1.37.2+rke2r1',
    network:           'tenant/vm-vlan',
    sshKeyPair:        'tenant/key',
    controlPlaneHost:  '192.0.2.10',
    controlPlane:      {
      count: 1, cpu: 4, memory: 8, disk: 40
    },
    workers: {
      count: 1, cpu: 4, memory: 8, disk: 40
    },
    ...over,
  };
}

describe('defaultValues', () => {
  it('matches the defaults of the provisioning v2 Harvester form: one machine, 2 CPUs, 4 GiB, 40 GiB', () => {
    const d = defaultValues();

    expect(d.controlPlane).toStrictEqual({
      count: 1, cpu: 2, memory: 4, disk: 40
    });
    expect(d.workers).toStrictEqual({
      count: 0, cpu: 2, memory: 4, disk: 40
    });
    expect(d.namespace).toBe('fleet-default');
  });
});

describe('validate', () => {
  it('accepts a complete form', () => {
    expect(validate(values())).toStrictEqual([]);
  });

  it('lists every missing required field of an empty form', () => {
    const fields = validate(defaultValues()).filter((e) => e.code === 'required').map((e) => e.field);

    expect(fields).toStrictEqual(['name', 'vmNamespace', 'image', 'kubernetesVersion', 'network', 'sshKeyPair']);
    expect(validate({ ...defaultValues(), endpointMode: 'address' }).filter((e) => e.code === 'required').map((e) => e.field)).toContain('controlPlaneHost');
  });

  it.each([
    ['name', 'Demo'],
    ['name', '1demo'],
    ['name', 'demo-'],
    ['name', 'a'.repeat(41)],
    ['kubernetesVersion', '1.37.2'],
    ['kubernetesVersion', 'v1.37.2'],
    ['controlPlaneHost', '192.0.2'],
    ['controlPlaneHost', '192.0.2.256'],
    ['controlPlaneHost', 'example.com'],
    ['image', 'no-namespace'],
    ['network', 'no-namespace'],
    ['sshKeyPair', 'no-namespace'],
  ])('rejects %s = %s', (field, value) => {
    // The address is only read with the advanced fixed-address option
    const errors = validate(values({ endpointMode: 'address', [field]: value } as any));

    expect(errors.map((e) => e.field)).toStrictEqual([field]);
  });

  it('needs at least one control plane machine and allows zero workers', () => {
    const v = values();

    v.controlPlane.count = 0;
    v.workers.count = 0;
    expect(validate(v).map((e) => e.field)).toStrictEqual(['controlPlane.count']);
    v.controlPlane.count = 1;
    v.workers.count = -1;
    expect(validate(v).map((e) => e.field)).toStrictEqual(['workers.count']);
  });

  it('rejects sizes that are not whole numbers of at least 1', () => {
    const v = values();

    v.workers.memory = 0;
    v.controlPlane.cpu = 1.5;
    expect(validate(v).map((e) => e.field)).toStrictEqual(['controlPlane.cpu', 'workers.memory']);
  });
});

describe('isIPv4', () => {
  it.each(['192.0.2.1', '10.0.0.255'])('accepts %s', (a) => expect(isIPv4(a)).toBe(true));
  it.each(['', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.999', 'a.b.c.d'])('rejects %s', (a) => expect(isIPv4(a)).toBe(false));
});

describe('buildObjects', () => {
  const v = values({
    workers: {
      count: 2, cpu: 2, memory: 6, disk: 50
    }
  });
  const objects = buildObjects(v, { kubeconfig: 'KUBECONFIG', clusterUid: 'uid-1' });
  const byKey = (key: string) => objects.find((o) => o.key === key)?.object;
  const n = names('demo');

  it('writes the eight objects of the proven set, the Cluster first', () => {
    expect(objects.map((o) => `${ o.object.kind }/${ o.object.metadata.name }`)).toStrictEqual([
      'Cluster/demo',
      'Secret/demo-harvester-identity',
      'HarvesterCluster/demo',
      'RKE2ControlPlane/demo-cp',
      'HarvesterMachineTemplate/demo-cp',
      'RKE2ConfigTemplate/demo-worker',
      'HarvesterMachineTemplate/demo-worker',
      'MachineDeployment/demo-md-0',
    ]);
    objects.forEach((o) => {
      expect(o.object.metadata.namespace).toBe('fleet-default');
      expect(o.object.kind).toBe(o.api.kind);
      expect(o.object.apiVersion).toBe(o.api.group ? `${ o.api.group }/${ o.api.version }` : o.api.version);
    });
  });

  it('labels the Cluster for the Rancher Turtles import and wires the references', () => {
    const cluster = byKey('cluster');

    expect(cluster.metadata.labels[IMPORT_LABEL]).toBe('true');
    expect(cluster.spec.controlPlaneRef).toStrictEqual({
      apiGroup: 'controlplane.cluster.x-k8s.io', kind: 'RKE2ControlPlane', name: n.controlPlane
    });
    expect(cluster.spec.infrastructureRef).toStrictEqual({
      apiGroup: 'infrastructure.cluster.x-k8s.io', kind: 'HarvesterCluster', name: n.infraCluster
    });
    expect(cluster.spec.clusterNetwork.pods.cidrBlocks).toStrictEqual(['10.42.0.0/16']);
    expect(cluster.spec.clusterNetwork.services.cidrBlocks).toStrictEqual(['10.43.0.0/16']);
  });

  it('puts the kubeconfig into an identity Secret owned by the Cluster', () => {
    const secret = byKey('identity');

    expect(secret.stringData).toStrictEqual({ kubeconfig: 'KUBECONFIG' });
    expect(secret.metadata.ownerReferences).toStrictEqual([{
      apiVersion: 'cluster.x-k8s.io/v1beta2', kind: 'Cluster', name: 'demo', uid: 'uid-1'
    }]);
    expect(byKey('infraCluster').spec.identitySecret).toStrictEqual({ name: n.identity, namespace: 'fleet-default' });
  });

  it('leaves the owner out when the Cluster UID is not known', () => {
    const secret = buildObjects(v, { kubeconfig: 'K' }).find((o) => o.key === 'identity')?.object;

    expect(secret.metadata.ownerReferences).toBeUndefined();
  });

  it('describes the Harvester side: namespace, identity, and a load balancer with the RKE2 registration port; no endpoint', () => {
    expect(byKey('infraCluster').spec).toStrictEqual({
      targetNamespace:    'tenant',
      identitySecret:     { name: n.identity, namespace: 'fleet-default' },
      loadBalancerConfig: {
        ipamType:  'dhcp',
        listeners: [{
          name: 'rke2-server', port: 9345, protocol: 'TCP', backendPort: 9345
        }],
      },
    });
    expect(byKey('infraCluster').metadata.annotations).toBeUndefined();
  });

  it('writes no address, no kube-vip, no files and no commands by default: the provider does all of it', () => {
    const text = JSON.stringify(objects);

    expect(defaultValues().endpointMode).toBe('loadBalancer');
    expect(text).not.toContain('192.0.2.10');
    expect(text).not.toContain('kube-vip');
    expect(text).not.toContain('node-address');
    expect(text).not.toContain('managed-by');
    expect(byKey('controlPlane').spec.files).toBeUndefined();
    expect(byKey('controlPlane').spec.postRKE2Commands).toBeUndefined();
    expect(byKey('workerBootstrap').spec.template.spec).toStrictEqual({ gzipUserData: false, agentConfig: { airGapped: true } });
    expect(validate(values({ controlPlaneHost: '' }))).toStrictEqual([]);
  });

  it('uses one release for every machine: same image and same version in all pools', () => {
    const cp = byKey('controlPlane');
    const md = byKey('workers');

    expect(cp.spec.version).toBe('v1.37.2+rke2r1');
    expect(md.spec.template.spec.version).toBe('v1.37.2+rke2r1');
    expect(byKey('controlPlaneMachines').spec.template.spec.volumes[0].imageName).toBe('tenant/elemental-1372');
    expect(byKey('workerMachines').spec.template.spec.volumes[0].imageName).toBe('tenant/elemental-1372');
  });

  it('sizes each pool from its own fields', () => {
    expect(byKey('controlPlane').spec.replicas).toBe(1);
    expect(byKey('workers').spec.replicas).toBe(2);
    expect(byKey('controlPlaneMachines').spec.template.spec).toMatchObject({
      cpu: 4, memory: '8Gi', networks: ['tenant/vm-vlan'], sshUser: 'root', sshKeyPair: 'tenant/key', firmware: { efi: true }
    });
    expect(byKey('workerMachines').spec.template.spec).toMatchObject({ cpu: 2, memory: '6Gi' });
    expect(byKey('workerMachines').spec.template.spec.volumes).toStrictEqual([{
      volumeType: 'image', imageName: 'tenant/elemental-1372', volumeSize: '50Gi', bootOrder: 1
    }]);
  });

  it('configures CAPRKE2 for an image that already contains RKE2', () => {
    const cp = byKey('controlPlane').spec;
    const worker = byKey('workerBootstrap').spec.template.spec;

    expect(cp.agentConfig).toStrictEqual({ airGapped: true });
    expect(worker.agentConfig).toStrictEqual({ airGapped: true });
    expect(cp.gzipUserData).toBe(false);
    expect(worker.gzipUserData).toBe(false);
    expect(cp.registrationMethod).toBe('control-plane-endpoint');
    expect(cp.serverConfig).toStrictEqual({ cloudProviderName: 'external', disableComponents: { kubernetesComponents: ['cloudController'] } });
    expect(cp.machineTemplate.spec.infrastructureRef).toStrictEqual({
      apiGroup: 'infrastructure.cluster.x-k8s.io', kind: 'HarvesterMachineTemplate', name: n.controlPlane
    });
  });

  describe('with a fixed control plane address (advanced)', () => {
    const fixed = buildObjects(values({ endpointMode: 'address' }), { kubeconfig: 'KUBECONFIG', clusterUid: 'uid-1' });
    const fx = (key: string) => fixed.find((o) => o.key === key)!.object;

    it('needs an IPv4 address', () => {
      expect(validate(values({ endpointMode: 'address' }))).toStrictEqual([]);
      expect(validate(values({ endpointMode: 'address', controlPlaneHost: '' })).map((e) => e.field)).toStrictEqual(['controlPlaneHost']);
      expect(validate(values({ endpointMode: 'address', controlPlaneHost: 'cp.example' })).map((e) => e.code)).toStrictEqual(['controlPlaneHost']);
    });

    it('tells the provider to create no load balancer and to keep the endpoint: external, never dhcp', () => {
      expect(fx('infraCluster').spec).toStrictEqual({
        targetNamespace:      'tenant',
        identitySecret:       { name: n.identity, namespace: 'fleet-default' },
        loadBalancerConfig:   { ipamType: 'external' },
        controlPlaneEndpoint: { host: '192.0.2.10', port: 6443 },
      });
    });

    it('writes the typed address in exactly two places, both from the one field: endpoint and kube-vip', () => {
      expect(JSON.stringify(fixed).split('192.0.2.10').length - 1).toBe(2);
    });

    it('announces the address with kube-vip on control plane machines only, and carries no other file', () => {
      const cpFiles = fx('controlPlane').spec.files;

      expect(cpFiles.map((f: any) => f.path)).toStrictEqual(['/var/lib/rancher/rke2/server/manifests/elemental-kube-vip.yaml']);
      expect(cpFiles[0].content).toContain('{name: address, value: "192.0.2.10"}');
      expect(cpFiles[0].content).toContain('{name: port, value: "6443"}');
      expect(fx('controlPlane').spec.postRKE2Commands).toBeUndefined();
      expect(fx('workerBootstrap').spec.template.spec).toStrictEqual({ gzipUserData: false, agentConfig: { airGapped: true } });
    });

    it('writes the same eight objects otherwise', () => {
      expect(fixed.map((o) => o.key)).toStrictEqual(objects.map((o) => o.key));
      expect(fx('workers').spec.template.spec.version).toBe(byKey('workers').spec.template.spec.version);
    });
  });

  it('names the logged-in user as creator of the Cluster, the way Rancher does for its own clusters', () => {
    const o = buildObjects(values({ creatorId: 'u-abcde' }), { kubeconfig: 'x' });

    expect(o[0].object.metadata.annotations).toStrictEqual({ 'field.cattle.io/creatorId': 'u-abcde' });
    expect(JSON.stringify(o.slice(1))).not.toContain('creatorId');
  });

  it('records the Harvester cluster when it is known', () => {
    const o = buildObjects(values({ harvesterClusterId: 'c-abcde' }), { kubeconfig: 'x' });

    expect(o[0].object.metadata.annotations).toStrictEqual({ 'elemental.suse.com/harvester-cluster': 'c-abcde' });
  });

  it('ties the MachineDeployment to the cluster and its templates', () => {
    const md = byKey('workers').spec;
    const labels = { 'cluster.x-k8s.io/cluster-name': 'demo', 'cluster.x-k8s.io/deployment-name': 'demo-md-0' };

    expect(md.clusterName).toBe('demo');
    expect(md.selector.matchLabels).toStrictEqual(labels);
    expect(md.template.metadata.labels).toStrictEqual(labels);
    expect(md.template.spec.bootstrap.configRef).toStrictEqual({
      apiGroup: 'bootstrap.cluster.x-k8s.io', kind: 'RKE2ConfigTemplate', name: n.workerTemplate
    });
    expect(md.template.spec.infrastructureRef).toStrictEqual({
      apiGroup: 'infrastructure.cluster.x-k8s.io', kind: 'HarvesterMachineTemplate', name: n.workerTemplate
    });
  });

  it('records the release manifest when it is known', () => {
    const withRelease = buildObjects(values({ releaseManifest: 'registry.example/rke2-manifest:1.37.2-20.3' }), { kubeconfig: 'K' });

    expect(withRelease[0].object.metadata.annotations).toStrictEqual({ 'elemental.suse.com/release-manifest': 'registry.example/rke2-manifest:1.37.2-20.3' });
    expect(byKey('cluster').metadata.annotations).toStrictEqual({});
  });

  it('contains no status and nothing a controller owns', () => {
    objects.forEach((o) => expect(o.object.status).toBeUndefined());
  });
});

describe('access reviews and paths', () => {
  it('builds the review the page sends before it offers a control', () => {
    expect(accessReview(API.md, 'patch', 'ns1').spec.resourceAttributes).toStrictEqual({
      group: 'cluster.x-k8s.io', resource: 'machinedeployments', verb: 'patch', namespace: 'ns1'
    });
    expect(accessReview(API.cluster, 'delete', 'ns1', 'demo').spec.resourceAttributes.name).toBe('demo');
  });

  it('names a right the way it has to be granted', () => {
    expect(rightText(API.md, 'patch', 'ns1')).toBe('patch machinedeployments.cluster.x-k8s.io in namespace ns1');
    expect(rightText(READ_API.event, 'list', 'ns1')).toBe('list events in namespace ns1');
    expect(objectPath(API.md, 'ns1', 'demo-md-0')).toBe('/apis/cluster.x-k8s.io/v1beta2/namespaces/ns1/machinedeployments/demo-md-0');
  });
});

describe('collectionPath', () => {
  it('builds core and group paths', () => {
    expect(collectionPath(API.secret, 'ns')).toBe('/api/v1/namespaces/ns/secrets');
    expect(collectionPath(API.cluster, 'ns')).toBe('/apis/cluster.x-k8s.io/v1beta2/namespaces/ns/clusters');
    expect(collectionPath(API.infraMachine, 'ns')).toBe('/apis/infrastructure.cluster.x-k8s.io/v1beta1/namespaces/ns/harvestermachinetemplates');
  });
});

describe('changing the machine size of a worker pool', () => {
  const current = {
    apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta1',
    kind:       'HarvesterMachineTemplate',
    metadata:   {
      name: 'c1-md-0', namespace: 'tenant-a', uid: 'u-1', resourceVersion: '77', labels: { 'cluster.x-k8s.io/cluster-name': 'c1' }, ownerReferences: [{ kind: 'Cluster', name: 'c1' }]
    },
    spec: {
      template: {
        spec: {
          cpu:        2,
          memory:     '8Gi',
          sshUser:    'root',
          sshKeyPair: 'agents/key',
          networks:   ['agents/vm'],
          volumes:    [{
            volumeType: 'image', imageName: 'agents/img', volumeSize: '40Gi', bootOrder: 1
          }]
        }
      }
    },
    status: { x: 1 },
  };

  it('reads the size of a template and refuses what it cannot edit', () => {
    expect(templateSize(current)).toEqual({ cpu: 2, memory: 8 });
    expect(templateSize({ spec: { template: { spec: { cpu: 2, memory: '8192Mi' } } } })).toBeNull();
    expect(templateSize(null)).toBeNull();
    expect(validSize({ cpu: 4, memory: 12 })).toBe(true);
    expect(validSize({ cpu: 0, memory: 12 })).toBe(false);
    expect(validSize({ cpu: 2, memory: 1.5 })).toBe(false);
  });

  it('writes a new template: same machine, other size, new name, nothing the server owns', () => {
    const t = resizedMachineTemplate(current, 'c1-md-0', { cpu: 2, memory: 12 }, 'k3x9');

    expect(t.metadata).toEqual({
      name: 'c1-md-0-2c12g-k3x9', namespace: 'tenant-a', labels: { 'cluster.x-k8s.io/cluster-name': 'c1' }
    });
    expect(t.spec.template.spec).toEqual({ ...current.spec.template.spec, memory: '12Gi' });
    expect(t.status).toBeUndefined();
    expect(current.spec.template.spec.memory).toBe('8Gi');
  });

  it('keeps the name within 63 characters', () => {
    const t = resizedMachineTemplate(current, 'a'.repeat(60), { cpu: 16, memory: 128 }, 'k3x9zz');

    expect(t.metadata.name).toHaveLength(63);
    expect(t.metadata.name.endsWith('-16c128g-k3x9zz')).toBe(true);
  });

  it('points the pool at the new template with a patch of the name only', () => {
    expect(poolTemplatePatch('c1-md-0-2c12g-k3x9')).toEqual({ spec: { template: { spec: { infrastructureRef: { name: 'c1-md-0-2c12g-k3x9' } } } } });
  });
});
