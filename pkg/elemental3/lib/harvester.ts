/**
 * Turns what the Harvester cluster and the image build operator return into the choices the form offers.
 * No imports: plain data in, plain data out.
 */

export const NODE_IMAGE_TYPE = 'image.lifecycle.suse.com.nodeimage';

/** What must be on the management cluster, and creatable by the user, before the form can write a cluster. */
export const PREREQUISITES: { type: string; kind: string; provider: 'capi' | 'caprke2' | 'caphv' }[] = [
  {
    type: 'cluster.x-k8s.io.cluster', kind: 'Cluster', provider: 'capi'
  },
  {
    type: 'cluster.x-k8s.io.machinedeployment', kind: 'MachineDeployment', provider: 'capi'
  },
  {
    type: 'controlplane.cluster.x-k8s.io.rke2controlplane', kind: 'RKE2ControlPlane', provider: 'caprke2'
  },
  {
    type: 'bootstrap.cluster.x-k8s.io.rke2configtemplate', kind: 'RKE2ConfigTemplate', provider: 'caprke2'
  },
  {
    type: 'infrastructure.cluster.x-k8s.io.harvestercluster', kind: 'HarvesterCluster', provider: 'caphv'
  },
  {
    type: 'infrastructure.cluster.x-k8s.io.harvestermachinetemplate', kind: 'HarvesterMachineTemplate', provider: 'caphv'
  },
];

const SYSTEM_NAMESPACE_PREFIXES = ['kube-', 'cattle-', 'harvester-', 'longhorn-', 'fleet-', 'rancher-', 'cdi', 'forklift'];
const SYSTEM_NAMESPACES = ['local', 'harvester-public', 'cattle-system'];

export interface Option<T> { label: string; value: T }

export interface ReleaseValue {
  /** Harvester image as namespace/name */
  image: string;
  kubernetesVersion: string;
  releaseManifest: string;
  /** True when the image build operator delivered the image and says what it contains */
  fromOperator: boolean;
  /** True when the release and Kubernetes version are stated by the operator or by the image's annotations */
  verified: boolean;
}

export function harvesterBase(clusterId: string): string {
  return `/k8s/clusters/${ clusterId }/v1`;
}

/**
 * What the Harvester provider (CAPHV) does with its Harvester identity before it reports the
 * infrastructure as ready: it reads the Harvester deployment and creates a LoadBalancer in the VM
 * namespace, whose address then REPLACES spec.controlPlaneEndpoint of the HarvesterCluster.
 * The form asks Harvester whether the logged-in user may do both (SelfSubjectAccessReview) and
 * writes objects for the path CAPHV will actually take.
 */
export function endpointAccessReviews(vmNamespace: string): { key: string; spec: any }[] {
  return [
    {
      key:  'harvesterDeployment',
      spec: {
        resourceAttributes: {
          group: 'apps', resource: 'deployments', verb: 'get', namespace: 'harvester-system', name: 'harvester'
        }
      },
    },
    {
      key:  'loadBalancer',
      spec: {
        resourceAttributes: {
          group: 'loadbalancer.harvesterhci.io', resource: 'loadbalancers', verb: 'create', namespace: vmNamespace
        }
      },
    },
  ];
}

export type EndpointMode = 'loadBalancer' | 'address';

/** allowed: one boolean per review of endpointAccessReviews, null when the review itself failed. */
export function endpointModeFor(allowed: (boolean | null)[]): { mode: EndpointMode; certain: boolean } {
  if (allowed.length && allowed.every((a) => a === true)) {
    return { mode: 'loadBalancer', certain: true };
  }

  return { mode: 'address', certain: allowed.length > 0 && allowed.every((a) => a !== null) };
}

function byLabel<T>(a: Option<T>, b: Option<T>): number {
  return a.label.localeCompare(b.label);
}

function nsName(r: any): string {
  return r?.id || `${ r?.metadata?.namespace }/${ r?.metadata?.name }`;
}

/** Namespaces of the Harvester cluster the user may create VMs in. */
export function namespaceOptions(namespaces: any[]): Option<string>[] {
  return (namespaces || [])
    .filter((n) => !!n?.links?.update)
    .map((n) => n.metadata?.name as string)
    .filter((n) => !!n && !SYSTEM_NAMESPACES.includes(n) && !SYSTEM_NAMESPACE_PREFIXES.some((p) => n.startsWith(p)))
    .map((n) => ({ label: n, value: n }))
    .sort(byLabel);
}

export function networkOptions(networks: any[]): Option<string>[] {
  return (networks || []).map((n) => ({ label: nsName(n), value: nsName(n) })).sort(byLabel);
}

/** Key pairs of the VM namespace: CAPHV reads the key pair with the tenant's identity. */
export function keyPairOptions(keyPairs: any[], vmNamespace: string): Option<string>[] {
  return (keyPairs || [])
    .filter((k) => !vmNamespace || k.metadata?.namespace === vmNamespace)
    .map((k) => ({ label: nsName(k), value: nsName(k) }))
    .sort(byLabel);
}

function conditionTrue(r: any, type: string): boolean {
  return (r?.status?.conditions || []).some((c: any) => c.type === type && c.status === 'True');
}

/** Annotations on a Harvester image that say which Elemental release it was built from. Set by whoever imports the image. */
export const IMAGE_RELEASE_ANNOTATION = 'elemental.suse.com/release-manifest';
export const IMAGE_KUBERNETES_ANNOTATION = 'elemental.suse.com/kubernetes-version';

const IMAGE_VERSION_RE = /^v\d+\.\d+\.\d+\+rke2r\d+$/;

/**
 * Disk images in Harvester that finished importing. Installer ISOs are left out.
 *
 * An image that carries both release annotations is offered as a release and its Kubernetes version is
 * taken from the annotation. An image without them is still listed, marked as not verified: nothing in
 * Harvester says what such an image contains.
 */
export function imageOptions(images: any[]): (Option<ReleaseValue> & { name: string; release: string })[] {
  return (images || [])
    .filter((i) => conditionTrue(i, 'Imported'))
    .filter((i) => !`${ i.spec?.displayName || '' }`.toLowerCase().endsWith('.iso'))
    .map((i) => {
      const name = `${ i.metadata?.namespace }/${ i.spec?.displayName || i.metadata?.name }`;
      const annotations = i.metadata?.annotations || {};
      const manifest = `${ annotations[IMAGE_RELEASE_ANNOTATION] || '' }`.trim();
      const version = `${ annotations[IMAGE_KUBERNETES_ANNOTATION] || '' }`.trim();
      const described = !!manifest && IMAGE_VERSION_RE.test(version);

      return {
        name,
        release: described ? releaseName(manifest) : '',
        label:   name,
        value:   {
          image:             nsName(i),
          kubernetesVersion: described ? version : '',
          releaseManifest:   described ? manifest : '',
          fromOperator:      false,
          verified:          described,
        },
      };
    })
    .sort((a, b) => (a.value.verified === b.value.verified ? byLabel(a, b) : (a.value.verified ? -1 : 1)));
}

/** Short name of a release manifest reference: registry/path/rke2-manifest:1.37.2-20.3 -> rke2-manifest:1.37.2-20.3 */
export function releaseName(manifest: string): string {
  return (manifest || '').split('/').pop() || manifest;
}

/**
 * Ready NodeImage objects (image build operator) for Harvester. `status.image` names the Harvester image
 * and the RKE2 version in it, so the user picks a release and types nothing.
 */
export function nodeImageOptions(nodeImages: any[], vmNamespace: string): (Option<ReleaseValue> & { release: string })[] {
  return (nodeImages || [])
    .filter((n) => n.spec?.target?.type === 'harvester' && conditionTrue(n, 'Ready'))
    .filter((n) => !!n.status?.image?.name && !!n.status?.image?.kubernetesVersion)
    .filter((n) => !n.spec?.arch || n.spec.arch === 'x86_64')
    .filter((n) => !vmNamespace || !n.status.image.namespace || n.status.image.namespace === vmNamespace)
    .map((n) => {
      const image = `${ n.status.image.namespace || n.spec?.target?.harvester?.namespace }/${ n.status.image.name }`;
      const release = releaseName(n.spec?.release?.manifest);

      return {
        release,
        label: release,
        value: {
          image, kubernetesVersion: n.status.image.kubernetesVersion, releaseManifest: n.spec?.release?.manifest || '', fromOperator: true, verified: true
        },
      };
    })
    .filter((o, i, all) => all.findIndex((x) => x.value.image === o.value.image) === i)
    .sort(byLabel);
}

/** Readable text of whatever a failed request rejected with. */
export function errorText(e: any): string {
  if (!e) {
    return 'unknown error';
  }
  if (typeof e === 'string') {
    return e;
  }

  return e.message || e.reason || e._statusText || e.statusText || (e._status ? `HTTP ${ e._status }` : JSON.stringify(e));
}
