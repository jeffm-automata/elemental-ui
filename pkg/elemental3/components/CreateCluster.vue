<script>
import CruResource from '@shell/components/CruResource';
import Loading from '@shell/components/Loading';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import UnitInput from '@shell/components/form/UnitInput';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Banner } from '@components/Banner';
import { MANAGEMENT, NAMESPACE } from '@shell/config/types';
import { _CREATE } from '@shell/config/query-params';
import {
  API, buildObjects, collectionPath, defaultValues, validate
} from '../lib/objects';
import {
  NODE_IMAGE_TYPE, PREREQUISITES, harvesterBase, imageOptions, keyPairOptions, namespaceOptions, networkOptions, nodeImageOptions, errorText
} from '../lib/harvester';

const MGMT_API = '/k8s/clusters/local';
const PLACEHOLDER_UID = '00000000-0000-0000-0000-000000000000';

/**
 * Create form for an Elemental 3 cluster on Harvester.
 *
 * It only writes objects (the Cluster API objects and the identity Secret) with the rights of the
 * logged-in user. Everything that happens afterwards is done by the controllers on the management
 * cluster (Cluster API, CAPRKE2, CAPHV, Rancher Turtles).
 */
export default {
  name: 'Elemental3CreateCluster',

  emits: ['update:value'],

  components: {
    CruResource, Loading, LabeledSelect, LabeledInput, UnitInput, Banner
  },

  props: {
    mode: {
      type:    String,
      default: _CREATE,
    },
    // The provisioning.cattle.io.cluster model of the surrounding page. Not saved by this form.
    value: {
      type:    Object,
      default: () => ({}),
    },
  },

  async fetch() {
    const store = this.$store;

    try {
      this.mgmtClusters = await store.dispatch('management/findAll', { type: MANAGEMENT.CLUSTER });
    } catch (e) {
      this.mgmtClusters = [];
    }

    try {
      const all = await store.dispatch('management/findAll', { type: NAMESPACE });

      this.mgmtNamespaces = (all || []).map((n) => n.metadata?.name).filter((n) => !!n);
    } catch (e) {
      this.mgmtNamespaces = [];
    }

    if (store.getters['management/schemaFor'](NODE_IMAGE_TYPE)) {
      this.operatorInstalled = true;
      try {
        this.nodeImages = await store.dispatch('management/findAll', { type: NODE_IMAGE_TYPE });
      } catch (e) {
        this.nodeImages = [];
      }
    }

    if (this.harvesterClusterOptions.length === 1) {
      this.harvesterClusterId = this.harvesterClusterOptions[0].value;
    }
  },

  data() {
    return {
      form:               defaultValues(),
      harvesterClusterId: '',
      releaseKey:         '',
      mgmtClusters:       [],
      mgmtNamespaces:     [],
      operatorInstalled:  false,
      nodeImages:         [],
      harvester:          {
        loading: false, namespaces: [], images: [], networks: [], keyPairs: []
      },
      harvesterError: '',
      errors:         [],
    };
  },

  computed: {
    doneRoute() {
      return {
        name:   'c-cluster-product-resource',
        params: {
          cluster: '_', product: 'manager', resource: 'provisioning.cattle.io.cluster'
        },
      };
    },

    harvesterClusterOptions() {
      return (this.mgmtClusters || [])
        .filter((c) => c.status?.provider === 'harvester')
        .map((c) => ({ label: c.nameDisplay || c.spec?.displayName || c.id, value: c.id }));
    },

    /** What is missing on the management cluster, as translated sentences. Empty when all is there. */
    missingPrerequisites() {
      const schemaFor = this.$store.getters['management/schemaFor'];
      const out = [];

      PREREQUISITES.forEach((p) => {
        const schema = schemaFor(p.type);
        const canCreate = !!schema && (schema.collectionMethods || []).some((m) => `${ m }`.toLowerCase() === 'post');

        if (!canCreate) {
          out.push(this.t('elemental3.prerequisites.missing', { what: this.t(`elemental3.prerequisites.${ p.provider }`), kind: p.kind }));
        }
      });

      return out;
    },

    namespaceOptions() {
      const out = [...this.mgmtNamespaces];

      if (!out.includes(this.form.namespace)) {
        out.unshift(this.form.namespace);
      }

      return out.sort();
    },

    releaseOptions() {
      const fromOperator = nodeImageOptions(this.nodeImages, this.form.vmNamespace).map((o) => ({
        info:  o.value,
        value: o.value.image,
        label: this.t('elemental3.releaseOption.nodeImage', { release: o.release, version: o.value.kubernetesVersion }),
      }));
      const known = fromOperator.map((o) => o.value);
      const plain = imageOptions(this.harvester.images)
        .filter((o) => !known.includes(o.value.image))
        .map((o) => ({
          info: o.value, value: o.value.image, label: this.t('elemental3.releaseOption.image', { name: o.name })
        }));

      return [...fromOperator, ...plain];
    },

    release() {
      return this.releaseOptions.find((o) => o.value === this.releaseKey)?.info || null;
    },

    // Asked only when the selected image does not say which RKE2 it contains
    needsKubernetesVersion() {
      return !!this.release && !this.release.fromOperator;
    },

    vmNamespaceOptions() {
      return namespaceOptions(this.harvester.namespaces);
    },

    networkOptionsList() {
      return networkOptions(this.harvester.networks);
    },

    keyPairOptionsList() {
      return keyPairOptions(this.harvester.keyPairs, this.form.vmNamespace);
    },

    validationErrors() {
      const labels = {
        name:              this.t('elemental3.fields.name'),
        namespace:         this.t('elemental3.fields.namespace'),
        vmNamespace:       this.t('elemental3.fields.vmNamespace'),
        image:             this.t('elemental3.fields.release'),
        kubernetesVersion: this.t('elemental3.fields.kubernetesVersion'),
        network:           this.t('elemental3.fields.network'),
        sshKeyPair:        this.t('elemental3.fields.sshKeyPair'),
        controlPlaneHost:  this.t('elemental3.fields.controlPlaneHost'),
      };
      const poolLabel = (field) => {
        const [pool, f] = field.split('.');

        return `${ this.t(`elemental3.sections.${ pool }`) }: ${ this.t(`elemental3.fields.${ f }`) }`;
      };

      return validate(this.form).map((e) => this.t(`elemental3.validation.${ e.code }`, { field: labels[e.field] || poolLabel(e.field), ...(e.params || {}) }));
    },

    // The prerequisite banner does not block the button: which kinds the user may create in the chosen
    // namespace is only known for certain from the dry run that Create starts with.
    canCreate() {
      return !!this.harvesterClusterId && this.validationErrors.length === 0;
    },
  },

  watch: {
    harvesterClusterId: {
      handler(neu) {
        if (neu) {
          this.loadHarvester(neu);
        }
      },
      immediate: true,
    },

    releaseKey() {
      const neu = this.release;

      this.form.image = neu?.image || '';
      this.form.releaseManifest = neu?.releaseManifest || '';
      this.form.kubernetesVersion = neu?.kubernetesVersion || '';
    },

    'form.vmNamespace'() {
      // Key pairs are namespaced: keep the selection only if it still applies, and preselect a single choice
      const options = this.keyPairOptionsList.map((o) => o.value);

      if (!options.includes(this.form.sshKeyPair)) {
        this.form.sshKeyPair = options.length === 1 ? options[0] : '';
      }
    },
  },

  methods: {
    async loadHarvester(clusterId) {
      const base = harvesterBase(clusterId);
      const get = (type) => this.$store.dispatch('management/request', { url: `${ base }/${ type }` });

      this.harvester.loading = true;
      this.harvesterError = '';

      const [namespaces, images, networks, keyPairs] = await Promise.allSettled([
        get('namespaces'),
        get('harvesterhci.io.virtualmachineimages'),
        get('k8s.cni.cncf.io.network-attachment-definitions'),
        get('harvesterhci.io.keypairs'),
      ]);
      const failed = [namespaces, images, networks, keyPairs].find((r) => r.status === 'rejected');

      if (failed) {
        const cluster = this.harvesterClusterOptions.find((o) => o.value === clusterId)?.label || clusterId;

        this.harvesterError = this.t('elemental3.prerequisites.harvesterError', { cluster, error: errorText(failed.reason) });
      }

      const data = (r) => (r.status === 'fulfilled' ? r.value?.data || [] : []);

      this.harvester = {
        loading:    false,
        namespaces: data(namespaces),
        images:     data(images),
        networks:   data(networks),
        keyPairs:   data(keyPairs),
      };

      // A single choice is preselected, as Rancher does for a single cloud credential
      if (this.vmNamespaceOptions.length === 1) {
        this.form.vmNamespace = this.vmNamespaceOptions[0].value;
      }
      if (this.networkOptionsList.length === 1) {
        this.form.network = this.networkOptionsList[0].value;
      }
    },

    request(method, path, data) {
      const opt = {
        url: `${ MGMT_API }${ path }`, method, headers: { 'content-type': 'application/json' }
      };

      if (data) {
        opt.data = data;
      }

      return this.$store.dispatch('management/request', opt);
    },

    describe(o) {
      return {
        kind: o.api.kind, name: o.object.metadata.name, namespace: o.object.metadata.namespace
      };
    },

    /** Asks the API server to validate and authorise every object without storing anything. */
    async dryRun() {
      const objects = buildObjects(this.form, { kubeconfig: 'dry-run', clusterUid: PLACEHOLDER_UID });
      const results = await Promise.allSettled(objects.map((o) => this.request('post', `${ collectionPath(o.api, o.object.metadata.namespace) }?dryRun=All`, o.object)));
      const errors = [];

      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          errors.push(this.t('elemental3.save.denied', { ...this.describe(objects[i]), error: errorText(r.reason) }, true));
        }
      });

      return errors;
    },

    async rollback(created) {
      const errors = [];

      for (const o of [...created].reverse()) {
        try {
          await this.request('delete', `${ collectionPath(o.api, o.object.metadata.namespace) }/${ o.object.metadata.name }`);
        } catch (e) {
          errors.push(this.t('elemental3.save.rollbackFailed', { ...this.describe(o), error: errorText(e) }, true));
        }
      }

      return errors;
    },

    async save(btnCb) {
      this.errors = [];

      if (this.validationErrors.length) {
        this.errors = this.validationErrors;
        btnCb(false);

        return;
      }

      const denied = await this.dryRun();

      if (denied.length) {
        this.errors = denied;
        btnCb(false);

        return;
      }

      // The identity CAPHV uses on Harvester: a kubeconfig of the logged-in user for the Harvester cluster,
      // the same call Rancher's Harvester cloud credential makes
      let kubeconfig;

      try {
        const cluster = this.mgmtClusters.find((c) => c.id === this.harvesterClusterId);

        kubeconfig = await cluster.generateKubeConfig();
        if (!kubeconfig) {
          throw new Error('empty kubeconfig');
        }
      } catch (e) {
        this.errors = [this.t('elemental3.save.kubeconfig', { error: errorText(e) }, true)];
        btnCb(false);

        return;
      }

      const created = [];
      let objects = buildObjects(this.form, { kubeconfig });
      let current = objects[0];

      try {
        // The Cluster first: its UID makes the identity Secret an owned object
        const cluster = await this.request('post', collectionPath(API.cluster, this.form.namespace), current.object);

        created.push(current);
        objects = buildObjects(this.form, { kubeconfig, clusterUid: cluster?.metadata?.uid });

        for (const o of objects.slice(1)) {
          current = o;
          await this.request('post', collectionPath(o.api, o.object.metadata.namespace), o.object);
          created.push(o);
        }
      } catch (e) {
        const errors = [this.t('elemental3.save.failed', { ...this.describe(current), error: errorText(e) }, true)];
        const rollbackErrors = await this.rollback(created);

        if (created.length && !rollbackErrors.length) {
          errors.push(this.t('elemental3.save.rolledBack'));
        }
        this.errors = [...errors, ...rollbackErrors];
        btnCb(false);

        return;
      }

      btnCb(true);
      this.$router.push(this.doneRoute);
    },

    cancel() {
      this.$router.push(this.doneRoute);
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <CruResource
    v-else
    :resource="value"
    :mode="mode"
    :can-yaml="false"
    :done-route="doneRoute"
    :errors="errors"
    :validation-passed="canCreate"
    :cancel-event="true"
    component-testid="elemental3-create"
    @error="e=>errors=e"
    @finish="save"
    @cancel="cancel"
  >
    <div data-testid="elemental3-form">
      <Banner
        v-if="missingPrerequisites.length"
        color="warning"
        data-testid="elemental3-prerequisites"
      >
        <div>
          <p>{{ t('elemental3.prerequisites.title') }}</p>
          <ul class="mb-0">
            <li
              v-for="(m, i) in missingPrerequisites"
              :key="i"
            >
              {{ m }}
            </li>
          </ul>
        </div>
      </Banner>
      <Banner
        v-if="!harvesterClusterOptions.length"
        color="error"
        data-testid="elemental3-no-harvester"
        :label="t('elemental3.prerequisites.noHarvester')"
      />
      <Banner
        v-if="harvesterError"
        color="error"
        data-testid="elemental3-harvester-error"
        :label="harvesterError"
      />
      <Banner
        v-if="!operatorInstalled"
        color="info"
        data-testid="elemental3-no-operator"
        :label="t('elemental3.prerequisites.noOperator')"
      />

      <h3>{{ t('elemental3.sections.cluster') }}</h3>
      <div class="row mb-20">
        <div class="col span-4">
          <LabeledSelect
            v-model:value="harvesterClusterId"
            :mode="mode"
            :options="harvesterClusterOptions"
            :required="true"
            :label="t('elemental3.fields.harvesterCluster')"
            data-testid="elemental3-harvester-cluster"
          />
        </div>
        <div class="col span-4">
          <LabeledInput
            v-model:value="form.name"
            :mode="mode"
            :required="true"
            :label="t('elemental3.fields.name')"
            data-testid="elemental3-name"
          />
        </div>
        <div class="col span-4">
          <LabeledSelect
            v-model:value="form.namespace"
            :mode="mode"
            :options="namespaceOptions"
            :required="true"
            :label="t('elemental3.fields.namespace')"
            :tooltip="t('elemental3.fields.namespaceTooltip')"
            data-testid="elemental3-namespace"
          />
        </div>
      </div>

      <h3>{{ t('elemental3.sections.release') }}</h3>
      <div class="row mb-10">
        <div class="col span-8">
          <LabeledSelect
            v-model:value="releaseKey"
            :mode="mode"
            :options="releaseOptions"
            :loading="harvester.loading"
            :required="true"
            :label="t('elemental3.fields.release')"
            :placeholder="t('elemental3.fields.releasePlaceholder')"
            data-testid="elemental3-release"
          />
        </div>
        <div
          v-if="needsKubernetesVersion"
          class="col span-4"
        >
          <LabeledInput
            v-model:value="form.kubernetesVersion"
            :mode="mode"
            :required="true"
            :label="t('elemental3.fields.kubernetesVersion')"
            :tooltip="t('elemental3.fields.kubernetesVersionTooltip')"
            placeholder="v1.37.2+rke2r1"
            data-testid="elemental3-kubernetes-version"
          />
        </div>
      </div>
      <p class="text-muted mb-20">
        {{ t('elemental3.arch') }}
      </p>

      <h3>{{ t('elemental3.sections.harvester') }}</h3>
      <div class="row mb-20">
        <div class="col span-3">
          <LabeledSelect
            v-model:value="form.vmNamespace"
            :mode="mode"
            :options="vmNamespaceOptions"
            :loading="harvester.loading"
            :required="true"
            :label="t('elemental3.fields.vmNamespace')"
            data-testid="elemental3-vm-namespace"
          />
        </div>
        <div class="col span-3">
          <LabeledSelect
            v-model:value="form.network"
            :mode="mode"
            :options="networkOptionsList"
            :loading="harvester.loading"
            :required="true"
            :label="t('elemental3.fields.network')"
            data-testid="elemental3-network"
          />
        </div>
        <div class="col span-3">
          <LabeledSelect
            v-model:value="form.sshKeyPair"
            :mode="mode"
            :options="keyPairOptionsList"
            :loading="harvester.loading"
            :required="true"
            :label="t('elemental3.fields.sshKeyPair')"
            :tooltip="t('elemental3.fields.sshKeyPairTooltip')"
            data-testid="elemental3-ssh-key-pair"
          />
        </div>
        <div class="col span-3">
          <LabeledInput
            v-model:value="form.controlPlaneHost"
            :mode="mode"
            :required="true"
            :label="t('elemental3.fields.controlPlaneHost')"
            :tooltip="t('elemental3.fields.controlPlaneHostTooltip')"
            data-testid="elemental3-control-plane-host"
          />
        </div>
      </div>

      <div
        v-for="pool in ['controlPlane', 'workers']"
        :key="pool"
        :data-testid="`elemental3-pool-${ pool }`"
      >
        <h3>{{ t(`elemental3.sections.${ pool }`) }}</h3>
        <div class="row mb-20">
          <div class="col span-3">
            <LabeledInput
              v-model:value.number="form[pool].count"
              type="number"
              :min="pool === 'controlPlane' ? 1 : 0"
              :mode="mode"
              :required="true"
              :label="t('elemental3.fields.count')"
              :data-testid="`elemental3-${ pool }-count`"
            />
          </div>
          <div class="col span-3">
            <UnitInput
              v-model:value="form[pool].cpu"
              suffix="C"
              min="1"
              :mode="mode"
              :required="true"
              :label="t('elemental3.fields.cpu')"
              :data-testid="`elemental3-${ pool }-cpu`"
            />
          </div>
          <div class="col span-3">
            <UnitInput
              v-model:value="form[pool].memory"
              suffix="GiB"
              min="1"
              :mode="mode"
              :required="true"
              :label="t('elemental3.fields.memory')"
              :data-testid="`elemental3-${ pool }-memory`"
            />
          </div>
          <div class="col span-3">
            <UnitInput
              v-model:value="form[pool].disk"
              suffix="GiB"
              min="1"
              :mode="mode"
              :required="true"
              :label="t('elemental3.fields.disk')"
              :data-testid="`elemental3-${ pool }-disk`"
            />
          </div>
        </div>
      </div>
    </div>
  </CruResource>
</template>
