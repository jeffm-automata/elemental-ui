import {
  API, IMPORT_LABEL, READ_API, accessReview, buildObjects, collectionPath, defaultValues, isIPv4, names, objectPath, rightText, validate, WizardValues
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

    expect(fields).toStrictEqual(['name', 'vmNamespace', 'image', 'kubernetesVersion', 'network', 'sshKeyPair', 'controlPlaneHost']);
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
    const errors = validate(values({ [field]: value } as any));

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

  it('describes the Harvester side: namespace, endpoint, load balancer stanza', () => {
    expect(byKey('infraCluster').spec).toStrictEqual({
      controlPlaneEndpoint: { host: '192.0.2.10', port: 6443 },
      targetNamespace:      'tenant',
      identitySecret:       { name: n.identity, namespace: 'fleet-default' },
      loadBalancerConfig:   { ipamType: 'dhcp' },
    });
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

  describe('with a Harvester load balancer as control plane endpoint', () => {
    const lbObjects = buildObjects(values({ endpointMode: 'loadBalancer', controlPlaneHost: '' }), { kubeconfig: 'KUBECONFIG', clusterUid: 'uid-1' });
    const lb = (key: string) => lbObjects.find((o) => o.key === key)!.object;

    it('needs no address', () => {
      expect(validate(values({ endpointMode: 'loadBalancer', controlPlaneHost: '' }))).toStrictEqual([]);
      expect(validate(values({ endpointMode: 'address', controlPlaneHost: '' })).map((e) => e.field)).toStrictEqual(['controlPlaneHost']);
    });

    it('writes no endpoint and no kube-vip: the provider assigns the only address there is', () => {
      expect(lb('infraCluster').spec.controlPlaneEndpoint).toBeUndefined();
      expect(lb('controlPlane').spec.files.map((f: any) => f.path)).toStrictEqual(['/opt/elemental-capi/node-address.sh']);
      expect(JSON.stringify(lbObjects)).not.toContain('kube-vip');
    });

    it('asks for the RKE2 registration port on the load balancer, next to the API port the provider adds', () => {
      expect(lb('infraCluster').spec.loadBalancerConfig).toStrictEqual({
        ipamType:  'dhcp',
        listeners: [{
          name: 'rke2-server', port: 9345, protocol: 'TCP', backendPort: 9345
        }],
      });
    });

    it('writes the same eight objects otherwise', () => {
      expect(lbObjects.map((o) => o.key)).toStrictEqual(objects.map((o) => o.key));
      expect(lb('workers').spec.template.spec.version).toBe(byKey('workers').spec.template.spec.version);
    });
  });

  it('writes the typed address in exactly two places, both from the one field: endpoint and kube-vip', () => {
    const text = JSON.stringify(objects);

    expect(text.split('192.0.2.10').length - 1).toBe(2);
    expect(byKey('infraCluster').spec.controlPlaneEndpoint.host).toBe('192.0.2.10');
  });

  it('records the Harvester cluster when it is known', () => {
    const o = buildObjects(values({ harvesterClusterId: 'c-abcde' }), { kubeconfig: 'x' });

    expect(o[0].object.metadata.annotations).toStrictEqual({ 'elemental.suse.com/harvester-cluster': 'c-abcde' });
  });

  it('announces the control plane address with kube-vip on control plane machines only', () => {
    const cpFiles = byKey('controlPlane').spec.files;
    const workerFiles = byKey('workerBootstrap').spec.template.spec.files;
    const vip = cpFiles.find((f: any) => f.path.endsWith('elemental-kube-vip.yaml'));

    expect(vip.content).toContain('{name: address, value: "192.0.2.10"}');
    expect(vip.content).toContain('{name: port, value: "6443"}');
    expect(workerFiles.map((f: any) => f.path)).toStrictEqual(['/opt/elemental-capi/node-address.sh']);
    expect(byKey('controlPlane').spec.postRKE2Commands).toStrictEqual(['/opt/elemental-capi/node-address.sh']);
    expect(byKey('workerBootstrap').spec.template.spec.postRKE2Commands).toStrictEqual(['/opt/elemental-capi/node-address.sh']);
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
