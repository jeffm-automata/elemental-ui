/**
 * Builds the Cluster API objects of an Elemental 3 cluster on Harvester from the wizard's form values.
 *
 * This file has no imports on purpose: it is plain data in, plain objects out, so the same objects can be
 * written with kubectl and the unit tests run without the Rancher shell.
 *
 * The object set is the one proven in the lab for generic Elemental 3 node images with a Harvester provider
 * that creates the control plane load balancer with a namespace-scoped identity, sets the node addresses and
 * knows `loadBalancerConfig.ipamType: external` (CAPHV v0.10.1 plus those three fixes; CAPRKE2 v0.25.3,
 * Cluster API v1.13 contract v1beta2, imported into Rancher by Turtles):
 * Cluster, HarvesterCluster, RKE2ControlPlane, two HarvesterMachineTemplates, RKE2ConfigTemplate,
 * MachineDeployment and the identity Secret CAPHV reads the Harvester kubeconfig from.
 */

export const IMPORT_LABEL = 'cluster-api.cattle.io/rancher-auto-import';
export const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';
export const DEPLOYMENT_NAME_LABEL = 'cluster.x-k8s.io/deployment-name';
export const CREATED_BY_LABEL = 'elemental.suse.com/created-by';
export const CREATED_BY_VALUE = 'elemental3-ui';
export const RELEASE_ANNOTATION = 'elemental.suse.com/release-manifest';
export const HARVESTER_CLUSTER_ANNOTATION = 'elemental.suse.com/harvester-cluster';
/** Rancher's creator annotation. Rancher Turtles can carry it to the imported cluster, which makes the creator its owner */
export const CREATOR_ANNOTATION = 'field.cattle.io/creatorId';

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
  /** Rancher id of the Harvester cluster the machines run on. Recorded as an annotation only */
  harvesterClusterId?: string;
  /** Rancher id of the logged-in user (for example u-abcde). Recorded as the creator annotation only */
  creatorId?: string;
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
  /**
   * Who provides the control plane address.
   * `loadBalancer` (default): a Harvester LoadBalancer that the Harvester provider creates; Harvester
   * assigns the address (DHCP) and the provider writes it into the HarvesterCluster.
   * `address` (advanced): the address in controlPlaneHost, announced by kube-vip on the control plane
   * machines; the provider is told to leave the endpoint alone (`ipamType: external`).
   */
  endpointMode?: 'address' | 'loadBalancer';
  /** Control plane address announced by kube-vip (endpointMode address only) */
  controlPlaneHost: string;
  controlPlane: PoolValues;
  workers: PoolValues;
  /**
   * Replace a worker machine whose node stays not ready (a MachineHealthCheck for the worker pool).
   * On unless set to false.
   */
  autoReplace?: boolean;
  /** Minutes a worker node may be not ready before its machine is replaced */
  autoReplaceMinutes?: number;
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
    endpointMode:      'loadBalancer',
    controlPlaneHost:  '',
    controlPlane:      { ...DEFAULT_POOL },
    workers:           { ...DEFAULT_POOL, count: 0 },
    autoReplace:       true,
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

/** The load balancer is the default: only an explicit `address` selects kube-vip. */
export function usesLoadBalancer(v: WizardValues): boolean {
  return v.endpointMode !== 'address';
}

/** RKE2's registration port: joining machines reach the first server through it */
export const RKE2_REGISTRATION_PORT = 9345;

function positiveInt(n: any, min: number): boolean {
  return Number.isInteger(n) && n >= min;
}

/**
 * Returns a list of { field, code, params } for everything that keeps the objects from being written.
 * `code` is a key under `elemental3.validation` in the translations.
 */
export function validate(v: WizardValues): { field: string; code: string; params?: any }[] {
  const out: { field: string; code: string; params?: any }[] = [];
  const required: (keyof WizardValues)[] = ['name', 'namespace', 'vmNamespace', 'image', 'kubernetesVersion', 'network', 'sshKeyPair'];

  if (!usesLoadBalancer(v)) {
    required.push('controlPlaneHost');
  }

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
  if (!usesLoadBalancer(v) && v.controlPlaneHost && !isIPv4(v.controlPlaneHost)) {
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
 * kube-vip manifest RKE2 deploys from its manifests directory: announces the control plane address.
 * Only written in `address` mode; with the Harvester load balancer there is no kube-vip.
 */
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


// ---- Automatic replacement of a failed worker (J-MANAGE-02, the automatic half) ----

export const MHC_API: ApiRef = {
  group: 'cluster.x-k8s.io', version: 'v1beta2', resource: 'machinehealthchecks', kind: 'MachineHealthCheck'
};

/** Minutes a node may be not ready or unreachable before its machine is replaced (the form's default) */
export const DEFAULT_UNHEALTHY_MINUTES = 5;

/**
 * Time a new machine has to become a node before it counts as failed. Cluster API's default is ten
 * minutes; an Elemental 3 machine on a busy host has been seen to need more than that from the VM to the
 * node, and a machine replaced for being slow is slower still.
 */
export const NODE_STARTUP_SECONDS = 30 * 60;

export function healthCheckName(poolName: string): string {
  const suffix = '-auto-replace';

  return `${ poolName.slice(0, 63 - suffix.length) }${ suffix }`;
}

/**
 * The MachineHealthCheck of one worker pool: a machine whose node is not ready, or not heard of, for
 * `minutes` is deleted by Cluster API and the pool creates another one. No limit on how many machines of
 * the pool may be unhealthy at once, as with the "auto replace" setting of a provisioning v2 pool: with a
 * limit a pool of one machine would never be remediated. Cluster API makes the Cluster the owner, so the
 * object goes with the cluster. Control plane machines are not selected.
 */
export function healthCheck(clusterName: string, namespace: string, poolName: string, minutes: number = DEFAULT_UNHEALTHY_MINUTES): any {
  const timeoutSeconds = minutes * 60;

  return {
    apiVersion: `${ MHC_API.group }/${ MHC_API.version }`,
    kind:       MHC_API.kind,
    metadata:   {
      name:   healthCheckName(poolName),
      namespace,
      labels: { [CLUSTER_NAME_LABEL]: clusterName, [CREATED_BY_LABEL]: CREATED_BY_VALUE },
    },
    spec: {
      clusterName,
      selector: { matchLabels: { [DEPLOYMENT_NAME_LABEL]: poolName } },
      checks:   {
        nodeStartupTimeoutSeconds: NODE_STARTUP_SECONDS,
        unhealthyNodeConditions:   [
          {
            type: 'Ready', status: 'False', timeoutSeconds
          },
          {
            type: 'Ready', status: 'Unknown', timeoutSeconds
          },
        ],
      },
    },
  };
}

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
  if (v.creatorId) {
    annotations[CREATOR_ANNOTATION] = v.creatorId;
  }
  if (v.harvesterClusterId) {
    annotations[HARVESTER_CLUSTER_ANNOTATION] = v.harvesterClusterId;
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

  // One source for the control plane address, never two.
  // `loadBalancer`: the Harvester provider creates a Harvester LoadBalancer (address by DHCP) and writes
  // its address into spec.controlPlaneEndpoint itself; the form writes neither an endpoint nor kube-vip.
  // The extra listener is RKE2's registration port: joining machines reach the first server through it.
  // `address`: the form's address is the endpoint, kube-vip announces it, and `external` tells the
  // provider to create no load balancer and to leave the endpoint as written. Never `dhcp` together
  // with a typed address: the provider would replace the address.
  const lb = usesLoadBalancer(v);
  const infraSpec: any = {
    targetNamespace: v.vmNamespace,
    identitySecret:  { name: n.identity, namespace: ns },
  };

  if (lb) {
    infraSpec.loadBalancerConfig = {
      ipamType:  'dhcp',
      listeners: [{
        name: 'rke2-server', port: RKE2_REGISTRATION_PORT, protocol: 'TCP', backendPort: RKE2_REGISTRATION_PORT
      }],
    };
  } else {
    infraSpec.loadBalancerConfig = { ipamType: 'external' };
    infraSpec.controlPlaneEndpoint = { host: v.controlPlaneHost, port: API_PORT };
  }

  const infraCluster = {
    apiVersion: `${ API.infraCluster.group }/${ API.infraCluster.version }`,
    kind:       API.infraCluster.kind,
    metadata:   {
      name: n.infraCluster, namespace: ns, labels
    },
    spec: infraSpec,
  };

  const controlPlane: any = {
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
    },
  };

  // No files at all with the load balancer. The Harvester provider publishes the node addresses itself,
  // so no machine carries a script for that any more
  if (!lb) {
    controlPlane.spec.files = [{
      path: '/var/lib/rancher/rke2/server/manifests/elemental-kube-vip.yaml', permissions: '0600', content: kubeVipManifest(v.controlPlaneHost)
    }];
  }

  const workerBootstrap = {
    apiVersion: `${ API.bootstrap.group }/${ API.bootstrap.version }`,
    kind:       API.bootstrap.kind,
    metadata:   {
      name: n.workerTemplate, namespace: ns, labels
    },
    spec: {
      template: {
        spec: {
          gzipUserData: false,
          agentConfig:  { airGapped: true },
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

  const out: WizardObject[] = [
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

  // Last: everything it refers to exists, and a cluster without it is complete
  if (v.autoReplace !== false) {
    out.push({
      key: 'workerHealthCheck', api: MHC_API, object: healthCheck(n.cluster, ns, n.workers, v.autoReplaceMinutes || DEFAULT_UNHEALTHY_MINUTES)
    });
  }

  return out;
}

/** Kubernetes API collection path of an object, relative to the API root of the management cluster. */
export function collectionPath(api: ApiRef, namespace: string): string {
  const prefix = api.group ? `/apis/${ api.group }/${ api.version }` : `/api/${ api.version }`;

  return `${ prefix }/namespaces/${ namespace }/${ api.resource }`;
}

/** Path of one object. */
export function objectPath(api: ApiRef, namespace: string, name: string): string {
  return `${ collectionPath(api, namespace) }/${ name }`;
}

/** Kinds the detail page reads but the wizard does not write. */
export const READ_API = {
  machine: {
    group: 'cluster.x-k8s.io', version: 'v1beta2', resource: 'machines', kind: 'Machine'
  },
  event: {
    group: '', version: 'v1', resource: 'events', kind: 'Event'
  },
};

/** Body of a SelfSubjectAccessReview for one verb on one resource. */
export function accessReview(api: ApiRef, verb: string, namespace: string, name?: string): any {
  const resourceAttributes: any = {
    group: api.group, resource: api.resource, verb, namespace
  };

  if (name) {
    resourceAttributes.name = name;
  }

  return {
    apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes }
  };
}

export const ACCESS_REVIEW_PATH = '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews';

/** "patch machinedeployments.cluster.x-k8s.io in namespace x": the right as it has to be granted. */
export function rightText(api: ApiRef, verb: string, namespace?: string): string {
  const res = api.group ? `${ api.resource }.${ api.group }` : api.resource;

  return namespace ? `${ verb } ${ res } in namespace ${ namespace }` : `${ verb } ${ res }`;
}

// ---- Change the machine size of a worker pool (J-MANAGE-08, the machine size part) ----

export interface MachineSize {
  cpu: number;
  /** GiB */
  memory: number;
}

/** CPUs and memory (GiB) of a HarvesterMachineTemplate; null when it does not say them in a form this page can edit. */
export function templateSize(template: any): MachineSize | null {
  const t = template?.spec?.template?.spec;
  const m = /^(\d+)Gi$/.exec(`${ t?.memory || '' }`);

  return t && Number.isInteger(t.cpu) && m ? { cpu: t.cpu, memory: Number(m[1]) } : null;
}

export function validSize(size: MachineSize): boolean {
  return Number.isInteger(size.cpu) && size.cpu >= 1 && Number.isInteger(size.memory) && size.memory >= 1;
}

/**
 * Machine templates are immutable for Cluster API: a pool gets another size by pointing it at a new
 * template, which rolls its machines (a new machine first, then the old one is drained and deleted).
 * Returns the new template: the current one with the size changed, under a new name. Everything the
 * server owns (uid, resourceVersion, owner references, status) is left out; Cluster API makes the
 * Cluster the owner of a template as soon as a pool refers to it.
 * `stamp` makes the name unique (the page passes the time); the name stays within 63 characters.
 */
export function resizedMachineTemplate(current: any, poolName: string, size: MachineSize, stamp: string): any {
  const suffix = `-${ size.cpu }c${ size.memory }g-${ stamp }`;
  const spec = JSON.parse(JSON.stringify(current?.spec || {}));

  spec.template = spec.template || {};
  // The API server returns an empty spec.template.metadata and refuses one in a new object
  if (spec.template.metadata && !Object.keys(spec.template.metadata).length) {
    delete spec.template.metadata;
  }
  spec.template.spec = {
    ...(spec.template.spec || {}), cpu: size.cpu, memory: `${ size.memory }Gi`
  };

  return {
    apiVersion: current?.apiVersion || `${ API.infraMachine.group }/${ API.infraMachine.version }`,
    kind:       API.infraMachine.kind,
    metadata:   {
      name:      `${ poolName.slice(0, 63 - suffix.length) }${ suffix }`,
      namespace: current?.metadata?.namespace,
      labels:    current?.metadata?.labels || {},
    },
    spec,
  };
}

/** Merge patch that points a MachineDeployment at another machine template. Only the name changes. */
export function poolTemplatePatch(templateName: string): any {
  return { spec: { template: { spec: { infrastructureRef: { name: templateName } } } } };
}
