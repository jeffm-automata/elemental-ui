<script>
import Loading from '@shell/components/Loading';
import { Banner } from '@components/Banner';
import { MANAGEMENT, NAMESPACE } from '@shell/config/types';
import {
  API, READ_API, CLUSTER_NAME_LABEL, RELEASE_ANNOTATION, collectionPath, rightText
} from '../lib/objects';
import { clusterState, poolRows } from '../lib/status';
import { RELEASE_API, appliedVersion, parseManifestRef, runningKubernetes } from '../lib/release';
import { errorText } from '../lib/harvester';
import { Elemental3HarvesterProvisioner } from '../provisioner';
import { DETAIL_ROUTE, BLANK_CLUSTER } from '../product';

const MGMT_API = '/k8s/clusters/local';
const OWNER_LABEL = 'cluster-api.cattle.io/capi-cluster-owner';
const OWNER_NS_LABEL = 'cluster-api.cattle.io/capi-cluster-owner-ns';
const REFRESH_MS = 15000;

function httpStatus(e) {
  return e?._status || e?.status || e?.response?.status || 0;
}

/**
 * Elemental 3 clusters the logged-in user can read on the management cluster: Cluster API clusters whose
 * control plane is an RKE2ControlPlane. A cluster is listed here from the moment its objects exist,
 * which is before Rancher shows it under Clusters (that needs the import by Rancher Turtles and
 * membership of the imported cluster). Read only.
 */
export default {
  name: 'Elemental3ClusterList',

  components: { Loading, Banner },

  async fetch() {
    try {
      this.mgmtClusters = await this.$store.dispatch('management/findAll', { type: MANAGEMENT.CLUSTER });
    } catch (e) {
      this.mgmtClusters = [];
    }
    await this.load();
  },

  data() {
    return {
      mgmtClusters: [],
      rows:         [],
      // Release the Lifecycle Manager reports as applied, per "namespace/name"; read from each workload cluster
      applied:      {},
      scope:        '',
      error:        '',
      timer:        null,
    };
  },

  mounted() {
    this.timer = setInterval(() => this.load(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  computed: {
    createRoute() {
      return {
        name:   'c-cluster-product-resource-create',
        params: {
          cluster: BLANK_CLUSTER, product: 'manager', resource: 'provisioning.cattle.io.cluster'
        },
        query: { type: Elemental3HarvesterProvisioner.ID, rkeType: 'rke2' },
      };
    },
  },

  methods: {
    get(path) {
      return this.$store.dispatch('management/request', { url: `${ MGMT_API }${ path }` });
    },

    async listAll(api, namespaces) {
      // All namespaces when the user may; otherwise every namespace the user can see, one by one
      if (!namespaces) {
        const prefix = `/apis/${ api.group }/${ api.version }/${ api.resource }`;

        return (await this.get(prefix))?.items || [];
      }
      const results = await Promise.allSettled(namespaces.map((ns) => this.get(collectionPath(api, ns))));

      return results.flatMap((r) => (r.status === 'fulfilled' ? r.value?.items || [] : []));
    },

    async load() {
      let namespaces = null;
      let clusters;

      try {
        clusters = await this.listAll(API.cluster, null);
        this.scope = '';
      } catch (e) {
        if (httpStatus(e) !== 403) {
          this.error = errorText(e);

          return;
        }
        let all = [];

        try {
          all = await this.$store.dispatch('management/findAll', { type: NAMESPACE });
        } catch (e2) {}
        namespaces = (all || []).map((n) => n.metadata?.name).filter((n) => !!n);
        clusters = await this.listAll(API.cluster, namespaces);
        this.scope = this.t('elemental3.list.scope', { right: rightText(API.cluster, 'list'), count: namespaces.length });
      }
      this.error = '';
      clusters = clusters.filter((c) => c.spec?.controlPlaneRef?.kind === API.controlPlane.kind);

      const scopeNs = namespaces ? [...new Set(clusters.map((c) => c.metadata.namespace))] : null;
      const [cps, mds, infras, machines] = await Promise.all([
        this.listAll(API.controlPlane, scopeNs).catch(() => []),
        this.listAll(API.md, scopeNs).catch(() => []),
        this.listAll(API.infraCluster, scopeNs).catch(() => []),
        // What the nodes run (Cluster API copies it into the Machine status). Not listable for every user.
        this.listAll(READ_API.machine, scopeNs || [...new Set(clusters.map((c) => c.metadata.namespace))]).catch(() => []),
      ]);
      const same = (o, ns, name) => o.metadata?.namespace === ns && o.metadata?.name === name;

      this.rows = clusters.map((c) => {
        const ns = c.metadata.namespace;
        const name = c.metadata.name;
        const objects = {
          cluster:            c,
          controlPlane:       cps.find((o) => same(o, ns, c.spec?.controlPlaneRef?.name)),
          infra:              infras.find((o) => same(o, ns, c.spec?.infrastructureRef?.name)),
          machineDeployments: mds.filter((o) => o.metadata?.namespace === ns && (o.spec?.clusterName === name || o.metadata?.labels?.[CLUSTER_NAME_LABEL] === name)),
          rancherCluster:     (this.mgmtClusters || []).find((m) => m.metadata?.labels?.[OWNER_LABEL] === name && m.metadata?.labels?.[OWNER_NS_LABEL] === ns) || null,
        };
        const pools = poolRows(objects);
        const cp = pools.find((p) => p.role === 'controlPlane');
        const kubelets = machines.filter((m) => m.metadata?.namespace === ns && m.metadata?.labels?.[CLUSTER_NAME_LABEL] === name).map((m) => m.status?.nodeInfo?.kubeletVersion || '');
        const running = runningKubernetes(kubelets);
        const created = parseManifestRef(c.metadata?.annotations?.[RELEASE_ANNOTATION] || '')?.version || '';
        const workers = pools.filter((p) => p.role === 'worker').reduce((acc, p) => ({ ready: acc.ready + p.ready, desired: acc.desired + p.desired }), { ready: 0, desired: 0 });

        return {
          key:          `${ ns }/${ name }`,
          name,
          namespace:    ns,
          state:        clusterState(objects),
          controlPlane: cp ? `${ cp.ready }/${ cp.desired }` : '',
          workers:      `${ workers.ready }/${ workers.desired }`,
          // What runs: the nodes' versions and the release the Lifecycle Manager applied. The Cluster API
          // version and the release annotation only say what the cluster was created with.
          version:      running.length ? running.map((r) => r.version).join(', ') : (cp?.version || ''),
          release:      this.applied[`${ ns }/${ name }`] || created,
          rancher:      objects.rancherCluster?.id || '',
          rancherReady: (objects.rancherCluster?.status?.conditions || []).some((x) => x.type === 'Ready' && x.status === 'True'),
          created:      c.metadata?.creationTimestamp || '',
          route:        {
            name:   DETAIL_ROUTE,
            params: {
              cluster: BLANK_CLUSTER, namespace: ns, id: name
            }
          },
        };
      }).sort((a, b) => a.key.localeCompare(b.key));
      this.loadApplied();
    },

    /** The applied release of every cluster that is reachable through Rancher; the next refresh shows it. */
    async loadApplied() {
      const found = {};

      await Promise.allSettled(this.rows.filter((r) => r.rancher && r.rancherReady).map(async(r) => {
        const list = await this.$store.dispatch('management/request', { url: `/k8s/clusters/${ r.rancher }/apis/${ RELEASE_API.group }/${ RELEASE_API.version }/${ RELEASE_API.resource }` });
        const v = appliedVersion((list?.items || [])[0]);

        if (v) {
          found[r.key] = v;
        }
      }));
      const changed = JSON.stringify(found) !== JSON.stringify(this.applied);

      this.applied = found;
      if (changed) {
        this.rows = this.rows.map((r) => (found[r.key] ? { ...r, release: found[r.key] } : r));
      }
    },

    stateColor(state) {
      return {
        ready: 'bg-success', provisioning: 'bg-info', error: 'bg-error', deleting: 'bg-warning'
      }[state] || 'bg-darker';
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="elemental3-list"
    data-testid="elemental3-list"
  >
    <header class="e3-header">
      <div>
        <h1 class="mb-5">
          {{ t('elemental3.nav') }}
        </h1>
        <p class="text-muted">
          {{ t('elemental3.list.description') }}
        </p>
      </div>
      <router-link
        :to="createRoute"
        class="btn role-primary"
        data-testid="elemental3-list-create"
      >
        {{ t('elemental3.list.create') }}
      </router-link>
    </header>
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-if="scope"
      color="info"
      data-testid="elemental3-list-scope"
      :label="scope"
    />
    <table class="e3-table">
      <thead>
        <tr>
          <th>{{ t('elemental3.list.state') }}</th>
          <th>{{ t('elemental3.fields.name') }}</th>
          <th>{{ t('elemental3.fields.namespace') }}</th>
          <th>{{ t('elemental3.list.release') }}</th>
          <th>{{ t('elemental3.fields.kubernetesVersion') }}</th>
          <th>{{ t('elemental3.sections.controlPlane') }}</th>
          <th>{{ t('elemental3.sections.workers') }}</th>
          <th>{{ t('elemental3.list.rancher') }}</th>
          <th>{{ t('elemental3.list.created') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.key"
          :data-testid="`elemental3-list-row-${ r.name }`"
        >
          <td>
            <span
              class="badge-state"
              :class="stateColor(r.state)"
            >{{ t(`elemental3.state.${ r.state }`) }}</span>
          </td>
          <td>
            <router-link
              :to="r.route"
              :data-testid="`elemental3-list-link-${ r.name }`"
            >
              {{ r.name }}
            </router-link>
          </td>
          <td>{{ r.namespace }}</td>
          <td>{{ r.release }}</td>
          <td>{{ r.version }}</td>
          <td>{{ r.controlPlane }}</td>
          <td>{{ r.workers }}</td>
          <td>{{ r.rancher || t('elemental3.list.notVisible') }}</td>
          <td>{{ r.created }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td
            colspan="9"
            data-testid="elemental3-list-empty"
          >
            {{ t('elemental3.list.empty') }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style lang="scss" scoped>
.elemental3-list {
  .e3-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 15px;
  }
  .badge-state {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 12px;
  }
  .e3-table {
    width: 100%;
    border-collapse: collapse;

    th, td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }
    th {
      color: var(--muted);
      font-weight: normal;
    }
  }
}
</style>
