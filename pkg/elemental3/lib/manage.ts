/**
 * Manage journeys on a running cluster: automatic replacement of failed worker machines, node labels of a
 * worker pool, certificate rotation by replacing the machines, etcd snapshots.
 *
 * As everywhere in this package the page only writes objects a user could apply with kubectl; the work is
 * done by Cluster API, the RKE2 provider and RKE2 itself. No dependencies.
 */
import {
  API, ApiRef, CREATED_BY_LABEL, CREATED_BY_VALUE, DEPLOYMENT_NAME_LABEL
} from './objects';

export {
  MHC_API, DEFAULT_UNHEALTHY_MINUTES, NODE_STARTUP_SECONDS, healthCheck, healthCheckName
} from './objects';

// ---- Automatic replacement of a failed worker (J-MANAGE-02, the automatic half) ----

export const MAX_UNHEALTHY_MINUTES = 24 * 60;

export function validMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_UNHEALTHY_MINUTES;
}

/** The health check that selects the machines of a pool, whoever wrote it; undefined when there is none. */
export function healthCheckFor(checks: any[] | null | undefined, clusterName: string, poolName: string): any {
  return (checks || []).find((c) => c?.spec?.clusterName === clusterName && c?.spec?.selector?.matchLabels?.[DEPLOYMENT_NAME_LABEL] === poolName);
}

export interface HealthCheckSummary {
  name: string;
  /** Minutes until a not ready node is replaced; 0 when the object states no node condition */
  minutes: number;
  /** Machines the check watches and how many of them it finds healthy; undefined until the controller reports */
  expected?: number;
  healthy?: number;
  /** False while the check is not allowed to remediate (its limit is exceeded, or it is paused) */
  remediating: boolean;
}

export function healthCheckSummary(check: any): HealthCheckSummary | null {
  if (!check) {
    return null;
  }
  const seconds = (check.spec?.checks?.unhealthyNodeConditions || []).map((c: any) => Number(c.timeoutSeconds)).filter((s: number) => s > 0);
  const allowed = (check.status?.conditions || []).find((c: any) => c.type === 'RemediationAllowed');

  return {
    name:        check.metadata?.name || '',
    minutes:     seconds.length ? Math.round(Math.min(...seconds) / 60) : 0,
    expected:    check.status?.expectedMachines,
    healthy:     check.status?.currentHealthy,
    remediating: !allowed || allowed.status !== 'False',
  };
}

// ---- Node labels of a worker pool (J-MANAGE-08, the node label part) ----

const LABEL_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_PREFIX = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

export interface ParsedLabels {
  /** `key=value`, in the order typed, a repeated key keeps its last value */
  labels: string[];
  /** Entries that are not valid, each with the reason code `syntax`, `key`, `value` or `reserved` */
  errors: { entry: string; code: string }[];
}

/**
 * Labels as typed: `key=value` separated by commas, blanks or line ends. A key in the `kubernetes.io` or
 * `k8s.io` name spaces is refused: the kubelet refuses to start with most of them, and a machine that
 * cannot start its kubelet never becomes a node.
 */
export function parseLabels(text: string): ParsedLabels {
  const out: ParsedLabels = { labels: [], errors: [] };
  const seen: { [key: string]: number } = {};

  `${ text || '' }`.split(/[\s,]+/).filter((e) => !!e).forEach((entry) => {
    const eq = entry.indexOf('=');

    if (eq < 1) {
      out.errors.push({ entry, code: 'syntax' });

      return;
    }
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    const slash = key.lastIndexOf('/');
    const prefix = slash >= 0 ? key.slice(0, slash) : '';
    const name = slash >= 0 ? key.slice(slash + 1) : key;

    if (!LABEL_NAME.test(name) || (slash >= 0 && (!LABEL_PREFIX.test(prefix) || prefix.length > 253))) {
      out.errors.push({ entry, code: 'key' });
    } else if (/(^|\.)(kubernetes|k8s)\.io$/.test(prefix)) {
      out.errors.push({ entry, code: 'reserved' });
    } else if (value !== '' && !LABEL_NAME.test(value)) {
      out.errors.push({ entry, code: 'value' });
    } else if (key in seen) {
      out.labels[seen[key]] = entry;
    } else {
      seen[key] = out.labels.length;
      out.labels.push(entry);
    }
  });

  return out;
}

/** Node labels a bootstrap template gives every machine made from it (`agentConfig.nodeLabels`). */
export function poolLabels(bootstrapTemplate: any): string[] {
  const l = bootstrapTemplate?.spec?.template?.spec?.agentConfig?.nodeLabels;

  return Array.isArray(l) ? l.map((x: any) => `${ x }`) : [];
}

export function sameLabels(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/**
 * Bootstrap templates are immutable for Cluster API, as machine templates are: a pool gets other node
 * labels by pointing it at a new template, which rolls its machines. Returns the new template: the
 * current one with the labels replaced, under a new name, without anything the server owns.
 */
export function relabelledBootstrapTemplate(current: any, poolName: string, labels: string[], stamp: string): any {
  const suffix = `-labels-${ stamp }`;
  const spec = JSON.parse(JSON.stringify(current?.spec || {}));

  spec.template = spec.template || {};
  if (spec.template.metadata && !Object.keys(spec.template.metadata).length) {
    delete spec.template.metadata;
  }
  spec.template.spec = spec.template.spec || {};
  const agentConfig = { ...(spec.template.spec.agentConfig || {}) };

  if (labels.length) {
    agentConfig.nodeLabels = [...labels];
  } else {
    delete agentConfig.nodeLabels;
  }
  spec.template.spec.agentConfig = agentConfig;

  return {
    apiVersion: current?.apiVersion || `${ API.bootstrap.group }/${ API.bootstrap.version }`,
    kind:       API.bootstrap.kind,
    metadata:   {
      name:      `${ poolName.slice(0, 63 - suffix.length) }${ suffix }`,
      namespace: current?.metadata?.namespace,
      labels:    current?.metadata?.labels || {},
    },
    spec,
  };
}

export function poolBootstrapPatch(templateName: string): any {
  return { spec: { template: { spec: { bootstrap: { configRef: { name: templateName } } } } } };
}

// ---- Certificate rotation by replacing the machines (J-MANAGE-05) ----

/** Node annotation that records the request on control plane nodes; changing it is what rolls them */
export const ROTATED_ANNOTATION = 'elemental.suse.com/certificates-rotated';

export type RotateScope = 'all' | 'controlPlane' | 'workers';

export interface RotatePatch {
  api: ApiRef;
  name: string;
  patch: any;
}

/** RFC 3339 without fractions of a second, as Cluster API's `rollout.after` is written */
export function rotationStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d+Z$/, 'Z');
}

/**
 * Every RKE2 node gets its certificates from the cluster's certificate authorities when it joins, valid
 * from that day. Replacing the machines therefore rotates every service certificate, one machine at a
 * time and with a drain, and needs nothing on the nodes.
 * Workers: `spec.rollout.after` of the MachineDeployment, Cluster API's own field for "replace all
 * machines created before". The RKE2ControlPlane has no such field: it replaces its machines when their
 * bootstrap configuration changes, so the request is recorded as a node annotation in `agentConfig`.
 * The control plane first in the list: its patch is the one that can be refused.
 */
export function rotatePatches(scope: RotateScope, controlPlaneName: string, poolNames: string[], stamp: string): RotatePatch[] {
  const out: RotatePatch[] = [];

  if (scope !== 'workers' && controlPlaneName) {
    out.push({
      api: API.controlPlane, name: controlPlaneName, patch: { spec: { agentConfig: { nodeAnnotations: { [ROTATED_ANNOTATION]: stamp } } } }
    });
  }
  if (scope !== 'controlPlane') {
    poolNames.forEach((name) => out.push({
      api: API.md, name, patch: { spec: { rollout: { after: stamp } } }
    }));
  }

  return out;
}

export interface Rotation {
  /** When the last rotation was requested, '' when never */
  controlPlane: string;
  workers: string;
}

export function lastRotation(controlPlane: any, machineDeployments: any[] | null | undefined): Rotation {
  const workers = (machineDeployments || []).map((md) => `${ md?.spec?.rollout?.after || '' }`).filter((x) => !!x).sort();

  return {
    controlPlane: `${ controlPlane?.spec?.agentConfig?.nodeAnnotations?.[ROTATED_ANNOTATION] || '' }`,
    workers:      workers.length ? workers[workers.length - 1] : '',
  };
}

export interface RotationProgress {
  /** Machines of the scope created after the request and running */
  replaced: number;
  /** Machines the scope wants */
  wanted: number;
  /** Machines created before the request that still exist */
  old: number;
  done: boolean;
}

/**
 * How far a requested rotation is, from the machines alone: a machine created after the request has new
 * certificates. `machines` are rows with role, phase and creation time.
 */
export function rotationProgress(requested: string, machines: { role: string; phase: string; created: string }[], role: 'controlPlane' | 'worker', wanted: number): RotationProgress | null {
  const at = Date.parse(requested);

  if (!requested || Number.isNaN(at)) {
    return null;
  }
  const mine = machines.filter((m) => m.role === role);
  // Creation times have whole seconds, and so has the request: a machine created in the same second is new
  const isNew = (m: { created: string }) => Date.parse(m.created) >= at;
  const replaced = mine.filter((m) => isNew(m) && m.phase === 'Running').length;
  const old = mine.filter((m) => !isNew(m)).length;

  return {
    replaced, wanted, old, done: old === 0 && replaced >= wanted
  };
}

// ---- etcd snapshots (J-MANAGE-03) ----

/** RKE2 records every snapshot it knows as an object of this kind in the workload cluster */
export const SNAPSHOT_FILES_PATH = '/apis/k3s.cattle.io/v1/etcdsnapshotfiles';

/** What RKE2 does when nothing is configured: a snapshot every twelve hours on every server, five kept */
export const DEFAULT_SNAPSHOT_CRON = '0 */12 * * *';
export const DEFAULT_SNAPSHOT_RETENTION = 5;

export interface SnapshotRow {
  name: string;
  node: string;
  /** `file://…` on the node, or `s3://…` */
  location: string;
  s3: boolean;
  /** Bytes; 0 when not reported */
  size: number;
  created: string;
  ready: boolean;
  error: string;
}

export function snapshotRows(items: any[] | null | undefined): SnapshotRow[] {
  return (items || []).map((s) => {
    const location = `${ s?.spec?.location || s?.status?.location || '' }`;

    return {
      name:    `${ s?.spec?.snapshotName || s?.metadata?.name || '' }`,
      node:    `${ s?.spec?.nodeName || '' }`,
      location,
      s3:      !!s?.spec?.s3 || location.startsWith('s3://'),
      size:    Number(s?.status?.size) || 0,
      created: `${ s?.status?.creationTime || s?.metadata?.creationTimestamp || '' }`,
      ready:   s?.status?.readyToUse === true,
      error:   `${ s?.status?.error?.message || '' }`,
    };
  }).sort((a, b) => b.created.localeCompare(a.created) || a.name.localeCompare(b.name));
}

export function sizeText(bytes: number): string {
  if (!bytes) {
    return '';
  }

  return bytes >= 1024 * 1024 ? `${ (bytes / 1024 / 1024).toFixed(1) } MiB` : `${ Math.ceil(bytes / 1024) } KiB`;
}

export interface SnapshotSchedule {
  /** false: automatic snapshots are switched off */
  enabled: boolean;
  cron: string;
  retention: number;
  /** True when the control plane object states the value; false when it is RKE2's default */
  stated: boolean;
  /** S3 target as configured (endpoint/bucket), '' when snapshots stay on the nodes */
  s3: string;
  s3Config: S3Target | null;
}

export interface S3Target {
  /** Host and optional port, without a scheme */
  endpoint: string;
  bucket: string;
  folder: string;
  region: string;
  /** Do not verify the endpoint's certificate */
  skipTlsVerify: boolean;
}

/** The schedule as the RKE2ControlPlane states it, with RKE2's defaults where it states nothing. */
export function snapshotSchedule(controlPlane: any): SnapshotSchedule {
  const b = controlPlane?.spec?.serverConfig?.etcd?.backupConfig || {};
  const retention = Number(b.retention);

  return {
    enabled:   b.disableAutomaticSnapshots !== true,
    cron:      `${ b.scheduleCron || DEFAULT_SNAPSHOT_CRON }`,
    retention: Number.isInteger(retention) && retention > 0 ? retention : DEFAULT_SNAPSHOT_RETENTION,
    stated:    !!b.scheduleCron || !!b.retention || b.disableAutomaticSnapshots === true,
    s3:        b.s3?.endpoint ? `${ b.s3.endpoint }/${ b.s3.bucket || '' }` : '',
    s3Config:  b.s3?.endpoint ? {
      endpoint: `${ b.s3.endpoint }`, bucket: `${ b.s3.bucket || '' }`, folder: `${ b.s3.folder || '' }`, region: `${ b.s3.region || '' }`, skipTlsVerify: b.s3.enforceSslVerify !== true
    } : null,
  };
}

const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

/** Five fields of numbers, ranges, lists and steps: what RKE2's scheduler takes, without month and day names. */
export function validCron(text: string): boolean {
  const fields = `${ text || '' }`.trim().split(/\s+/);

  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
}

export function validRetention(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 1000;
}

const S3_ENDPOINT = /^[A-Za-z0-9]([-A-Za-z0-9.]*[A-Za-z0-9])?(:\d{1,5})?$/;
const S3_BUCKET = /^[a-z0-9][-a-z0-9.]{1,61}[a-z0-9]$/;

/** Field names of an S3 target that are not usable: `endpoint` (host or host:port, no scheme) and `bucket`. */
export function invalidS3(t: S3Target): string[] {
  const out: string[] = [];

  if (!S3_ENDPOINT.test(t.endpoint.trim())) {
    out.push('endpoint');
  }
  if (!S3_BUCKET.test(t.bucket.trim())) {
    out.push('bucket');
  }

  return out;
}

export function sameS3(a: S3Target | null, b: S3Target | null): boolean {
  return (!a && !b) || (!!a && !!b && a.endpoint.trim() === b.endpoint.trim() && a.bucket.trim() === b.bucket.trim() && a.folder.trim() === b.folder.trim() && a.region.trim() === b.region.trim() && a.skipTlsVerify === b.skipTlsVerify);
}

/**
 * The Secret the RKE2 provider reads the S3 keys from (`aws_access_key_id`, `aws_secret_access_key`),
 * owned by the Cluster so that it goes with it. A new name every time: the page cannot read or change
 * a Secret it wrote earlier, only write another one.
 */
export function s3Secret(clusterName: string, namespace: string, clusterUid: string, accessKey: string, secretKey: string, stamp: string): any {
  const suffix = `-etcd-s3-${ stamp }`;
  const metadata: any = {
    name:   `${ clusterName.slice(0, 63 - suffix.length) }${ suffix }`,
    namespace,
    labels: { 'cluster.x-k8s.io/cluster-name': clusterName, [CREATED_BY_LABEL]: CREATED_BY_VALUE },
  };

  if (clusterUid) {
    metadata.ownerReferences = [{
      apiVersion: `${ API.cluster.group }/${ API.cluster.version }`, kind: API.cluster.kind, name: clusterName, uid: clusterUid
    }];
  }

  return {
    apiVersion: 'v1', kind: 'Secret', metadata, type: 'Opaque', stringData: { aws_access_key_id: accessKey, aws_secret_access_key: secretKey }
  };
}

/**
 * The schedule is RKE2 server configuration: the RKE2 provider writes it into the configuration of new
 * control plane machines only, so a change replaces the control plane machines one by one.
 * `s3`: undefined leaves the S3 target as it is, null removes it, a target with the name of its Secret sets it.
 */
export function schedulePatch(cron: string, retention: number, s3?: (S3Target & { secretName: string; secretNamespace: string }) | null): any {
  const backupConfig: any = { scheduleCron: cron.trim().replace(/\s+/g, ' '), retention: `${ retention }` };

  if (s3 === null) {
    backupConfig.s3 = null;
  } else if (s3) {
    backupConfig.s3 = {
      endpoint:           s3.endpoint.trim(),
      bucket:             s3.bucket.trim(),
      folder:             s3.folder.trim() || null,
      region:             s3.region.trim() || null,
      enforceSslVerify:   !s3.skipTlsVerify,
      s3CredentialSecret: { name: s3.secretName, namespace: s3.secretNamespace },
    };
  }

  return { spec: { serverConfig: { etcd: { backupConfig } } } };
}

/** Name prefix RKE2 gives a snapshot taken with `rke2 etcd-snapshot save --name <prefix>` */
export const ON_DEMAND_PREFIX = 'on-demand';
export const SNAPSHOT_JOB_NAMESPACE = 'kube-system';
export const SNAPSHOT_JOB_LABEL = 'elemental.suse.com/etcd-snapshot';

/**
 * "Snapshot now": a Job in the workload cluster that runs `rke2 etcd-snapshot save` on one server node.
 * Neither Cluster API nor the RKE2 provider has an object for a snapshot on request, so this is the one
 * place where the page starts work on a node itself. The pod runs privileged on a control plane node and
 * enters the host's namespaces to call the node's own `rke2` binary; `image` only has to contain
 * `nsenter`. The Job removes itself an hour after it finished.
 */
export const SNAPSHOT_IMAGE = 'registry.suse.com/bci/bci-busybox:15.7';

export function snapshotJob(stamp: string, image: string = SNAPSHOT_IMAGE): any {
  const name = `elemental-etcd-snapshot-${ stamp }`;
  const command = `PATH=/var/lib/rancher/rke2/bin:/opt/rke2/bin:/usr/local/bin:/usr/bin:/bin:$PATH rke2 etcd-snapshot save --name ${ ON_DEMAND_PREFIX }`;

  return {
    apiVersion: 'batch/v1',
    kind:       'Job',
    metadata:   {
      name, namespace: SNAPSHOT_JOB_NAMESPACE, labels: { [SNAPSHOT_JOB_LABEL]: 'true', [CREATED_BY_LABEL]: CREATED_BY_VALUE }
    },
    spec: {
      backoffLimit:            0,
      ttlSecondsAfterFinished: 3600,
      template:                {
        metadata: { labels: { [SNAPSHOT_JOB_LABEL]: 'true' } },
        spec:     {
          restartPolicy: 'Never',
          hostPID:       true,
          hostNetwork:   true,
          nodeSelector:  { 'node-role.kubernetes.io/etcd': 'true' },
          tolerations:   [{ operator: 'Exists' }],
          containers:    [{
            name:            'snapshot',
            image,
            // Short options: BusyBox knows no long ones
            command:         ['nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-c', command],
            securityContext: { privileged: true },
          }],
        },
      },
    },
  };
}

export type SnapshotJobState = 'running' | 'done' | 'failed';

export function snapshotJobState(job: any): SnapshotJobState {
  if (Number(job?.status?.succeeded) > 0) {
    return 'done';
  }
  if (Number(job?.status?.failed) > 0 || (job?.status?.conditions || []).some((c: any) => c.type === 'Failed' && c.status === 'True')) {
    return 'failed';
  }

  return 'running';
}
