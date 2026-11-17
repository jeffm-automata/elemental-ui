/**
 * Builds the Cluster API objects of an Elemental 3 cluster on Harvester from the wizard's form values.
 *
 * This file has no imports on purpose: it is plain data in, plain objects out, so the same objects can be
 * written with kubectl and the unit tests run without the Rancher shell.
 *
 * The object set is the one proven in the lab for generic Elemental 3 node images
 * (CAPHV v0.10.1 + CAPRKE2 v0.25.3, Cluster API v1.13 contract v1beta2, imported into Rancher by Turtles):
 * Cluster, HarvesterCluster, RKE2ControlPlane, two HarvesterMachineTemplates, RKE2ConfigTemplate,
 * MachineDeployment and the identity Secret CAPHV reads the Harvester kubeconfig from.
 */

export const IMPORT_LABEL = 'cluster-api.cattle.io/rancher-auto-import';
export const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';
export const DEPLOYMENT_NAME_LABEL = 'cluster.x-k8s.io/deployment-name';
export const CREATED_BY_LABEL = 'elemental.suse.com/created-by';
export const CREATED_BY_VALUE = 'elemental3-ui';
export const RELEASE_ANNOTATION = 'elemental.suse.com/release-manifest';

export const KUBE_VIP_IMAGE = 'ghcr.io/kube-vip/kube-vip:v1.3.1';
export const API_PORT = 6443;
export const MAX_NAME_LENGTH = 40;

export const API = {
  cluster: {
    group: 'cluster.x-k8s.io', version: 'v1beta2', resource: 'clusters', kind: 'Cluster'
  },
  md: {
    group: 'cluster.x-k8s.io', version: 'v1beta2', resource: 'machinedeployments', kind: 'MachineDeployment'
  },
  controlPlane: {
    group: 'controlplane.cluster.x-k8s.io', version: 'v1beta2', resource: 'rke2controlplanes', kind: 'RKE2ControlPlane'
  },
  bootstrap: {
    group: 'bootstrap.cluster.x-k8s.io', version: 'v1beta2', resource: 'rke2configtemplates', kind: 'RKE2ConfigTemplate'
  },
  infraCluster: {
    group: 'infrastructure.cluster.x-k8s.io', version: 'v1beta1', resource: 'harvesterclusters', kind: 'HarvesterCluster'
  },
  infraMachine: {
    group: 'infrastructure.cluster.x-k8s.io', version: 'v1beta1', resource: 'harvestermachinetemplates', kind: 'HarvesterMachineTemplate'
  },
  secret: {
    group: '', version: 'v1', resource: 'secrets', kind: 'Secret'
  },
};

export interface ApiRef { group: string; version: string; resource: string; kind: string }

export interface PoolValues {
  /** Number of machines */
  count: number;
  cpu: number;
  /** GiB */
  memory: number;
  /** GiB */
  disk: number;
}

export interface WizardValues {
  /** Cluster name */
  name: string;
  /** Namespace on the management cluster that holds the Cluster API objects */
  namespace: string;
  /** Harvester namespace the VMs are created in */
  vmNamespace: string;
  /** Harvester image as namespace/name */
  image: string;
  /** RKE2 version the image contains, for example v1.37.2+rke2r1 */
  kubernetesVersion: string;
  /** Release manifest reference, when known (from a NodeImage). Recorded as an annotation only */
  releaseManifest?: string;
  /** Harvester VM network as namespace/name */
  network: string;
  /** Harvester KeyPair as namespace/name (CAPHV requires one) */
  sshKeyPair: string;
  /** Control plane address announced by kube-vip */
  controlPlaneHost: string;
  controlPlane: PoolValues;
  workers: PoolValues;
}

export interface BuildOptions {
  /** Harvester kubeconfig for the identity Secret */
  kubeconfig: string;
  /** UID of the created Cluster: makes the identity Secret an owned object so it is deleted with the cluster */
  clusterUid?: string;
}

export interface WizardObject {
  /** Stable key used for progress and error messages */
  key: string;
  api: ApiRef;
  object: any;
}

export const DEFAULT_POOL: PoolValues = {
  count: 1, cpu: 2, memory: 4, disk: 40
};

export function defaultValues(): WizardValues {
  return {
    name:              '',
    namespace:         'fleet-default',
    vmNamespace:       '',
    image:             '',
    kubernetesVersion: '',
    releaseManifest:   '',
    network:           '',
    sshKeyPair:        '',
    controlPlaneHost:  '',
    controlPlane:      { ...DEFAULT_POOL },
    workers:           { ...DEFAULT_POOL, count: 0 },
  };
}

export function names(clusterName: string) {
  return {
    cluster:        clusterName,
    infraCluster:   clusterName,
    controlPlane:   `${ clusterName }-cp`,
    workerTemplate: `${ clusterName }-worker`,
    workers:        `${ clusterName }-md-0`,
    identity:       `${ clusterName }-harvester-identity`,
  };
}

const NAME_RE = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const VERSION_RE = /^v\d+\.\d+\.\d+\+rke2r\d+$/;
const REF_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?\/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export function isIPv4(value: string): boolean {
  const parts = (value || '').split('.');

  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p);
}

function positiveInt(n: any, min: number): boolean {
  return Number.isInteger(n) && n >= min;
}

/**
 * Returns a list of { field, code, params } for everything that keeps the objects from being written.
 * `code` is a key under `elemental3.validation` in the translations.
 */
export function validate(v: WizardValues): { field: string; code: string; params?: any }[] {
  const out: { field: string; code: string; params?: any }[] = [];
  const required: (keyof WizardValues)[] = ['name', 'namespace', 'vmNamespace', 'image', 'kubernetesVersion', 'network', 'sshKeyPair', 'controlPlaneHost'];

  required.forEach((field) => {
    if (!v[field]) {
      out.push({ field, code: 'required' });
    }
  });

  if (v.name && (!NAME_RE.test(v.name) || v.name.length > MAX_NAME_LENGTH)) {
    out.push({
      field: 'name', code: 'name', params: { max: MAX_NAME_LENGTH }
    });
  }
  if (v.kubernetesVersion && !VERSION_RE.test(v.kubernetesVersion)) {
    out.push({ field: 'kubernetesVersion', code: 'kubernetesVersion' });
  }
  if (v.controlPlaneHost && !isIPv4(v.controlPlaneHost)) {
    out.push({ field: 'controlPlaneHost', code: 'controlPlaneHost' });
  }
  (['image', 'network', 'sshKeyPair'] as (keyof WizardValues)[]).forEach((field) => {
    if (v[field] && !REF_RE.test(v[field] as string)) {
      out.push({ field, code: 'reference' });
    }
  });
  if (!positiveInt(v.controlPlane.count, 1)) {
    out.push({ field: 'controlPlane.count', code: 'controlPlaneCount' });
  }
  if (!positiveInt(v.workers.count, 0)) {
    out.push({ field: 'workers.count', code: 'workerCount' });
  }
  (['controlPlane', 'workers'] as ('controlPlane' | 'workers')[]).forEach((pool) => {
    (['cpu', 'memory', 'disk'] as ('cpu' | 'memory' | 'disk')[]).forEach((f) => {
      if (!positiveInt(v[pool][f], 1)) {
        out.push({ field: `${ pool }.${ f }`, code: 'size' });
      }
    });
  });

  return out;
}

/**
 * Publishes the node's address in its Node object. With `cloud-provider-name: external` the kubelet leaves
 * status.addresses to a cloud controller manager, and no Harvester cloud provider runs in the cluster
 * (the tenant's Harvester identity cannot create the credentials it needs).
 */
export const NODE_ADDRESS_SCRIPT = `#!/bin/sh
# Elemental 3: publish this node's address in its Node object (no cloud controller manager does it).
A=/var/lib/rancher/rke2/agent
N="$(cat /etc/hostname)"
for i in $(seq 1 60); do
  IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p')"
  S="$(sed -n 's/^ *server: *//p' $A/kubelet.kubeconfig 2>/dev/null | head -1)"
  if [ -n "$IP" ] && [ -n "$S" ] && curl -sf -o /dev/null -X PATCH \\
       --cacert $A/server-ca.crt --cert $A/client-kubelet.crt --key $A/client-kubelet.key \\
       -H 'Content-Type: application/merge-patch+json' "$S/api/v1/nodes/$N/status" \\
       -d "{\\"status\\":{\\"addresses\\":[{\\"type\\":\\"InternalIP\\",\\"address\\":\\"$IP\\"},{\\"type\\":\\"Hostname\\",\\"address\\":\\"$N\\"}]}}"; then
    echo "node $N address set to $IP"; exit 0
  fi
  sleep 5
done
echo "could not set the address of node $N" >&2; exit 1
`;

/** kube-vip manifest RKE2 deploys from its manifests directory: announces the control plane address. */
export function kubeVipManifest(address: string): string {
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: kube-vip
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: system:kube-vip-role
rules:
- apiGroups: [""]
  resources: ["services/status"]
  verbs: ["update"]
- apiGroups: [""]
  resources: ["services", "endpoints"]
  verbs: ["list", "get", "watch", "update"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["list", "get", "watch", "update", "patch"]
- apiGroups: ["coordination.k8s.io"]
  resources: ["leases"]
  verbs: ["list", "get", "watch", "update", "create"]
- apiGroups: ["discovery.k8s.io"]
  resources: ["endpointslices"]
  verbs: ["list", "get", "watch", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: system:kube-vip-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:kube-vip-role
subjects:
- kind: ServiceAccount
  name: kube-vip
  namespace: kube-system
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: kube-vip
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-vip
  template:
    metadata:
      labels:
        app.kubernetes.io/name: kube-vip
    spec:
      serviceAccountName: kube-vip
      hostNetwork: true
      nodeSelector:
        node-role.kubernetes.io/control-plane: "true"
      tolerations:
      - operator: Exists
      containers:
      - name: kube-vip
        image: ${ KUBE_VIP_IMAGE }
        imagePullPolicy: IfNotPresent
        args: ["manager"]
        env:
        - {name: vip_arp, value: "true"}
        - {name: port, value: "${ API_PORT }"}
        - {name: vip_nodename, valueFrom: {fieldRef: {fieldPath: spec.nodeName}}}
        - {name: vip_subnet, value: "32"}
        - {name: dns_mode, value: "first"}
        - {name: cp_enable, value: "true"}
        - {name: cp_namespace, value: "kube-system"}
        - {name: svc_enable, value: "false"}
        - {name: vip_leaderelection, value: "true"}
        - {name: vip_leasename, value: "plndr-cp-lock"}
        - {name: vip_leaseduration, value: "15"}
        - {name: vip_renewdeadline, value: "10"}
        - {name: vip_retryperiod, value: "2"}
        - {name: address, value: "${ address }"}
        securityContext:
          capabilities:
            add: ["NET_ADMIN", "NET_RAW"]
            drop: ["ALL"]
`;
}

function machineTemplate(name: string, v: WizardValues, pool: PoolValues, labels: any) {
  return {
    apiVersion: `${ API.infraMachine.group }/${ API.infraMachine.version }`,
    kind:       API.infraMachine.kind,
    metadata:   {
      name, namespace: v.namespace, labels
    },
    spec: {
      template: {
        spec: {
          cpu:        pool.cpu,
          memory:     `${ pool.memory }Gi`,
          // CAPHV requires both; the node image has no other user and the key is the only access it grants
          sshUser:    'root',
          sshKeyPair: v.sshKeyPair,
          firmware:   { efi: true },
          networks:   [v.network],
          volumes:    [{
            volumeType: 'image',
            imageName:  v.image,
            volumeSize: `${ pool.disk }Gi`,
            bootOrder:  1,
          }],
        },
      },
    },
  };
}

const nodeAddressFile = () => ({
  path: '/opt/elemental-capi/node-address.sh', permissions: '0755', content: NODE_ADDRESS_SCRIPT
});

/**
 * The objects in the order they are written. The Cluster comes first so that the identity Secret can
 * name it as owner; Cluster API tolerates references to objects that appear a moment later.
 */
export function buildObjects(v: WizardValues, opts: BuildOptions): WizardObject[] {
  const n = names(v.name);
  const ns = v.namespace;
  const labels = { [CLUSTER_NAME_LABEL]: n.cluster, [CREATED_BY_LABEL]: CREATED_BY_VALUE };
  const mdLabels = { [CLUSTER_NAME_LABEL]: n.cluster, [DEPLOYMENT_NAME_LABEL]: n.workers };
  const ref = (api: ApiRef, name: string) => ({
    apiGroup: api.group, kind: api.kind, name
  });
  const annotations: any = {};

  if (v.releaseManifest) {
    annotations[RELEASE_ANNOTATION] = v.releaseManifest;
  }

  const cluster = {
    apiVersion: `${ API.cluster.group }/${ API.cluster.version }`,
    kind:       API.cluster.kind,
    metadata:   {
      name:      n.cluster,
      namespace: ns,
      // Rancher Turtles imports the cluster into Rancher because of this label
      labels:    { [IMPORT_LABEL]: 'true', [CREATED_BY_LABEL]: CREATED_BY_VALUE },
      annotations,
    },
    spec: {
      // RKE2 defaults, stated so Cluster API and RKE2 agree
      clusterNetwork: {
        pods:     { cidrBlocks: ['10.42.0.0/16'] },
        services: { cidrBlocks: ['10.43.0.0/16'] },
      },
      controlPlaneRef:   ref(API.controlPlane, n.controlPlane),
      infrastructureRef: ref(API.infraCluster, n.infraCluster),
    },
  };

  const identity: any = {
    apiVersion: 'v1',
    kind:       'Secret',
    metadata:   {
      name: n.identity, namespace: ns, labels
    },
    type:       'Opaque',
    stringData: { kubeconfig: opts.kubeconfig },
  };

  if (opts.clusterUid) {
    identity.metadata.ownerReferences = [{
      apiVersion: cluster.apiVersion, kind: cluster.kind, name: n.cluster, uid: opts.clusterUid
    }];
  }

  const infraCluster = {
    apiVersion: `${ API.infraCluster.group }/${ API.infraCluster.version }`,
    kind:       API.infraCluster.kind,
    metadata:   {
      name: n.infraCluster, namespace: ns, labels
    },
    spec: {
      controlPlaneEndpoint: { host: v.controlPlaneHost, port: API_PORT },
      targetNamespace:      v.vmNamespace,
      identitySecret:       { name: n.identity, namespace: ns },
      // Required by the CRD
      loadBalancerConfig:   { ipamType: 'dhcp' },
    },
  };

  const controlPlane = {
    apiVersion: `${ API.controlPlane.group }/${ API.controlPlane.version }`,
    kind:       API.controlPlane.kind,
    metadata:   {
      name: n.controlPlane, namespace: ns, labels
    },
    spec: {
      replicas:           v.controlPlane.count,
      // Reported version: the node image decides which RKE2 runs, and this must name the same version
      version:            v.kubernetesVersion,
      registrationMethod: 'control-plane-endpoint',
      rolloutStrategy:    { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1 } },
      machineTemplate:    { spec: { infrastructureRef: ref(API.infraMachine, n.controlPlane) } },
      // CAPHV parses the bootstrap data as YAML
      gzipUserData:       false,
      // RKE2 ships in the node image: run the image's /opt/install.sh instead of downloading
      agentConfig:        { airGapped: true },
      serverConfig:       {
        // CAPHV sets providerID harvester://<vm uid>; RKE2's built-in cloud controller must not set its own
        cloudProviderName: 'external',
        disableComponents: { kubernetesComponents: ['cloudController'] },
      },
      files: [
        {
          path: '/var/lib/rancher/rke2/server/manifests/elemental-kube-vip.yaml', permissions: '0600', content: kubeVipManifest(v.controlPlaneHost)
        },
        nodeAddressFile(),
      ],
      postRKE2Commands: ['/opt/elemental-capi/node-address.sh'],
    },
  };

  const workerBootstrap = {
    apiVersion: `${ API.bootstrap.group }/${ API.bootstrap.version }`,
    kind:       API.bootstrap.kind,
    metadata:   {
      name: n.workerTemplate, namespace: ns, labels
    },
    spec: {
      template: {
        spec: {
          gzipUserData:     false,
          agentConfig:      { airGapped: true },
          files:            [nodeAddressFile()],
          postRKE2Commands: ['/opt/elemental-capi/node-address.sh'],
        },
      },
    },
  };

  const workers = {
    apiVersion: `${ API.md.group }/${ API.md.version }`,
    kind:       API.md.kind,
    metadata:   {
      name: n.workers, namespace: ns, labels
    },
    spec: {
      clusterName: n.cluster,
      replicas:    v.workers.count,
      selector:    { matchLabels: mdLabels },
      template:    {
        metadata: { labels: mdLabels },
        spec:     {
          clusterName:       n.cluster,
          version:           v.kubernetesVersion,
          bootstrap:         { configRef: ref(API.bootstrap, n.workerTemplate) },
          infrastructureRef: ref(API.infraMachine, n.workerTemplate),
        },
      },
    },
  };

  return [
    {
      key: 'cluster', api: API.cluster, object: cluster
    },
    {
      key: 'identity', api: API.secret, object: identity
    },
    {
      key: 'infraCluster', api: API.infraCluster, object: infraCluster
    },
    {
      key: 'controlPlane', api: API.controlPlane, object: controlPlane
    },
    {
      key: 'controlPlaneMachines', api: API.infraMachine, object: machineTemplate(n.controlPlane, v, v.controlPlane, labels)
    },
    {
      key: 'workerBootstrap', api: API.bootstrap, object: workerBootstrap
    },
    {
      key: 'workerMachines', api: API.infraMachine, object: machineTemplate(n.workerTemplate, v, v.workers, labels)
    },
    {
      key: 'workers', api: API.md, object: workers
    },
  ];
}

/** Kubernetes API collection path of an object, relative to the API root of the management cluster. */
export function collectionPath(api: ApiRef, namespace: string): string {
  const prefix = api.group ? `/apis/${ api.group }/${ api.version }` : `/api/${ api.version }`;

  return `${ prefix }/namespaces/${ namespace }/${ api.resource }`;
}
