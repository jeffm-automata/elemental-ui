<script>
import Loading from '@shell/components/Loading';
import Tabbed from '@shell/components/Tabbed';
import Tab from '@shell/components/Tabbed/Tab';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { Banner } from '@components/Banner';
import { MANAGEMENT } from '@shell/config/types';
import {
  API, READ_API, ACCESS_REVIEW_PATH, CLUSTER_NAME_LABEL, HARVESTER_CLUSTER_ANNOTATION, RELEASE_ANNOTATION,
  accessReview, collectionPath, objectPath, rightText
} from '../lib/objects';
import {
  clusterEvents, clusterState, conditionRows, currentPhase, isProvisioned, machineRows, poolRows, problems, progressPhases
} from '../lib/status';
import {
  RELEASE_API, appliedVersion, buildRelease, manifestRef, nodeFacts, offeredReleases, parseManifestRef, preflight, preflightPassed,
  upgradePhases, upgradeState
} from '../lib/release';
import { IMAGE_RELEASE_ANNOTATION, NODE_IMAGE_TYPE, errorText, harvesterBase } from '../lib/harvester';
import { LIST_ROUTE, BLANK_CLUSTER } from '../product';

const MGMT_API = '/k8s/clusters/local';
const OWNER_LABEL = 'cluster-api.cattle.io/capi-cluster-owner';
const OWNER_NS_LABEL = 'cluster-api.cattle.io/capi-cluster-owner-ns';
const REFRESH_MS = 10000;

function httpStatus(e) {
  return e?._status || e?.status || e?.response?.status || 0;
}

/**
 * One Elemental 3 cluster: what is happening to it (progress after Create), its machine pools,
 * conditions, events, and its Elemental release with the upgrade.
 *
 * The page reads object status with the rights of the logged-in user and refreshes every ten seconds.
 * It writes exactly three things, each on a click: the replica count of a pool, the cluster's one
 * Release object, and the deletion of the Cluster. Everything else is done by the controllers.
 */
export default {
  name: 'Elemental3ClusterDetail',

  components: {
    Loading, Tabbed, Tab, LabeledSelect, Banner
  },

  async fetch() {
    try {
      this.mgmtClusters = await this.$store.dispatch('management/findAll', { type: MANAGEMENT.CLUSTER });
    } catch (e) {
      this.mgmtClusters = [];
    }
    await this.load();
    await this.loadRights();
    await this.loadKnownReleases();
  },

  data() {
    return {
      mgmtClusters:       [],
      cluster:            null,
      notFound:           false,
      loadError:          '',
      infra:              null,
      controlPlane:       null,
      machineDeployments: [],
      templates:          {},
      machines:           null,
      events:             null,
      // Rights the user lacks, as { key: text } where text is the right as it has to be granted
      denied:             {},
      can:                {
        scaleWorkers: false, scaleControlPlane: false, deleteCluster: false
      },
      // Workload cluster, through Rancher's cluster proxy
      nodes:            null,
      release:          null,
      releaseError:     '',
      releaseDenied:    '',
      knownReleases:    [],
      targetKey:        '',
      dryRunError:      undefined,
      dryRunFor:        '',
      busy:             '',
      actionError:      '',
      confirmDelete:    false,
      // Pool key of the scale-down waiting for confirmation
      confirmScaleDown: '',
      timer:            null,
      lastRefresh:      '',
    };
  },

  mounted() {
    let n = 0;

    // Rights can arrive after the page was opened (the owner's rights follow the import): while one is
    // missing they are asked again once a minute
    this.timer = setInterval(() => {
      this.load();
      if (++n % 6 === 0 && this.rightsIncomplete) {
        this.loadRights();
      }
    }, REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  computed: {
    namespace() {
      return this.$route.params.namespace;
    },

    name() {
      return this.$route.params.id;
    },

    listRoute() {
      return { name: LIST_ROUTE, params: { cluster: BLANK_CLUSTER } };
    },

    /** Rancher's object for the imported cluster. Rancher Turtles creates it; only its members see it. */
    rancherCluster() {
      return (this.mgmtClusters || []).find((c) => {
        const l = c.metadata?.labels || {};

        return l[OWNER_LABEL] === this.name && l[OWNER_NS_LABEL] === this.namespace;
      }) || null;
    },

    rancherReady() {
      return !!this.rancherCluster && (this.rancherCluster.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True');
    },

    explorerRoute() {
      return this.rancherCluster ? { name: 'c-cluster-explorer', params: { cluster: this.rancherCluster.id } } : null;
    },

    objects() {
      return {
        cluster:            this.cluster,
        infra:              this.infra,
        controlPlane:       this.controlPlane,
        machineDeployments: this.machineDeployments,
        machines:           this.machines,
        rancherCluster:     this.rancherCluster,
      };
    },

    phases() {
      return progressPhases(this.objects);
    },

    waitingFor() {
      return currentPhase(this.phases);
    },

    provisioned() {
      return isProvisioned(this.phases);
    },

    state() {
      return clusterState(this.objects);
    },

    problemList() {
      return problems(this.objects);
    },

    pools() {
      return poolRows(this.objects).map((p) => {
        const t = this.templates[p.templateName]?.spec?.template?.spec || {};

        return {
          ...p,
          cpu:      t.cpu || '',
          memory:   t.memory || '',
          disk:     t.volumes?.[0]?.volumeSize || '',
          canScale: p.role === 'worker' ? this.can.scaleWorkers : this.can.scaleControlPlane,
        };
      });
    },

    machineList() {
      return machineRows(this.machines);
    },

    conditionList() {
      return conditionRows(this.objects);
    },

    eventList() {
      return clusterEvents(this.events || [], this.name);
    },

    deniedList() {
      return Object.values(this.denied);
    },

    endpoint() {
      const e = this.infra?.spec?.controlPlaneEndpoint || this.cluster?.spec?.controlPlaneEndpoint;

      return e?.host ? `${ e.host }:${ e.port || 6443 }` : '';
    },

    // ---- Elemental release ----

    /** Release the cluster was created from, recorded by the create form */
    createdFrom() {
      return parseManifestRef(this.cluster?.metadata?.annotations?.[RELEASE_ANNOTATION] || '');
    },

    /** What the cluster runs: the Lifecycle Manager's word when a Release was applied, else what it was created from */
    currentRelease() {
      const applied = appliedVersion(this.release);

      if (applied && this.release?.spec?.registry) {
        return { registry: this.release.spec.registry, version: applied };
      }

      return this.createdFrom;
    },

    upgrade() {
      return upgradeState(this.release);
    },

    upgradePhaseList() {
      return upgradePhases(this.release);
    },

    nodeList() {
      return this.nodes ? nodeFacts(this.nodes) : null;
    },

    offered() {
      return offeredReleases(this.knownReleases, this.currentRelease);
    },

    releaseOptions() {
      return this.offered.filter((o) => !o.blocked).map((o) => ({
        value: manifestRef(o),
        label: this.t('elemental3.release.option', { version: o.version, source: this.t(`elemental3.release.source.${ o.source }`) }),
      }));
    },

    /** Known releases that are not valid targets, with the reason. The current release itself is not listed. */
    notOffered() {
      const current = this.currentRelease?.version;
      const lines = this.offered
        .filter((o) => !!o.blocked && o.version !== current)
        .map((o) => this.t('elemental3.release.notOffered', { version: o.version, why: this.t(`elemental3.release.blocked.${ o.blocked }`) }));

      return [...new Set(lines)];
    },

    /** The selected or typed target. A bare version takes the registry the cluster's release comes from. */
    target() {
      const key = `${ this.targetKey || '' }`.trim();

      if (!key) {
        return null;
      }
      const full = parseManifestRef(key);

      if (full && key.includes('/')) {
        return full;
      }
      const registry = this.release?.spec?.registry || this.currentRelease?.registry || '';

      return registry ? { registry, version: key } : null;
    },

    targetInvalid() {
      return !!`${ this.targetKey || '' }`.trim() && !this.target;
    },

    preflightChecks() {
      return preflight(this.nodeList, this.release, this.target, this.dryRunFor === this.targetKey ? this.dryRunError : undefined, this.currentRelease?.version);
    },

    canUpgrade() {
      return !!this.target && !this.busy && preflightPassed(this.preflightChecks);
    },

    /** True while a control is disabled for lack of a right: only then are the rights asked again */
    rightsIncomplete() {
      return !this.can.scaleWorkers || !this.can.scaleControlPlane || !this.can.deleteCluster;
    },

    upgradeRunning() {
      return ['pending', 'inProgress'].includes(this.upgrade);
    },
  },

  watch: {
    targetKey() {
      this.dryRunError = undefined;
      this.dryRunFor = '';
      if (this.target) {
        this.dryRunRelease();
      }
    },

    rancherReady(neu, old) {
      if (neu && !old) {
        this.loadWorkload();
      }
    },
  },

  methods: {
    request(method, url, data, contentType) {
      const opt = {
        url, method, headers: { 'content-type': contentType || 'application/json' }
      };

      if (data) {
        opt.data = data;
      }

      return this.$store.dispatch('management/request', opt);
    },

    mgmt(method, path, data, contentType) {
      return this.request(method, `${ MGMT_API }${ path }`, data, contentType);
    },

    workload(method, path, data, contentType) {
      return this.request(method, `/k8s/clusters/${ this.rancherCluster.id }${ path }`, data, contentType);
    },

    deny(key, api, verb, namespaced = true) {
      this.denied = { ...this.denied, [key]: rightText(api, verb, namespaced ? this.namespace : undefined) };
    },

    allow(key) {
      if (this.denied[key]) {
        const d = { ...this.denied };

        delete d[key];
        this.denied = d;
      }
    },

    /** Reads everything again. Each read that is refused is remembered and named on the page. */
    async load() {
      const ns = this.namespace;
      const selector = `?labelSelector=${ encodeURIComponent(`${ CLUSTER_NAME_LABEL }=${ this.name }`) }`;

      try {
        this.cluster = await this.mgmt('get', objectPath(API.cluster, ns, this.name));
        this.notFound = false;
        this.loadError = '';
      } catch (e) {
        if (httpStatus(e) === 404) {
          this.notFound = true;
          this.cluster = null;
        } else {
          this.loadError = errorText(e);
        }

        return;
      }

      const infraName = this.cluster.spec?.infrastructureRef?.name;
      const cpName = this.cluster.spec?.controlPlaneRef?.name;
      const optional = async(fn, fallback) => {
        try {
          return await fn();
        } catch (e) {
          return fallback;
        }
      };
      const guarded = async(key, api, fn) => {
        try {
          const r = await fn();

          this.allow(key);

          return r?.items || [];
        } catch (e) {
          if (httpStatus(e) === 403) {
            this.deny(key, api, 'list');
          }

          return null;
        }
      };

      const [infra, cp, mds, templates, machines, events] = await Promise.all([
        optional(() => (infraName ? this.mgmt('get', objectPath(API.infraCluster, ns, infraName)) : null), null),
        optional(() => (cpName ? this.mgmt('get', objectPath(API.controlPlane, ns, cpName)) : null), null),
        optional(() => this.mgmt('get', collectionPath(API.md, ns) + selector), { items: [] }),
        optional(() => this.mgmt('get', collectionPath(API.infraMachine, ns)), { items: [] }),
        guarded('machines', READ_API.machine, () => this.listMachines(ns, selector)),
        guarded('events', READ_API.event, () => this.mgmt('get', collectionPath(READ_API.event, ns))),
      ]);

      this.infra = infra;
      this.controlPlane = cp;
      this.machineDeployments = mds?.items || [];
      this.templates = (templates?.items || []).reduce((acc, t) => ({ ...acc, [t.metadata.name]: t }), {});
      this.machines = machines;
      this.events = events;
      this.lastRefresh = new Date().toISOString();

      if (this.rancherReady) {
        await this.loadWorkload();
      }
    },

    /**
     * Machines of the cluster. A user whose rights name the cluster's objects one by one (Rancher's
     * per-cluster owner Role) is refused a plain list; Rancher's own API lists what such a user may read.
     */
    async listMachines(ns, selector) {
      try {
        return await this.mgmt('get', collectionPath(READ_API.machine, ns) + selector);
      } catch (e) {
        if (httpStatus(e) !== 403) {
          throw e;
        }
        const res = await this.request('get', `/v1/${ READ_API.machine.group }.${ READ_API.machine.resource }/${ ns }`);
        const items = (res?.data || []).filter((m) => m.metadata?.labels?.[CLUSTER_NAME_LABEL] === this.name);

        if (!items.length) {
          throw e;
        }

        return { items };
      }
    },

    /** Nodes and the Release of the workload cluster, through Rancher's cluster proxy. */
    async loadWorkload() {
      if (!this.rancherCluster) {
        return;
      }
      try {
        this.nodes = (await this.workload('get', '/api/v1/nodes'))?.items || [];
      } catch (e) {
        this.nodes = null;
      }
      try {
        const list = await this.workload('get', `/apis/${ RELEASE_API.group }/${ RELEASE_API.version }/${ RELEASE_API.resource }`);

        this.release = (list?.items || [])[0] || null;
        this.releaseError = '';
        this.releaseDenied = '';
      } catch (e) {
        const status = httpStatus(e);

        if (status === 403) {
          this.releaseDenied = rightText(RELEASE_API, 'list');
        } else if (status === 404) {
          this.releaseError = this.t('elemental3.release.noLifecycleManager');
        } else {
          this.releaseError = errorText(e);
        }
      }
    },

    async review(base, api, verb, name) {
      try {
        const r = await this.request('post', `${ base }${ ACCESS_REVIEW_PATH }`, accessReview(api, verb, this.namespace, name));

        return r?.status?.allowed === true;
      } catch (e) {
        return null;
      }
    },

    /** Asks the API server what the user may do, so that a control the user cannot use says so instead of failing. */
    async loadRights() {
      if (!this.cluster) {
        return;
      }
      // Asked for the cluster's own objects by name: rights may be granted per object
      const mdName = this.machineDeployments[0]?.metadata?.name;
      const cpName = this.cluster.spec?.controlPlaneRef?.name;
      const [md, cp, del] = await Promise.all([
        mdName ? this.review(MGMT_API, API.md, 'patch', mdName) : Promise.resolve(null),
        this.review(MGMT_API, API.controlPlane, 'patch', cpName),
        this.review(MGMT_API, API.cluster, 'delete', this.name),
      ]);

      this.can = {
        scaleWorkers: md === true, scaleControlPlane: cp === true, deleteCluster: del === true
      };
      const mark = (key, allowed, api, verb) => (allowed === false ? this.deny(key, api, verb) : this.allow(key));

      mark('scaleWorkers', md, API.md, 'patch');
      mark('scaleControlPlane', cp, API.controlPlane, 'patch');
      mark('deleteCluster', del, API.cluster, 'delete');
    },

    /** Releases the management side knows about: delivered node images, annotated Harvester images, other clusters. */
    async loadKnownReleases() {
      const known = [];
      const add = (ref, source) => {
        const r = parseManifestRef(ref);

        if (r) {
          known.push({ ...r, source });
        }
      };

      if (this.$store.getters['management/schemaFor'](NODE_IMAGE_TYPE)) {
        try {
          const nodeImages = await this.$store.dispatch('management/findAll', { type: NODE_IMAGE_TYPE });

          (nodeImages || []).forEach((n) => add(n.spec?.release?.manifest, 'nodeImage'));
        } catch (e) {}
      }

      const harvesters = (this.mgmtClusters || []).filter((c) => c.status?.provider === 'harvester').map((c) => c.id);
      const recorded = this.cluster?.metadata?.annotations?.[HARVESTER_CLUSTER_ANNOTATION];
      const harvesterId = harvesters.includes(recorded) ? recorded : (harvesters.length === 1 ? harvesters[0] : '');

      if (harvesterId) {
        try {
          const images = await this.request('get', `${ harvesterBase(harvesterId) }/harvesterhci.io.virtualmachineimages`);

          (images?.data || []).forEach((i) => add(i.metadata?.annotations?.[IMAGE_RELEASE_ANNOTATION], 'image'));
        } catch (e) {}
      }

      try {
        const clusters = await this.mgmt('get', collectionPath(API.cluster, this.namespace));

        (clusters?.items || []).forEach((c) => add(c.metadata?.annotations?.[RELEASE_ANNOTATION], 'cluster'));
      } catch (e) {}

      this.knownReleases = known;
    },

    // ---- writes ----

    /** Scale: one merge patch of spec.replicas. Cluster API does the rest. */
    async scale(pool, delta) {
      const replicas = pool.desired + delta;

      if (replicas < pool.min || this.busy) {
        return;
      }
      const api = pool.kind === 'MachineDeployment' ? API.md : API.controlPlane;

      this.confirmScaleDown = '';
      this.busy = `scale:${ pool.key }`;
      this.actionError = '';
      try {
        await this.mgmt('patch', objectPath(api, this.namespace, pool.name), { spec: { replicas } }, 'application/merge-patch+json');
        await this.load();
      } catch (e) {
        this.actionError = this.t('elemental3.pools.scaleFailed', { name: pool.name, error: errorText(e) }, true);
        if (httpStatus(e) === 403) {
          this.deny(pool.role === 'worker' ? 'scaleWorkers' : 'scaleControlPlane', api, 'patch');
        }
      }
      this.busy = '';
    },

    releasePath(release) {
      return `/apis/${ RELEASE_API.group }/${ RELEASE_API.version }/namespaces/${ release.metadata.namespace }/${ RELEASE_API.resource }`;
    },

    writeRelease(dryRun) {
      const obj = buildRelease(this.name, this.target, this.release);
      const q = dryRun ? '?dryRun=All' : '';

      if (this.release) {
        return this.workload('patch', `${ this.releasePath(obj) }/${ obj.metadata.name }${ q }`, { spec: obj.spec }, 'application/merge-patch+json');
      }

      return this.workload('post', `${ this.releasePath(obj) }${ q }`, obj);
    },

    /** Pre-flight: the API server and the Lifecycle Manager's admission webhook judge the object without storing it. */
    async dryRunRelease() {
      const key = this.targetKey;

      if (!this.rancherCluster || !this.target) {
        return;
      }
      let result = '';

      try {
        await this.writeRelease(true);
      } catch (e) {
        result = errorText(e);
        if (httpStatus(e) === 403) {
          this.releaseDenied = rightText(RELEASE_API, this.release ? 'patch' : 'create');
        }
      }
      if (key === this.targetKey) {
        this.dryRunError = result;
        this.dryRunFor = key;
      }
    },

    /** The upgrade: one Release object. */
    async startUpgrade() {
      if (!this.canUpgrade) {
        return;
      }
      this.busy = 'upgrade';
      this.actionError = '';
      try {
        this.release = await this.writeRelease(false);
        this.targetKey = '';
        await this.loadWorkload();
      } catch (e) {
        this.actionError = this.t('elemental3.release.upgradeFailed', { error: errorText(e) }, true);
      }
      this.busy = '';
    },

    async deleteCluster() {
      this.busy = 'delete';
      this.actionError = '';
      try {
        await this.mgmt('delete', objectPath(API.cluster, this.namespace, this.name));
        this.confirmDelete = false;
        await this.load();
      } catch (e) {
        this.actionError = this.t('elemental3.detail.deleteFailed', { error: errorText(e) }, true);
      }
      this.busy = '';
    },

    stateColor(state) {
      return {
        done: 'bg-success', ready: 'bg-success', applied: 'bg-success', active: 'bg-info', provisioning: 'bg-info', inProgress: 'bg-info', pending: 'bg-info', error: 'bg-error', failed: 'bg-error', deleting: 'bg-warning'
      }[state] || 'bg-darker';
    },

    checkIcon(passed) {
      return passed === true ? 'icon-checkmark text-success' : (passed === false ? 'icon-error text-error' : 'icon-info text-muted');
    },

    short(ts) {
      return ts ? `${ ts }`.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '';
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="elemental3-detail"
    data-testid="elemental3-detail"
  >
    <header class="e3-header">
      <div>
        <div class="text-muted">
          <router-link
            :to="listRoute"
            data-testid="elemental3-detail-back"
          >
            {{ t('elemental3.nav') }}
          </router-link>
          / {{ namespace }}
        </div>
        <h1 class="mb-5">
          {{ name }}
          <span
            v-if="cluster"
            class="badge-state"
            :class="stateColor(state)"
            data-testid="elemental3-detail-state"
          >{{ t(`elemental3.state.${ state }`) }}</span>
        </h1>
        <div
          v-if="cluster"
          class="text-muted"
        >
          {{ t('elemental3.detail.endpoint') }}: <span data-testid="elemental3-detail-endpoint">{{ endpoint || t('elemental3.detail.endpointPending') }}</span>
          <template v-if="controlPlane">
            &nbsp;·&nbsp; {{ t('elemental3.fields.kubernetesVersion') }}: {{ controlPlane.spec.version }}
          </template>
          <template v-if="lastRefresh">
            &nbsp;·&nbsp; {{ t('elemental3.detail.refreshed', { time: short(lastRefresh) }) }}
          </template>
        </div>
      </div>
      <div
        v-if="cluster"
        class="e3-actions"
      >
        <router-link
          v-if="explorerRoute && rancherReady"
          :to="explorerRoute"
          class="btn role-secondary"
          data-testid="elemental3-detail-explore"
        >
          {{ t('elemental3.detail.explore') }}
        </router-link>
        <button
          v-if="!confirmDelete"
          type="button"
          class="btn role-secondary"
          :disabled="!can.deleteCluster || !!cluster.metadata.deletionTimestamp"
          :title="can.deleteCluster ? '' : t('elemental3.rights.missing', { right: denied.deleteCluster || '' })"
          data-testid="elemental3-detail-delete"
          @click="confirmDelete = true"
        >
          {{ t('elemental3.detail.delete') }}
        </button>
        <template v-else>
          <span class="text-error">{{ t('elemental3.detail.deleteConfirm', { name }) }}</span>
          <button
            type="button"
            class="btn bg-error"
            :disabled="busy === 'delete'"
            data-testid="elemental3-detail-delete-confirm"
            @click="deleteCluster"
          >
            {{ t('elemental3.detail.delete') }}
          </button>
          <button
            type="button"
            class="btn role-secondary"
            @click="confirmDelete = false"
          >
            {{ t('generic.cancel') }}
          </button>
        </template>
      </div>
    </header>

    <Banner
      v-if="notFound"
      color="warning"
      data-testid="elemental3-detail-not-found"
      :label="t('elemental3.detail.notFound', { name, namespace })"
    />
    <Banner
      v-if="loadError"
      color="error"
      :label="loadError"
    />
    <Banner
      v-if="actionError"
      color="error"
      data-testid="elemental3-detail-action-error"
      :label="actionError"
    />

    <template v-if="cluster">
      <Banner
        v-if="cluster.metadata.deletionTimestamp"
        color="warning"
        data-testid="elemental3-detail-deleting"
        :label="t('elemental3.detail.deleting')"
      />
      <Banner
        v-for="(p, i) in problemList"
        :key="`problem-${ i }`"
        :color="p.blocking ? 'error' : 'warning'"
        data-testid="elemental3-detail-problem"
        :data-blocking="`${ p.blocking }`"
      >
        <span><b>{{ p.kind }} {{ p.name }}</b> · {{ p.type }}<template v-if="p.reason"> ({{ p.reason }})</template>: {{ p.message }}<template v-if="!p.blocking"> — {{ t('elemental3.detail.notBlocking') }}</template></span>
      </Banner>
      <Banner
        v-if="deniedList.length"
        color="warning"
        data-testid="elemental3-detail-denied"
      >
        <div>
          <p>{{ t('elemental3.rights.title') }}</p>
          <ul class="mb-0">
            <li
              v-for="(d, i) in deniedList"
              :key="i"
            >
              {{ d }}
            </li>
          </ul>
        </div>
      </Banner>

      <!-- Progress: what is happening, from object status only -->
      <section
        class="e3-panel"
        data-testid="elemental3-progress"
      >
        <h3>{{ t('elemental3.progress.title') }}</h3>
        <p
          v-if="waitingFor"
          class="e3-waiting"
          data-testid="elemental3-progress-waiting"
        >
          <i
            v-if="waitingFor.state !== 'error'"
            class="icon icon-spinner icon-spin"
          />
          <i
            v-else
            class="icon icon-error text-error"
          />
          <b>{{ t(`elemental3.progress.waitingFor.${ waitingFor.key }`) }}</b>
          <span v-if="waitingFor.message"> — {{ waitingFor.message }}</span>
        </p>
        <p
          v-else
          class="e3-waiting"
          data-testid="elemental3-progress-done"
        >
          <i class="icon icon-checkmark text-success" /> <b>{{ t('elemental3.progress.provisioned') }}</b>
        </p>
        <ol class="e3-phases">
          <li
            v-for="p in phases"
            :key="p.key"
            :class="`e3-phase-${ p.state }`"
            :data-testid="`elemental3-phase-${ p.key }`"
            :data-state="p.state"
          >
            <span
              class="badge-state"
              :class="stateColor(p.state)"
            >{{ t(`elemental3.progress.state.${ p.state }`) }}</span>
            <span class="e3-phase-title">{{ t(`elemental3.progress.phase.${ p.key }`) }}</span>
            <span class="text-muted">{{ t(`elemental3.progress.detail.${ p.code }`, p.params, true) }}</span>
            <span
              v-if="p.message"
              class="e3-phase-message"
            >{{ p.message }}</span>
          </li>
        </ol>
        <p class="text-muted mb-0">
          {{ t('elemental3.progress.note') }}
        </p>
      </section>

      <!-- Elemental release: one version for OS, Kubernetes and applications -->
      <section
        class="e3-panel"
        data-testid="elemental3-release"
      >
        <h3>{{ t('elemental3.release.title') }}</h3>
        <div class="row mb-10">
          <div class="col span-4">
            <div class="text-muted">
              {{ t('elemental3.release.current') }}
            </div>
            <div
              class="e3-version"
              data-testid="elemental3-release-current"
            >
              {{ currentRelease ? currentRelease.version : t('elemental3.release.unknown') }}
            </div>
            <div class="text-muted">
              {{ t('elemental3.release.oneVersion') }}
            </div>
            <div
              v-if="currentRelease"
              class="text-muted e3-small"
            >
              {{ currentRelease.registry }}
              <template v-if="!release || !release.status || !release.status.version">
                · {{ t('elemental3.release.fromCreate') }}
              </template>
            </div>
          </div>
          <div class="col span-5">
            <LabeledSelect
              v-model:value="targetKey"
              mode="edit"
              :options="releaseOptions"
              :taggable="true"
              :searchable="true"
              :clearable="true"
              :disabled="!rancherReady || !!releaseDenied || upgradeRunning"
              :label="t('elemental3.release.target')"
              :placeholder="t('elemental3.release.targetPlaceholder')"
              data-testid="elemental3-release-target"
            />
            <div
              v-if="notOffered.length"
              class="text-muted e3-small mt-5"
              data-testid="elemental3-release-not-offered"
            >
              <div
                v-for="(n, i) in notOffered"
                :key="i"
              >
                {{ n }}
              </div>
            </div>
          </div>
          <div class="col span-3">
            <button
              type="button"
              class="btn role-primary"
              :disabled="!canUpgrade"
              data-testid="elemental3-release-upgrade"
              @click="startUpgrade"
            >
              {{ t('elemental3.release.upgrade') }}
            </button>
          </div>
        </div>

        <Banner
          v-if="!rancherCluster"
          color="warning"
          data-testid="elemental3-release-not-visible"
          :label="t('elemental3.release.notVisible')"
        />
        <Banner
          v-else-if="!rancherReady"
          color="info"
          :label="t('elemental3.release.notReady')"
        />
        <Banner
          v-if="releaseDenied"
          color="warning"
          data-testid="elemental3-release-denied"
          :label="t('elemental3.rights.missing', { right: releaseDenied }, true)"
        />
        <Banner
          v-if="releaseError"
          color="error"
          data-testid="elemental3-release-error"
          :label="releaseError"
        />
        <Banner
          v-if="targetInvalid"
          color="error"
          :label="t('elemental3.release.targetInvalid')"
        />

        <div
          v-if="target"
          class="mb-10"
          data-testid="elemental3-preflight"
        >
          <h4>{{ t('elemental3.preflight.title', { version: target.version }) }}</h4>
          <ul class="e3-checks">
            <li
              v-for="c in preflightChecks"
              :key="c.key"
              :data-testid="`elemental3-preflight-${ c.key }`"
              :data-passed="`${ c.passed }`"
            >
              <i
                class="icon"
                :class="checkIcon(c.passed)"
              />
              {{ t(`elemental3.preflight.${ c.key }.${ c.passed === true ? 'ok' : (c.passed === false ? 'failed' : 'unknown') }`, c.params, true) }}
            </li>
          </ul>
          <p class="text-muted e3-small mb-0">
            {{ t('elemental3.preflight.note', { manifest: `${ target.registry }:${ target.version }` }) }}
          </p>
        </div>

        <div
          v-if="release"
          data-testid="elemental3-upgrade-progress"
        >
          <h4>
            {{ t('elemental3.release.progressTitle', { version: release.spec.version }) }}
            <span
              class="badge-state"
              :class="stateColor(upgrade)"
              data-testid="elemental3-upgrade-state"
              :data-state="upgrade"
            >{{ t(`elemental3.release.state.${ upgrade }`) }}</span>
          </h4>
          <ol class="e3-phases">
            <li
              v-for="p in upgradePhaseList"
              :key="p.type"
              :data-testid="`elemental3-upgrade-phase-${ p.type }`"
              :data-state="p.state"
            >
              <span
                class="badge-state"
                :class="stateColor(p.state)"
              >{{ t(`elemental3.progress.state.${ p.state }`) }}</span>
              <span class="e3-phase-title">{{ t(`elemental3.release.phase.${ p.type }`) }}</span>
              <span class="text-muted">{{ p.message }}</span>
              <span
                v-if="p.since"
                class="text-muted e3-small"
              >{{ short(p.since) }}</span>
            </li>
          </ol>
        </div>

        <table
          v-if="nodeList && nodeList.length"
          class="e3-table"
          data-testid="elemental3-nodes"
        >
          <thead>
            <tr>
              <th>{{ t('elemental3.nodes.name') }}</th>
              <th>{{ t('elemental3.nodes.roles') }}</th>
              <th>{{ t('elemental3.nodes.state') }}</th>
              <th>{{ t('elemental3.nodes.kubelet') }}</th>
              <th>{{ t('elemental3.nodes.os') }}</th>
              <th>{{ t('elemental3.nodes.kernel') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="n in nodeList"
              :key="n.name"
            >
              <td>{{ n.name }}</td>
              <td>{{ n.roles }}</td>
              <td>
                {{ n.ready ? t('elemental3.nodes.ready') : t('elemental3.nodes.notReady') }}<template v-if="n.cordoned">
                  , {{ t('elemental3.nodes.cordoned') }}
                </template>
              </td>
              <td>{{ n.kubelet }}</td>
              <td>{{ n.osImage }}</td>
              <td>{{ n.kernel }}</td>
            </tr>
          </tbody>
        </table>
        <p class="text-muted e3-small mb-0">
          {{ t('elemental3.release.rollbackNote') }}
        </p>
      </section>

      <Tabbed
        :side-tabs="false"
        default-tab="pools"
        :use-hash="false"
      >
        <Tab
          name="pools"
          :label="t('elemental3.pools.title')"
          :weight="4"
        >
          <table
            class="e3-table"
            data-testid="elemental3-pools"
          >
            <thead>
              <tr>
                <th>{{ t('elemental3.pools.pool') }}</th>
                <th>{{ t('elemental3.pools.role') }}</th>
                <th>{{ t('elemental3.pools.machines') }}</th>
                <th>{{ t('elemental3.pools.size') }}</th>
                <th>{{ t('elemental3.fields.kubernetesVersion') }}</th>
                <th>{{ t('elemental3.pools.scale') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in pools"
                :key="p.key"
                :data-testid="`elemental3-pool-${ p.role }`"
              >
                <td>{{ p.name }}</td>
                <td>{{ t(`elemental3.pools.roles.${ p.role }`) }}</td>
                <td :data-testid="`elemental3-pool-${ p.role }-count`">
                  {{ t('elemental3.pools.readyOf', { ready: p.ready, desired: p.desired }) }}
                </td>
                <td>
                  <template v-if="p.cpu">
                    {{ p.cpu }} CPU · {{ p.memory }} · {{ p.disk }}
                  </template>
                </td>
                <td>{{ p.version }}</td>
                <td>
                  <button
                    type="button"
                    class="btn btn-sm role-secondary"
                    :disabled="!p.canScale || p.desired <= p.min || !!busy"
                    :title="p.canScale ? '' : t('elemental3.pools.cannotScale')"
                    :data-testid="`elemental3-pool-${ p.role }-minus`"
                    @click="confirmScaleDown = p.key"
                  >
                    −
                  </button>
                  <span
                    class="e3-desired"
                    :data-testid="`elemental3-pool-${ p.role }-desired`"
                  >{{ p.desired }}</span>
                  <button
                    type="button"
                    class="btn btn-sm role-secondary"
                    :disabled="!p.canScale || !!busy"
                    :title="p.canScale ? '' : t('elemental3.pools.cannotScale')"
                    :data-testid="`elemental3-pool-${ p.role }-plus`"
                    @click="scale(p, 1)"
                  >
                    +
                  </button>
                  <span
                    v-if="confirmScaleDown === p.key"
                    class="ml-10"
                  >
                    {{ t('elemental3.pools.scaleDownConfirm', { name: p.name }) }}
                    <button
                      type="button"
                      class="btn btn-sm bg-error"
                      :data-testid="`elemental3-pool-${ p.role }-minus-confirm`"
                      @click="scale(p, -1)"
                    >
                      {{ t('elemental3.pools.remove') }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm role-secondary"
                      @click="confirmScaleDown = ''"
                    >
                      {{ t('generic.cancel') }}
                    </button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <Banner
            v-if="denied.scaleWorkers || denied.scaleControlPlane"
            color="warning"
            data-testid="elemental3-pools-denied"
            :label="t('elemental3.rights.missing', { right: [denied.scaleWorkers, denied.scaleControlPlane].filter((x) => !!x).join('; ') })"
          />

          <h4 class="mt-20">
            {{ t('elemental3.machines.title') }}
          </h4>
          <Banner
            v-if="denied.machines"
            color="warning"
            data-testid="elemental3-machines-denied"
            :label="t('elemental3.rights.missing', { right: denied.machines })"
          />
          <table
            v-else
            class="e3-table"
            data-testid="elemental3-machines"
          >
            <thead>
              <tr>
                <th>{{ t('elemental3.machines.name') }}</th>
                <th>{{ t('elemental3.pools.role') }}</th>
                <th>{{ t('elemental3.machines.phase') }}</th>
                <th>{{ t('elemental3.machines.node') }}</th>
                <th>{{ t('elemental3.machines.message') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="m in machineList"
                :key="m.name"
              >
                <td>{{ m.name }}</td>
                <td>{{ t(`elemental3.pools.roles.${ m.role }`) }}</td>
                <td>{{ m.phase }}</td>
                <td>{{ m.node }}</td>
                <td>{{ m.message }}</td>
              </tr>
              <tr v-if="!machineList.length">
                <td colspan="5">
                  {{ t('elemental3.machines.none') }}
                </td>
              </tr>
            </tbody>
          </table>
        </Tab>

        <Tab
          name="conditions"
          :label="t('elemental3.conditions.title')"
          :weight="3"
        >
          <table
            class="e3-table"
            data-testid="elemental3-conditions"
          >
            <thead>
              <tr>
                <th>{{ t('elemental3.conditions.object') }}</th>
                <th>{{ t('elemental3.conditions.type') }}</th>
                <th>{{ t('elemental3.conditions.status') }}</th>
                <th>{{ t('elemental3.conditions.reason') }}</th>
                <th>{{ t('elemental3.conditions.message') }}</th>
                <th>{{ t('elemental3.conditions.since') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(c, i) in conditionList"
                :key="i"
              >
                <td>{{ c.kind }} {{ c.name }}</td>
                <td>{{ c.type }}</td>
                <td>{{ c.status }}</td>
                <td>{{ c.reason }}</td>
                <td>{{ c.message }}</td>
                <td>{{ short(c.lastTransitionTime) }}</td>
              </tr>
            </tbody>
          </table>
        </Tab>

        <Tab
          name="events"
          :label="t('elemental3.events.title')"
          :weight="2"
        >
          <Banner
            v-if="denied.events"
            color="warning"
            data-testid="elemental3-events-denied"
            :label="t('elemental3.rights.missing', { right: denied.events })"
          />
          <table
            v-else
            class="e3-table"
            data-testid="elemental3-events"
          >
            <thead>
              <tr>
                <th>{{ t('elemental3.events.time') }}</th>
                <th>{{ t('elemental3.events.type') }}</th>
                <th>{{ t('elemental3.events.reason') }}</th>
                <th>{{ t('elemental3.events.object') }}</th>
                <th>{{ t('elemental3.events.message') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(e, i) in eventList"
                :key="i"
              >
                <td>{{ short(e.time) }}</td>
                <td>{{ e.type }}</td>
                <td>{{ e.reason }}</td>
                <td>{{ e.object }}</td>
                <td>{{ e.message }}</td>
              </tr>
              <tr v-if="!eventList.length">
                <td colspan="5">
                  {{ t('elemental3.events.none') }}
                </td>
              </tr>
            </tbody>
          </table>
          <p class="text-muted e3-small">
            {{ t('elemental3.events.note') }}
          </p>
        </Tab>
      </Tabbed>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.elemental3-detail {
  .e3-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 15px;
  }
  .e3-actions {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .e3-panel {
    border: 1px solid var(--border);
    border-radius: var(--border-radius);
    padding: 15px;
    margin-bottom: 20px;
  }
  .e3-waiting {
    font-size: 15px;
    margin: 5px 0 10px 0;
  }
  .e3-phases {
    list-style: none;
    padding: 0;
    margin: 0 0 10px 0;

    li {
      display: flex;
      gap: 10px;
      align-items: baseline;
      padding: 4px 0;
      flex-wrap: wrap;
    }
    .e3-phase-title {
      font-weight: bold;
      min-width: 190px;
    }
    .e3-phase-message {
      flex-basis: 100%;
      padding-left: 100px;
    }
    .badge-state {
      min-width: 90px;
      text-align: center;
    }
  }
  .e3-checks {
    list-style: none;
    padding: 0;
    margin: 0 0 5px 0;

    li {
      padding: 2px 0;
    }
  }
  .e3-version {
    font-size: 22px;
    font-weight: bold;
  }
  .e3-small {
    font-size: 12px;
  }
  .e3-desired {
    display: inline-block;
    min-width: 30px;
    text-align: center;
    font-weight: bold;
  }
  .badge-state {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: normal;
    vertical-align: middle;
  }
  .e3-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 10px;

    th, td {
      text-align: left;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: normal;
    }
  }
}
</style>
