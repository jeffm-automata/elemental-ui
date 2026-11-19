/**
 * The Elemental release of a cluster and its upgrade, as the detail page shows it.
 *
 * One `Release` object (lifecycle.suse.com/v1alpha1) in the workload cluster names a release manifest
 * version and the registry it comes from. The Lifecycle Manager in the cluster upgrades the OS, RKE2 and
 * the release's Helm charts to that one version and reports each phase as a condition. The UI writes that
 * one object and shows its conditions. No imports: plain data in, plain data out.
 */

export const RELEASE_API = {
  group: 'lifecycle.suse.com', version: 'v1alpha1', resource: 'releases', kind: 'Release'
};
/** Where the Lifecycle Manager is installed by the release's chart */
export const RELEASE_NAMESPACE = 'elemental-system';

export type UpgradePhaseState = 'done' | 'active' | 'waiting' | 'error' | 'skipped';

export interface UpgradePhase {
  type: string;
  state: UpgradePhaseState;
  reason: string;
  message: string;
  since: string;
}

/** The Lifecycle Manager's phases in the order it runs them. `Applied` is the summary and is not a phase. */
export const UPGRADE_PHASES = ['ManifestResolved', 'LCMUpgraded', 'PriorityHelmChartsUpgraded', 'OSUpgraded', 'KubernetesUpgraded', 'HelmChartsUpgraded'];

export interface ReleaseRef {
  /** OCI repository of the release manifest, without tag */
  registry: string;
  /** Manifest version (the tag) */
  version: string;
}

/** registry/path/rke2-manifest:1.37.2-20.3 -> { registry: registry/path/rke2-manifest, version: 1.37.2-20.3 } */
export function parseManifestRef(ref: string): ReleaseRef | null {
  const clean = (ref || '').trim().replace(/^oci:\/\//, '');
  const slash = clean.lastIndexOf('/');
  const colon = clean.lastIndexOf(':');

  if (!clean || colon <= slash || colon === clean.length - 1) {
    return null;
  }

  return { registry: clean.slice(0, colon), version: clean.slice(colon + 1) };
}

export function manifestRef(r: ReleaseRef): string {
  return `${ r.registry }:${ r.version }`;
}

interface Semver { core: number[]; pre: string[] }

/** Semantic version as the Lifecycle Manager reads it (a leading "v" is tolerated). null when it is not one. */
export function parseVersion(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec((v || '').trim());

  if (!m) {
    return null;
  }

  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/**
 * Semantic version precedence: negative when a < b, 0 when equal, positive when a > b; NaN when either
 * is not a semantic version. Note that "1.37.2-20.3" is, by these rules, a pre-release of 1.37.2:
 * the build number of an Elemental release sits in the pre-release field.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);

  if (!x || !y) {
    return NaN;
  }
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) {
      return x.core[i] - y.core[i];
    }
  }
  if (!x.pre.length || !y.pre.length) {
    return (x.pre.length ? 0 : 1) - (y.pre.length ? 0 : 1);
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];

    if (p === undefined || q === undefined) {
      return p === undefined ? -1 : 1;
    }
    if (p === q) {
      continue;
    }
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);

    if (pn && qn) {
      return Number(p) - Number(q);
    }
    if (pn !== qn) {
      return pn ? -1 : 1;
    }

    return p < q ? -1 : 1;
  }

  return 0;
}

function cond(release: any, type: string): any {
  return (release?.status?.conditions || []).find((c: any) => c.type === type);
}

function phaseState(c: any): UpgradePhaseState {
  if (!c) {
    return 'waiting';
  }
  if (c.reason === 'Skipped') {
    return 'skipped';
  }
  if (c.status === 'True') {
    return 'done';
  }
  if (c.reason === 'Failed') {
    return 'error';
  }
  if (c.reason === 'InProgress') {
    return 'active';
  }

  return 'waiting';
}

/** True when the conditions describe the current spec and not the one before the last edit. */
export function isObserved(release: any): boolean {
  const gen = release?.metadata?.generation;
  const seen = release?.status?.observedGeneration;

  return !gen || !seen || seen >= gen;
}

export function upgradePhases(release: any): UpgradePhase[] {
  const fresh = isObserved(release);

  return UPGRADE_PHASES.map((type) => {
    const c = cond(release, type);

    return {
      type,
      state:   fresh ? phaseState(c) : 'waiting',
      reason:  fresh ? (c?.reason || '') : '',
      message: fresh ? (c?.message || '') : '',
      since:   fresh ? (c?.lastTransitionTime || '') : '',
    };
  });
}

export type UpgradeState = 'none' | 'pending' | 'inProgress' | 'failed' | 'applied';

/** Overall state of the cluster's Release. */
export function upgradeState(release: any): UpgradeState {
  if (!release) {
    return 'none';
  }
  if (!isObserved(release)) {
    return 'pending';
  }
  const applied = cond(release, 'Applied');

  if (applied?.status === 'True' && release.status?.version === release.spec?.version) {
    return 'applied';
  }
  const phases = upgradePhases(release);

  if (applied?.reason === 'Failed' || phases.some((p) => p.state === 'error')) {
    return 'failed';
  }
  if (!applied && !phases.some((p) => p.state !== 'waiting')) {
    return 'pending';
  }

  return 'inProgress';
}

/** Version the cluster runs now according to the Lifecycle Manager; '' when no Release was ever applied. */
export function appliedVersion(release: any): string {
  return release?.status?.version || '';
}

export interface ReleaseOption {
  registry: string;
  version: string;
  /** Where the UI learned about this release */
  source: 'nodeImage' | 'image' | 'cluster';
}

export interface OfferedRelease extends ReleaseOption {
  /** Why this release is not a valid target; '' when it is offered */
  blocked: '' | 'notNewer' | 'notComparable' | 'otherLineage';
}

/**
 * Releases a cluster can be upgraded to, out of the releases the management side knows about.
 * A release is offered when it is newer than the current one and comes from the same manifest
 * repository (the same solution lineage). The rest is returned with the reason, so the page can say
 * why it is not offered instead of silently hiding it.
 */
export function offeredReleases(known: ReleaseOption[], current: ReleaseRef | null): OfferedRelease[] {
  const seen: string[] = [];
  const out: OfferedRelease[] = [];

  (known || []).forEach((k) => {
    const key = manifestRef(k);

    if (!k.registry || !k.version || seen.includes(key)) {
      return;
    }
    seen.push(key);
    let blocked: OfferedRelease['blocked'] = '';

    if (current?.version) {
      const cmp = compareVersions(k.version, current.version);

      if (Number.isNaN(cmp)) {
        blocked = 'notComparable';
      } else if (cmp <= 0) {
        blocked = 'notNewer';
      }
    }
    if (!blocked && current?.registry && repositoryName(current.registry) !== repositoryName(k.registry)) {
      blocked = 'otherLineage';
    }
    out.push({ ...k, blocked });
  });

  return out.sort((a, b) => {
    const cmp = compareVersions(b.version, a.version);

    return Number.isNaN(cmp) ? a.version.localeCompare(b.version) : cmp;
  });
}

/** Last path element of a manifest repository: the lineage (rke2-manifest, or a solution's manifest). */
export function repositoryName(registry: string): string {
  return (registry || '').split('/').pop() || '';
}

/** The Release object the UI writes. `existing` is the cluster's Release when there is one (only one may exist). */
export function buildRelease(clusterName: string, target: ReleaseRef, existing?: any): any {
  return {
    apiVersion: `${ RELEASE_API.group }/${ RELEASE_API.version }`,
    kind:       RELEASE_API.kind,
    metadata:   {
      name:      existing?.metadata?.name || `${ clusterName }-release`,
      namespace: existing?.metadata?.namespace || RELEASE_NAMESPACE,
    },
    spec: { version: target.version, registry: target.registry },
  };
}

export interface NodeFacts {
  name: string;
  ready: boolean;
  cordoned: boolean;
  kubelet: string;
  osImage: string;
  kernel: string;
  roles: string;
}

export function nodeFacts(nodes: any[]): NodeFacts[] {
  return (nodes || []).map((n) => {
    const labels = n.metadata?.labels || {};
    const roles = Object.keys(labels).filter((l) => l.startsWith('node-role.kubernetes.io/') && labels[l] === 'true').map((l) => l.split('/')[1]).sort()
      .join(', ');

    return {
      name:     n.metadata?.name || '',
      ready:    (n.status?.conditions || []).some((c: any) => c.type === 'Ready' && c.status === 'True'),
      cordoned: n.spec?.unschedulable === true,
      kubelet:  n.status?.nodeInfo?.kubeletVersion || '',
      osImage:  n.status?.nodeInfo?.osImage || '',
      kernel:   n.status?.nodeInfo?.kernelVersion || '',
      roles:    roles || 'worker',
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export interface PreflightCheck {
  key: 'settled' | 'nodesReady' | 'noneCordoned' | 'noUpgradeRunning' | 'newer' | 'accepted';
  /** null: could not be checked */
  passed: boolean | null;
  params: Record<string, any>;
}

/**
 * What can be checked before the Release is written, from what the user can read. `dryRunError` is the
 * API server's answer to a server-side dry run of the very object that would be written (the Lifecycle
 * Manager's admission webhook validates it): undefined = not run yet, '' = accepted.
 * `currentVersion` is the release the cluster was created from, used while no Release exists.
 * `readiness` is the state of upgradeReadiness(): 'waiting' blocks the upgrade, 'unknown' does not.
 */
export function preflight(nodes: NodeFacts[] | null, release: any, target: ReleaseRef | null, dryRunError?: string, currentVersion?: string, readiness?: ReadinessState): PreflightCheck[] {
  const notReady = (nodes || []).filter((n) => !n.ready).map((n) => n.name);
  const cordoned = (nodes || []).filter((n) => n.cordoned).map((n) => n.name);
  const state = upgradeState(release);
  // What the Lifecycle Manager applied; for a cluster it has not touched yet, what the cluster was created from
  const current = appliedVersion(release) || release?.spec?.version || currentVersion || '';
  const cmp = target && current ? compareVersions(target.version, current) : NaN;

  // Rancher's changes after the import are finished (upgradeReadiness). Left out when the caller does not say.
  const settled: PreflightCheck[] = readiness === undefined ? [] : [{
    key: 'settled', passed: readiness === 'ready' ? true : (readiness === 'waiting' ? false : null), params: {}
  }];

  return [
    ...settled,
    {
      key: 'nodesReady', passed: nodes ? notReady.length === 0 && nodes.length > 0 : null, params: { nodes: notReady.join(', '), count: (nodes || []).length }
    },
    {
      key: 'noneCordoned', passed: nodes ? cordoned.length === 0 : null, params: { nodes: cordoned.join(', ') }
    },
    {
      key: 'noUpgradeRunning', passed: !['inProgress', 'pending'].includes(state), params: { version: release?.spec?.version || '' }
    },
    {
      key: 'newer', passed: !target ? null : (!current ? true : (Number.isNaN(cmp) ? null : cmp > 0)), params: { target: target?.version || '', current }
    },
    {
      key: 'accepted', passed: dryRunError === undefined ? null : dryRunError === '', params: { error: dryRunError || '' }
    },
  ];
}

/** The upgrade may be started when nothing failed and the dry run was accepted. Unknown checks do not block. */
export function preflightPassed(checks: PreflightCheck[]): boolean {
  return checks.every((c) => c.passed !== false) && checks.find((c) => c.key === 'accepted')?.passed === true;
}

export interface RunningVersion {
  version: string;
  /** How many nodes run it */
  nodes: number;
}

/** Distinct Kubernetes versions out of one kubelet version per node, newest first. Empty entries are ignored. */
export function runningKubernetes(kubelets: string[]): RunningVersion[] {
  const count: Record<string, number> = {};

  (kubelets || []).filter((k) => !!k).forEach((k) => {
    count[k] = (count[k] || 0) + 1;
  });

  return Object.keys(count).map((version) => ({ version, nodes: count[version] })).sort((a, b) => {
    const cmp = compareVersions(b.version.split('+')[0], a.version.split('+')[0]);

    return Number.isNaN(cmp) || cmp === 0 ? b.version.localeCompare(a.version) : cmp;
  });
}

export interface MachineVersion {
  /** Pool the machine belongs to */
  pool: string;
  /** Name of the machine's node; '' while it has none */
  node: string;
  /** Kubernetes version Cluster API reports for the machine's node; '' when not reported */
  kubelet: string;
}

/**
 * Kubernetes versions that really run, per pool and for the whole cluster. An in-place upgrade by the
 * Lifecycle Manager changes the nodes and not the Cluster API objects, so `spec.version` of the control
 * plane and of the machine deployments keeps naming the version the cluster was created with.
 * The node's own word (`nodeKubelet`, read from the workload cluster) wins over the copy Cluster API
 * keeps in the Machine status, which is refreshed less often.
 */
export function runningByPool(machines: MachineVersion[], nodeKubelet: Record<string, string> | null): { all: RunningVersion[]; pools: Record<string, RunningVersion[]> } {
  const byPool: Record<string, string[]> = {};
  const all: string[] = [];

  (machines || []).forEach((m) => {
    const v = (m.node && nodeKubelet?.[m.node]) || m.kubelet || '';

    if (v) {
      (byPool[m.pool] = byPool[m.pool] || []).push(v);
      all.push(v);
    }
  });
  const pools: Record<string, RunningVersion[]> = {};

  Object.keys(byPool).forEach((p) => {
    pools[p] = runningKubernetes(byPool[p]);
  });

  // Without machines (not listable for the user) the nodes alone still say what the cluster runs
  return { all: runningKubernetes(all.length ? all : Object.values(nodeKubelet || {})), pools };
}

// ---- Ready for an upgrade: Rancher's changes to a freshly imported cluster are finished ----

/** Rancher setting that names the chart version of the system upgrade controller Rancher installs in every imported cluster. */
export const SUC_CHART_SETTING = 'system-upgrade-controller-chart-version';
/** Where Rancher and the Elemental release install the system upgrade controller, and where its Plans live. */
export const SUC_NAMESPACE = 'cattle-system';
export const SUC_NAME = 'system-upgrade-controller';
/** Label Rancher's catalog puts on a Helm release it installed from one of its chart repositories (seen: rancher-charts). */
export const RANCHER_REPO_LABEL = 'catalog.cattle.io/cluster-repo-name';

export type ReadinessState = 'ready' | 'waiting' | 'unknown';

/**
 * What the page read. For each: `undefined` = could not be read (refused, or the request failed),
 * `null` = read, and it does not exist.
 */
export interface ReadinessFacts {
  /** Value of the Rancher setting SUC_CHART_SETTING on the management cluster */
  wantedChart: string | null | undefined;
  /** Helm release of the controller in the workload cluster, as Rancher's catalog shows it: apps.catalog.cattle.io cattle-system/system-upgrade-controller */
  app: any | null | undefined;
  /** Deployment cattle-system/system-upgrade-controller in the workload cluster */
  deployment: any | null | undefined;
  /** plans.upgrade.cattle.io in cattle-system of the workload cluster */
  plans: any[] | undefined;
}

export interface ReadinessCheck {
  key: 'chart' | 'controller' | 'plans';
  /** null: could not be checked */
  passed: boolean | null;
  /** Variant of the text to show */
  code: string;
  params: Record<string, any>;
}

export interface Readiness {
  state: ReadinessState;
  checks: ReadinessCheck[];
}

/**
 * Is the cluster ready for an upgrade by the Lifecycle Manager?
 *
 * Rancher changes a cluster for some minutes after it has imported it and already shows it as ready:
 * it replaces the system upgrade controller the Elemental release installed with the chart version of its
 * own setting, and it installs its node agent with a Plan of that controller. The Lifecycle Manager runs
 * every step of an upgrade as Plans of the same controller and, on a cluster with Rancher's agent, leaves
 * the controller to Rancher. An upgrade started before Rancher is done runs on the old controller (whose
 * kubectl image may not fit the cluster's Kubernetes: cordon and drain fail) and has the controller
 * replaced under it. Ready therefore means, all read from what the cluster's owner can read:
 *
 *  1. chart:      the Helm release of the controller has the chart version of Rancher's setting, was installed
 *                 by Rancher from one of its chart repositories (RANCHER_REPO_LABEL) and is deployed. A release
 *                 with the right version that Rancher did not install (a cluster created from an Elemental
 *                 release that ships the same chart version) is unknown: whether Rancher still replaces
 *                 it cannot be read;
 *  2. controller: its Deployment is rolled out (the generation is observed, every replica updated and available);
 *  3. plans:      no Plan in the controller's namespace is being applied to a node, and every Plan that
 *                 has been evaluated is complete (Rancher's node agent Plan is the one that matters).
 *
 * One of them false: waiting. All true: ready. Otherwise (something could not be read): unknown, which
 * warns and does not block.
 */
export function upgradeReadiness(f: ReadinessFacts): Readiness {
  const checks: ReadinessCheck[] = [];
  const have = f.app?.spec?.chart?.metadata?.version || '';
  const state = f.app?.status?.summary?.state || f.app?.spec?.info?.status || '';
  const want = f.wantedChart || '';

  if (f.app === undefined || f.wantedChart === undefined || (f.app && !have)) {
    checks.push({
      key: 'chart', passed: null, code: f.wantedChart === undefined ? 'noSetting' : 'unread', params: { have, want }
    });
  } else if (!want) {
    // Rancher installs no controller of its own (setting empty): nothing will be replaced
    checks.push({
      key: 'chart', passed: true, code: 'notManaged', params: { have, want }
    });
  } else if (f.app === null) {
    checks.push({
      key: 'chart', passed: false, code: 'missing', params: { have, want }
    });
  } else {
    const repo = f.app.metadata?.labels?.[RANCHER_REPO_LABEL] || '';
    const params = {
      have, want, state, repo
    };
    let passed: boolean | null = false;
    let code = 'other';

    if (have === want) {
      passed = state === 'deployed' ? (repo ? true : null) : false;
      code = state === 'deployed' ? (repo ? 'ok' : 'notByRancher') : 'notDeployed';
    }
    checks.push({
      key: 'chart', passed, code, params
    });
  }

  if (f.deployment === undefined) {
    checks.push({
      key: 'controller', passed: null, code: 'unread', params: {}
    });
  } else if (f.deployment === null) {
    checks.push({
      key: 'controller', passed: false, code: 'missing', params: {}
    });
  } else {
    const d = f.deployment;
    const replicas = d.spec?.replicas ?? 1;
    const st = d.status || {};
    const ok = replicas > 0 && (st.observedGeneration || 0) >= (d.metadata?.generation || 0) && (st.updatedReplicas || 0) === replicas && (st.availableReplicas || 0) === replicas && (st.replicas || 0) === replicas;

    checks.push({
      key:    'controller',
      passed: ok,
      code:   ok ? 'ok' : 'rollingOut',
      params: {
        image: d.spec?.template?.spec?.containers?.[0]?.image || '', ready: st.availableReplicas || 0, replicas
      },
    });
  }

  if (f.plans === undefined) {
    checks.push({
      key: 'plans', passed: null, code: 'unread', params: {}
    });
  } else {
    const busy = f.plans.filter((p) => (p.status?.applying || []).length > 0 || (p.status?.conditions || []).some((c: any) => c.type === 'Complete' && c.status !== 'True'));
    const names = busy.map((p) => {
      const on = (p.status?.applying || []).join(', ');

      return on ? `${ p.metadata?.name } (${ on })` : `${ p.metadata?.name }`;
    }).join('; ');

    checks.push({
      key: 'plans', passed: busy.length === 0, code: busy.length === 0 ? 'ok' : 'applying', params: { plans: names, count: f.plans.length }
    });
  }

  const all = checks.map((c) => c.passed);

  return { state: all.includes(false) ? 'waiting' : (all.every((x) => x === true) ? 'ready' : 'unknown'), checks };
}
