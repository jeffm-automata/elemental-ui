/**
 * Turns the status of the Cluster API objects of one cluster into what the detail page shows:
 * progress phases, the "waiting for" sentence, errors, machine pools and a flat condition list.
 *
 * Display only. Nothing here decides or changes anything; every value is read from object status.
 * No imports: plain data in, plain data out.
 */

export type PhaseState = 'done' | 'active' | 'waiting' | 'error' | 'unknown' | 'skipped';

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface ClusterObjects {
  /** cluster.x-k8s.io Cluster */
  cluster: any;
  /** HarvesterCluster, or null when it is not there or not readable */
  infra?: any;
  /** RKE2ControlPlane */
  controlPlane?: any;
  /** MachineDeployments of the cluster */
  machineDeployments?: any[];
  /** Machines; null when the user may not list them */
  machines?: any[] | null;
  /** Rancher's cluster object for the imported cluster; null when it does not exist or is not visible */
  rancherCluster?: any;
}

export interface Phase {
  key: 'written' | 'infrastructure' | 'controlPlane' | 'workers' | 'rancher';
  state: PhaseState;
  /** Translation key under elemental3.progress.detail, with params */
  code: string;
  params: Record<string, any>;
  /** Text taken verbatim from a condition of the object, when there is one */
  message: string;
}

export interface Problem {
  kind: string;
  name: string;
  type: string;
  reason: string;
  message: string;
  /**
   * True while the part of the cluster the object belongs to is not ready. A failed condition that an
   * object keeps although its part is ready (the Harvester provider keeps "connection failed" on a
   * cluster whose infrastructure was marked ready) is still shown, as a warning.
   */
  blocking: boolean;
  /**
   * Whole minutes the condition has been in this state, when it is shown as an error only because it
   * has not changed for too long (a boot that never finished). 0 for a refusal or a reported failure.
   */
  stalledMinutes: number;
}

export interface ConditionRow extends Condition {
  kind: string;
  name: string;
}

export interface PoolRow {
  key: string;
  role: 'controlPlane' | 'worker';
  kind: 'RKE2ControlPlane' | 'MachineDeployment';
  name: string;
  desired: number;
  ready: number;
  /** Machines that exist, whatever their state */
  current: number;
  version: string;
  templateName: string;
  /** Lowest allowed machine count */
  min: number;
}

export interface MachineRow {
  name: string;
  pool: string;
  role: 'controlPlane' | 'worker';
  phase: string;
  node: string;
  version: string;
  created: string;
  message: string;
}

export function conditions(obj: any): Condition[] {
  const st = obj?.status || {};
  // Cluster API v1beta2 objects keep the current conditions in status.conditions; objects that still
  // serve the older contract may carry the new ones under status.v1beta2.conditions
  const list = st.conditions || st.v1beta2?.conditions || [];

  return Array.isArray(list) ? list : [];
}

export function condition(obj: any, type: string): Condition | undefined {
  return conditions(obj).find((c) => c.type === type);
}

export function isTrue(obj: any, type: string): boolean {
  return condition(obj, type)?.status === 'True';
}

const FAILURE_RE = /fail|error|invalid|forbidden|denied|unauthori[sz]ed|timed? ?out|deadline|notfound|not found|giving up/i;

/** Conditions whose type says something is wrong when True (Cluster API: Remediating, Paused, ...) are not failures here. */
const NEGATIVE_POLARITY = ['RollingOut', 'Remediating', 'ScalingDown', 'ScalingUp', 'Paused', 'Deleting'];

/**
 * Providers use reasons like ProbeFailed or InspectionFailed for things that simply have not happened
 * yet ("Remote connection not established yet", "Waiting for Cluster status.infrastructureReady to be
 * true", "container runtime network not ready: ... cni plugin not initialized" while a node boots).
 * Their message says so; such a condition is "not yet", not a failure.
 */
const NOT_YET_RE = /^waiting\b|waiting for|not (yet )?established|not yet|in progress|not ready|not initialized|still (creating|provisioning|booting|starting)|being (created|provisioned)|does not exist yet/i;

/**
 * Refusals: nothing gets better by waiting, so these are errors from the first second
 * (a missing right, a rejected object, a controller that says it gave up).
 */
const TERMINAL_RE = /forbidden|denied|unauthori[sz]ed|invalid|unprocessable|quota|giving up|will not (be )?retr/i;

/**
 * On a part of the cluster that is up, a condition that reports a failure (a failed probe, a failed
 * step) is shown as in progress for this long, then as an error: controllers retry.
 */
export const FAILURE_GRACE_SECONDS = 5 * 60;
/**
 * While a part of the cluster is still being brought up, its objects report "failed" probes and
 * not-ready nodes for as long as a machine takes to boot and join (API not reachable, no CNI yet; the
 * Cluster's connection probe fails from the first second until the control plane answers). Those, and
 * every condition that only says "not yet", become an error when they have not changed for this long.
 */
export const NOT_YET_TIMEOUT_SECONDS = 30 * 60;

export type Severity = 'ok' | 'progress' | 'error';

function ageSeconds(c: Condition, now: number): number | null {
  const t = Date.parse(c?.lastTransitionTime || '');

  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : null;
}

/**
 * What a condition means for the user right now.
 * `error`: a refusal (at once), a failure that has lasted longer than `grace` (FAILURE_GRACE_SECONDS;
 * the callers pass NOT_YET_TIMEOUT_SECONDS for a part of the cluster that is still coming up), or a
 * "not yet" that has lasted longer than NOT_YET_TIMEOUT_SECONDS. A failure without a transition time
 * is an error: its age is unknown.
 * `progress`: not true yet, and nothing says it will not become true.
 */
export function severity(c: Condition, now: number = Date.now(), grace: number = FAILURE_GRACE_SECONDS): Severity {
  if (!c || NEGATIVE_POLARITY.includes(c.type) || c.status === 'True') {
    return 'ok';
  }
  const reason = c.reason || '';
  const message = c.message || '';
  const age = ageSeconds(c, now);

  if (TERMINAL_RE.test(reason) || TERMINAL_RE.test(message)) {
    return 'error';
  }
  if (NOT_YET_RE.test(message)) {
    return age !== null && age > NOT_YET_TIMEOUT_SECONDS ? 'error' : 'progress';
  }
  if (FAILURE_RE.test(reason) || FAILURE_RE.test(message)) {
    return age === null || age > grace ? 'error' : 'progress';
  }

  return 'progress';
}

/** Minutes without change of a condition that is an error only through its age; 0 otherwise. */
export function stalledMinutes(c: Condition, now: number = Date.now()): number {
  const age = ageSeconds(c, now);

  if (age === null || severity(c, now) !== 'error' || TERMINAL_RE.test(c.reason || '') || TERMINAL_RE.test(c.message || '')) {
    return 0;
  }

  return NOT_YET_RE.test(c.message || '') ? Math.floor(age / 60) : 0;
}

/** True when a condition reports a failure, as opposed to "not yet" or a failure too young to count. */
export function isFailure(c: Condition, now: number = Date.now(), grace: number = FAILURE_GRACE_SECONDS): boolean {
  return severity(c, now, grace) === 'error';
}

function num(n: any): number {
  return Number.isFinite(Number(n)) ? Number(n) : 0;
}

function firstPending(obj: any, prefer: string[] = []): Condition | undefined {
  const list = conditions(obj).filter((c) => !NEGATIVE_POLARITY.includes(c.type) && c.status !== 'True');
  const preferred = prefer.map((t) => list.find((c) => c.type === t)).find((c) => !!c);

  return preferred || list.find((c) => !!c.message) || list[0];
}

function text(c?: Condition): string {
  if (!c) {
    return '';
  }

  return c.message || c.reason || '';
}

export function workerTotals(o: ClusterObjects): { desired: number; ready: number } {
  return (o.machineDeployments || []).reduce((acc, md) => ({
    desired: acc.desired + num(md.spec?.replicas),
    ready:   acc.ready + num(md.status?.readyReplicas),
  }), { desired: 0, ready: 0 });
}

/**
 * The phases a new cluster goes through, in order. The first phase that is not done is `active`
 * (or `error` when one of its objects reports a failure); the ones after it are `waiting`.
 */
export function progressPhases(o: ClusterObjects, now: number = Date.now()): Phase[] {
  // A phase asks about failures only while it is not done, that is while its machines are coming up
  const failing = (c: Condition) => isFailure(c, now, NOT_YET_TIMEOUT_SECONDS);
  const out: Phase[] = [];
  const cluster = o.cluster;
  const cp = o.controlPlane;
  const infra = o.infra;

  out.push({
    key: 'written', state: cluster ? 'done' : 'active', code: cluster ? 'written' : 'notFound', params: { created: cluster?.metadata?.creationTimestamp || '' }, message: ''
  });

  // 1. Infrastructure (the Harvester provider's part)
  const infraDone = isTrue(cluster, 'InfrastructureReady') || cluster?.status?.initialization?.infrastructureProvisioned === true;
  const infraPending = firstPending(infra, ['HarvesterConnectionReady', 'LoadBalancerReady', 'InfrastructureReady']) || condition(cluster, 'InfrastructureReady');
  const infraFailed = conditions(infra).some(failing);
  const endpoint = infra?.spec?.controlPlaneEndpoint?.host || cluster?.spec?.controlPlaneEndpoint?.host || '';

  out.push({
    key:     'infrastructure',
    state:   infraDone ? 'done' : (infraFailed ? 'error' : 'active'),
    code:    infraDone ? 'infrastructureDone' : 'infrastructureWaiting',
    params:  { endpoint },
    message: infraDone ? '' : text(conditions(infra).find(failing) || infraPending),
  });

  // 2. Control plane machines
  const cpDesired = num(cp?.spec?.replicas);
  const cpReady = num(cp?.status?.readyReplicas);
  const cpInitialized = isTrue(cluster, 'ControlPlaneInitialized') || cluster?.status?.initialization?.controlPlaneInitialized === true || cp?.status?.initialization?.controlPlaneInitialized === true;
  const cpDone = cpInitialized && cpDesired > 0 && cpReady >= cpDesired;
  const cpFailed = conditions(cp).some(failing) || !!cp?.status?.failureMessage;

  out.push({
    key:     'controlPlane',
    state:   cpDone ? 'done' : (cpFailed ? 'error' : 'active'),
    code:    cpDone ? 'controlPlaneDone' : (cpInitialized ? 'controlPlaneScaling' : 'controlPlaneWaiting'),
    params:  { ready: cpReady, desired: cpDesired },
    message: cpDone ? '' : (cp?.status?.failureMessage || text(conditions(cp).find(failing) || firstPending(cp, ['MachinesReady', 'Available', 'Ready']) || condition(cluster, 'ControlPlaneAvailable'))),
  });

  // 3. Worker machines
  const w = workerTotals(o);
  const mds = o.machineDeployments || [];
  const wFailed = mds.some((md) => conditions(md).some(failing));
  const wDone = w.ready >= w.desired;

  out.push({
    key:     'workers',
    state:   w.desired === 0 ? 'skipped' : (wDone ? 'done' : (wFailed ? 'error' : 'active')),
    code:    w.desired === 0 ? 'workersNone' : (wDone ? 'workersDone' : 'workersWaiting'),
    params:  { ready: w.ready, desired: w.desired },
    message: (w.desired === 0 || wDone) ? '' : text(mds.map((md) => conditions(md).find(failing) || firstPending(md, ['MachinesReady', 'Available'])).find((c) => !!c) || condition(cluster, 'WorkersAvailable')),
  });

  // 4. Import into Rancher (Rancher Turtles). The object is Rancher's; a user who is not a member cannot see it.
  const rc = o.rancherCluster;
  const rcReady = isTrue(rc, 'Ready');

  out.push({
    key:     'rancher',
    state:   rc ? (rcReady ? 'done' : 'active') : 'unknown',
    code:    rc ? (rcReady ? 'rancherDone' : 'rancherWaiting') : 'rancherNotVisible',
    params:  { id: rc?.id || rc?.metadata?.name || '' },
    message: rc && !rcReady ? text(firstPending(rc, ['Ready', 'Connected'])) : '',
  });

  // Order: only the first unfinished phase is active
  let blocked = false;

  out.forEach((p) => {
    if (p.key === 'rancher' && p.state === 'unknown') {
      return;
    }
    if (blocked && (p.state === 'active')) {
      p.state = 'waiting';
      p.message = '';
    }
    if (p.state === 'active' || p.state === 'error') {
      blocked = true;
    }
  });

  return out;
}

/** The phase the user is waiting for right now, or undefined when everything readable is done. */
export function currentPhase(phases: Phase[]): Phase | undefined {
  return phases.find((p) => p.state === 'error') || phases.find((p) => p.state === 'active');
}

/** True when all phases that can be read are done (the Rancher import may be invisible to the user). */
export function isProvisioned(phases: Phase[]): boolean {
  return phases.every((p) => ['done', 'skipped', 'unknown'].includes(p.state));
}

function rowsFor(kind: string, obj: any): ConditionRow[] {
  if (!obj) {
    return [];
  }

  return conditions(obj).map((c) => ({
    kind, name: obj.metadata?.name || '', ...c
  }));
}

/** Every condition of every object of the cluster, for the Conditions tab. */
export function conditionRows(o: ClusterObjects): ConditionRow[] {
  return [
    ...rowsFor('Cluster', o.cluster),
    ...rowsFor('HarvesterCluster', o.infra),
    ...rowsFor('RKE2ControlPlane', o.controlPlane),
    ...(o.machineDeployments || []).flatMap((md) => rowsFor('MachineDeployment', md)),
    ...(o.machines || []).flatMap((m) => rowsFor('Machine', m)),
  ];
}

const PHASE_OF_KIND: Record<string, Phase['key']> = {
  HarvesterCluster: 'infrastructure', RKE2ControlPlane: 'controlPlane', MachineDeployment: 'workers'
};

/** Conditions that report a failure, plus failure messages of machines. Shown as banners. */
export function problems(o: ClusterObjects, now: number = Date.now()): Problem[] {
  const phases = progressPhases(o, now);
  const unfinished = (key: Phase['key']) => !['done', 'skipped'].includes(phases.find((p) => p.key === key)?.state || '');
  const provisioned = isProvisioned(phases);
  const machinePhase = (name: string) => (o.machines || []).find((m) => m.metadata?.name === name)?.status?.phase;
  const blocking = (kind: string, name: string) => {
    if (kind === 'Machine') {
      return machinePhase(name) !== 'Running';
    }

    return PHASE_OF_KIND[kind] ? unfinished(PHASE_OF_KIND[kind]) : !provisioned;
  };
  // An object of a part that is still coming up gets the boot timeout; one of a part that is up, the short grace
  const graceFor = (c: ConditionRow) => (blocking(c.kind, c.name) ? NOT_YET_TIMEOUT_SECONDS : FAILURE_GRACE_SECONDS);
  const out: Problem[] = conditionRows(o).filter((c) => isFailure(c, now, graceFor(c))).map((c) => ({
    kind: c.kind, name: c.name, type: c.type, reason: c.reason || '', message: c.message || '', blocking: blocking(c.kind, c.name), stalledMinutes: stalledMinutes(c, now)
  }));
  const failed = (kind: string, obj: any) => {
    const msg = obj?.status?.failureMessage;

    if (msg) {
      out.push({
        kind, name: obj.metadata?.name || '', type: 'Failure', reason: obj.status?.failureReason || '', message: msg, blocking: true, stalledMinutes: 0
      });
    }
  };

  failed('RKE2ControlPlane', o.controlPlane);
  (o.machines || []).forEach((m) => failed('Machine', m));

  // The same text reported by several objects is shown once per object, but never twice for one
  return out.filter((p, i, all) => all.findIndex((x) => x.kind === p.kind && x.name === p.name && x.type === p.type) === i);
}

export function poolRows(o: ClusterObjects): PoolRow[] {
  const out: PoolRow[] = [];
  const cp = o.controlPlane;

  if (cp) {
    out.push({
      key:          `cp/${ cp.metadata?.name }`,
      role:         'controlPlane',
      kind:         'RKE2ControlPlane',
      name:         cp.metadata?.name || '',
      desired:      num(cp.spec?.replicas),
      ready:        num(cp.status?.readyReplicas),
      current:      num(cp.status?.replicas),
      version:      cp.spec?.version || '',
      templateName: cp.spec?.machineTemplate?.spec?.infrastructureRef?.name || cp.spec?.machineTemplate?.infrastructureRef?.name || '',
      min:          1,
    });
  }
  (o.machineDeployments || []).forEach((md) => {
    out.push({
      key:          `md/${ md.metadata?.name }`,
      role:         'worker',
      kind:         'MachineDeployment',
      name:         md.metadata?.name || '',
      desired:      num(md.spec?.replicas),
      ready:        num(md.status?.readyReplicas),
      current:      num(md.status?.replicas),
      version:      md.spec?.template?.spec?.version || '',
      templateName: md.spec?.template?.spec?.infrastructureRef?.name || '',
      min:          0,
    });
  });

  return out;
}

const CONTROL_PLANE_LABEL = 'cluster.x-k8s.io/control-plane';
const DEPLOYMENT_LABEL = 'cluster.x-k8s.io/deployment-name';

export function machineRows(machines: any[] | null | undefined, now: number = Date.now()): MachineRow[] {
  return (machines || []).map((m) => {
    const labels = m.metadata?.labels || {};
    const isCp = CONTROL_PLANE_LABEL in labels;
    const pending = conditions(m).find((c) => isFailure(c, now)) || firstPending(m, ['Ready', 'InfrastructureReady', 'BootstrapConfigReady', 'NodeHealthy']);

    return {
      name:    m.metadata?.name || '',
      pool:    isCp ? (labels['cluster.x-k8s.io/control-plane-name'] || '') : (labels[DEPLOYMENT_LABEL] || ''),
      role:    (isCp ? 'controlPlane' : 'worker') as 'controlPlane' | 'worker',
      phase:   m.status?.phase || '',
      node:    m.status?.nodeRef?.name || '',
      version: m.spec?.version || '',
      created: m.metadata?.creationTimestamp || '',
      message: m.status?.failureMessage || (m.status?.phase === 'Running' ? '' : text(pending)),
    };
  }).sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : (a.role === 'controlPlane' ? -1 : 1)));
}

/** One-word state of a cluster for the list page, from the phases. */
export function clusterState(o: ClusterObjects, now: number = Date.now()): 'deleting' | 'error' | 'provisioning' | 'ready' {
  if (o.cluster?.metadata?.deletionTimestamp) {
    return 'deleting';
  }
  const phases = progressPhases(o, now);

  if (phases.some((p) => p.state === 'error')) {
    return 'error';
  }

  return isProvisioned(phases) ? 'ready' : 'provisioning';
}

/** Events that belong to the cluster: the involved object is one of its objects (names start with the cluster name). */
export function clusterEvents(events: any[], clusterName: string): any[] {
  return (events || [])
    .filter((e) => {
      const n = e.involvedObject?.name || e.regarding?.name || '';

      return n === clusterName || n.startsWith(`${ clusterName }-`);
    })
    .map((e) => ({
      time:    e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp || '',
      type:    e.type || '',
      reason:  e.reason || '',
      object:  `${ e.involvedObject?.kind || e.regarding?.kind || '' }/${ e.involvedObject?.name || e.regarding?.name || '' }`,
      message: e.message || e.note || '',
      count:   e.count || 1,
    }))
    .sort((a, b) => `${ b.time }`.localeCompare(`${ a.time }`));
}
